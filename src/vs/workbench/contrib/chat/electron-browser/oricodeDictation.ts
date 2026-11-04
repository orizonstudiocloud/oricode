/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ILocalTranscriptionService, LocalTranscriptionModelState } from '../../../../platform/localTranscription/common/localTranscription.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { IChatSpeechToTextService } from '../browser/speechToText/chatSpeechToTextService.js';
import { IMicCaptureService } from '../browser/voiceClient/micCaptureService.js';
import { createPcmCaptureNode, IPcmCaptureNode } from '../browser/pcmCaptureWorklet.js';

/**
 * OriCode dictation bridge — command-driven on-device speech-to-text for the
 * OriCode Agent webview (and anything else that can call commands). Reuses the
 * local transcription service (Foundry Local / Nemotron multilingual ASR) with
 * language 'auto', the shared PCM capture worklet, and real microphone levels.
 * One session at a time; sessions self-cancel when orphaned or over time caps
 * so the mic is never left hot.
 */

export const ORICODE_DICTATION_START = 'oricode.dictation.start';
export const ORICODE_DICTATION_POLL = 'oricode.dictation.poll';
export const ORICODE_DICTATION_STOP = 'oricode.dictation.stop';
export const ORICODE_DICTATION_CANCEL = 'oricode.dictation.cancel';

export type OriCodeDictationState = 'preparing' | 'recording' | 'processing' | 'done' | 'error';

export interface IOriCodeDictationSnapshot {
	readonly state: OriCodeDictationState;
	readonly text: string;
	readonly finalizedText: string;
	readonly level: number;
	readonly progress?: number;
	readonly error?: string;
}

const STARTUP_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_TIMEOUT_MS = 20 * 60 * 1000;
const ORPHAN_POLL_TIMEOUT_MS = 30 * 1000;
const MAX_PENDING_SAMPLES = 2 * 16000; // <2s of 16 kHz mono
const CHUNK_SAMPLES = 512;
const TICK_MS = 1000;

interface IDictationSession {
	readonly id: string;
	readonly generation: number;
	readonly createdAt: number;
	readonly disposables: DisposableStore;
	state: OriCodeDictationState;
	text: string;
	finalizedText: string;
	progress: number | undefined;
	error: string | undefined;
	lastPoll: number;
	stopping: boolean;
	stream?: MediaStream;
	context?: AudioContext;
	analyser?: AnalyserNode;
	source?: MediaStreamAudioSourceNode;
	pcm?: IPcmCaptureNode;
	pendingSamples: number;
	pendingChain: Promise<void>;
	watchdog?: ReturnType<typeof setInterval>;
}

let active: IDictationSession | undefined;
let lastFinished: { id: string; snapshot: IOriCodeDictationSnapshot } | undefined;
let generationCounter = 0;

function encodeRawPcm16Buffer(samples: Float32Array): VSBuffer {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
	}
	return VSBuffer.wrap(bytes);
}

function toMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function snapshotOf(session: IDictationSession): IOriCodeDictationSnapshot {
	return {
		state: session.state,
		text: session.text,
		finalizedText: session.finalizedText,
		level: levelOf(session),
		progress: session.state === 'preparing' ? session.progress : undefined,
		error: session.error,
	};
}

const levelScratch = new Float32Array(2048);
function levelOf(session: IDictationSession): number {
	const analyser = session.analyser;
	if (!analyser || session.state !== 'recording') {
		return 0;
	}
	analyser.getFloatTimeDomainData(levelScratch.subarray(0, analyser.fftSize));
	let sum = 0;
	for (let i = 0; i < analyser.fftSize; i++) {
		sum += levelScratch[i] * levelScratch[i];
	}
	return Math.min(1, Math.sqrt(sum / analyser.fftSize) * 3);
}

function teardownAudio(session: IDictationSession): void {
	try { session.source?.disconnect(); } catch { /* already disconnected */ }
	try { session.pcm?.node.disconnect(); } catch { /* already disconnected */ }
	try { session.analyser?.disconnect(); } catch { /* already disconnected */ }
	if (session.pcm) {
		session.pcm.node.port.onmessage = null;
	}
	for (const track of session.stream?.getTracks() ?? []) {
		track.stop();
	}
	session.stream = undefined;
	session.source = undefined;
	session.analyser = undefined;
	session.pcm = undefined;
	if (session.context && session.context.state !== 'closed') {
		void session.context.close().catch(() => { });
	}
	session.context = undefined;
}

function finish(session: IDictationSession, state: 'done' | 'error', error?: string): void {
	if (session.watchdog !== undefined) {
		clearInterval(session.watchdog);
		session.watchdog = undefined;
	}
	session.state = state;
	session.error = error;
	if (state === 'error' || error) {
		teardownAudio(session);
		session.disposables.dispose();
	}
	if (active === session) {
		active = undefined;
	}
	lastFinished = { id: session.id, snapshot: snapshotOf(session) };
}

function findSession(accessorSessionId: unknown): IDictationSession {
	if (typeof accessorSessionId === 'string' && active && accessorSessionId === active.id) {
		return active;
	}
	throw new Error('Sesión de dictado desconocida o ya cerrada');
}

CommandsRegistry.registerCommand(ORICODE_DICTATION_START, async (accessor: ServicesAccessor) => {
	const local = accessor.get(ILocalTranscriptionService);
	const env = accessor.get(INativeWorkbenchEnvironmentService);
	const stt = accessor.get(IChatSpeechToTextService);
	const mic = accessor.get(IMicCaptureService);
	const log = accessor.get(ILogService);

	if (active) {
		throw new Error('Ya hay una sesión de dictado activa');
	}
	if (!local.isSupported) {
		throw new Error('El dictado en el dispositivo no está disponible en esta plataforma');
	}
	if (stt.isBusy || mic.isCapturing) {
		throw new Error('Otro dictado o sesión de voz está usando el micrófono');
	}

	const session: IDictationSession = {
		id: generateUuid(),
		generation: ++generationCounter,
		createdAt: Date.now(),
		disposables: new DisposableStore(),
		state: 'preparing',
		text: '',
		finalizedText: '',
		progress: 0,
		error: undefined,
		lastPoll: Date.now(),
		stopping: false,
		pendingSamples: 0,
		pendingChain: Promise.resolve(),
	};
	active = session;
	lastFinished = undefined;

	session.disposables.add(local.onDidTranscribe(result => {
		if (active !== session) {
			return;
		}
		session.text = result.text;
		session.finalizedText = result.finalizedText ?? session.finalizedText;
	}));
	session.disposables.add(local.onDidChangeModelStatus(status => {
		if (active !== session) {
			return;
		}
		if (typeof status.progress === 'number') {
			session.progress = status.progress;
		}
	}));

	// Startup/session/orphan watchdog — never leave the mic hot.
	session.watchdog = setInterval(() => {
		if (active !== session) {
			return;
		}
		const now = Date.now();
		if (session.state === 'preparing' && now - session.createdAt > STARTUP_TIMEOUT_MS) {
			void local.cancel().catch(() => { });
			finish(session, 'error', 'La preparación del dictado superó el tiempo de espera');
		} else if (now - session.createdAt > SESSION_TIMEOUT_MS) {
			void stopSession(session, local);
		} else if (now - session.lastPoll > ORPHAN_POLL_TIMEOUT_MS) {
			void local.cancel().catch(() => { });
			teardownAudio(session);
			session.disposables.dispose();
			finish(session, 'error', 'Sesión de dictado abandonada');
		}
	}, TICK_MS);

	void runSession(session, local, env, log);
	return { sessionId: session.id };
});

CommandsRegistry.registerCommand(ORICODE_DICTATION_POLL, (accessor: ServicesAccessor, sessionId?: string) => {
	if (!active) {
		if (lastFinished && sessionId === lastFinished.id) {
			return lastFinished.snapshot;
		}
		throw new Error('Sesión de dictado desconocida o ya cerrada');
	}
	const session = findSession(sessionId);
	session.lastPoll = Date.now();
	return snapshotOf(session);
});

CommandsRegistry.registerCommand(ORICODE_DICTATION_STOP, async (accessor: ServicesAccessor, sessionId?: string) => {
	const local = accessor.get(ILocalTranscriptionService);
	const session = findSession(sessionId);
	session.lastPoll = Date.now();
	await stopSession(session, local);
	return lastFinished?.snapshot ?? snapshotOf(session);
});

CommandsRegistry.registerCommand(ORICODE_DICTATION_CANCEL, async (accessor: ServicesAccessor, sessionId?: string) => {
	const local = accessor.get(ILocalTranscriptionService);
	const session = findSession(sessionId);
	generationCounter++;
	await local.cancel().catch(() => { });
	session.text = '';
	session.finalizedText = '';
	teardownAudio(session);
	session.disposables.dispose();
	finish(session, 'done');
	return lastFinished?.snapshot;
});

async function runSession(session: IDictationSession, local: ILocalTranscriptionService, env: INativeWorkbenchEnvironmentService, log: ILogService): Promise<void> {
	const generation = session.generation;
	const alive = () => active === session && session.generation === generation;
	try {
		const cacheDir = joinPath(env.cacheHome, 'chatDictationModels').fsPath;
		const ready = new Promise<void>((resolve, reject) => {
			session.disposables.add(local.onDidChangeModelStatus(status => {
				if (status.state === LocalTranscriptionModelState.Ready) {
					resolve();
				} else if (status.state === LocalTranscriptionModelState.Error) {
					reject(new Error(status.error ?? 'No se pudo cargar el modelo de dictado'));
				}
			}));
			void local.getModelStatus().then(status => {
				if (status.state === LocalTranscriptionModelState.Ready) {
					resolve();
				} else if (status.state === LocalTranscriptionModelState.Error) {
					reject(new Error(status.error ?? 'No se pudo cargar el modelo de dictado'));
				}
			}, () => { /* status surfaces via event */ });
		});
		await local.start({ cacheDir, language: 'auto' });
		if (!alive()) {
			return;
		}
		await ready;
		if (!alive()) {
			return;
		}

		// Model ready — now open the microphone (16 kHz mono PCM via worklet).
		const stream = await mainWindow.navigator.mediaDevices.getUserMedia({ audio: true, video: false });
		if (!alive()) {
			stream.getTracks().forEach(t => t.stop());
			return;
		}
		session.stream = stream;
		const context = new AudioContext({ sampleRate: 16000 });
		session.context = context;
		const source = context.createMediaStreamSource(stream);
		session.source = source;
		const analyser = context.createAnalyser();
		analyser.fftSize = Math.min(2048, levelScratch.length);
		session.analyser = analyser;

		session.pcm = await createPcmCaptureNode(mainWindow, context, CHUNK_SAMPLES, samples => {
			if (active !== session) {
				return;
			}
			session.pendingSamples += samples.length;
			if (session.pendingSamples > MAX_PENDING_SAMPLES) {
				void local.cancel().catch(() => { });
				finish(session, 'error', 'El búfer de audio se desbordó');
				return;
			}
			session.pendingChain = session.pendingChain
				.then(() => local.pushAudio(encodeRawPcm16Buffer(samples)))
				.catch(err => {
					if (active === session) {
						log.error('[oricode-dictation] pushAudio failed', err);
					}
				})
				.finally(() => {
					session.pendingSamples = Math.max(0, session.pendingSamples - samples.length);
				});
		});

		source.connect(analyser);
		source.connect(session.pcm.node);
		session.pcm.node.connect(context.destination); // worklet emits silence

		if (!alive()) {
			teardownAudio(session);
			return;
		}
		session.state = 'recording';
	} catch (err) {
		if (active === session) {
			finish(session, 'error', toMessage(err));
		}
	}
}

async function stopSession(session: IDictationSession, local: ILocalTranscriptionService): Promise<void> {
	if (active !== session) {
		return; // already finished — stop is idempotent
	}
	if (session.stopping) {
		return;
	}
	session.stopping = true;
	session.state = 'processing';
	try {
		if (session.pcm) {
			await session.pcm.flush().catch(() => { });
		}
		await session.pendingChain.catch(() => { });
		const finalText = await local.stop().catch(err => {
			throw err;
		});
		if (typeof finalText === 'string' && finalText) {
			session.text = finalText;
			session.finalizedText = finalText;
		}
		teardownAudio(session); // mic released on done too
		finish(session, 'done');
	} catch (err) {
		finish(session, 'error', toMessage(err));
	}
}
