/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { requestJson, streamChat, ChatMessage } from './network';
import { ACTION_PROMPT, executeAction, isSensitivePath, parseAction, workspaceTarget } from './agent';
import { BrowserSignIn } from './browserSignIn';

type ConnectionMode = 'local' | 'cloud';
type AgentMode = 'code' | 'smart' | 'ask' | 'plan' | 'bypass';
interface Model { id: string; name?: string; free?: boolean; local?: boolean; desc?: string; ctx?: number; inUsd?: number; outUsd?: number; mods?: string[] }
interface HistoryItem { r: 'user' | 'bot' | 'assistant'; x: string; t?: string }
interface OllamaTag { name: string; remote_host?: string; size?: number }
interface CloudModel { id: string; name?: string; context_length?: number; description?: string; oricode_free?: boolean; architecture?: { output_modalities?: string[]; input_modalities?: string[] }; pricing?: { prompt?: string; completion?: string } }
interface PanelMessage { type: string; text: string; file: string; code: string; model: string; mode: string; vote: string }

function cloudUrl() {
	const url = new URL(vscode.workspace.getConfiguration('oricode').get('cloudUrl', 'https://oricode.orizonstudio.cloud'));
	if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error(vscode.l10n.t('Usa la dirección HTTPS del servidor OriCode, sin rutas ni credenciales.'));
	}
	return url.origin;
}
function ollamaUrl() { return vscode.workspace.getConfiguration('oricode').get('ollamaUrl', 'http://127.0.0.1:11434').replace(/\/$/, ''); }
const SYSTEM_PROMPT = 'Eres OriCode Agent, un agente de desarrollo dentro del IDE. Responde en el idioma del usuario. Usa las herramientas para inspeccionar, corregir y verificar el proyecto. Conserva los cambios existentes. Explica brevemente tu siguiente acción.';
const MODE_PROMPTS: Record<AgentMode, string> = {
	code: SYSTEM_PROMPT,
	smart: SYSTEM_PROMPT + ' El usuario permite editar archivos del proyecto automáticamente; los comandos requieren confirmación.',
	ask: 'Eres OriCode. Responde preguntas sobre el proyecto. Solo puedes leer y consultar diagnósticos; no escribas archivos ni ejecutes comandos.',
	plan: 'Eres OriCode en modo Plan. Inspecciona el proyecto y presenta un plan numerado con archivos, cambios y validación. Solo lectura; espera a que el usuario cambie a Code para implementarlo.',
	bypass: SYSTEM_PROMPT + ' El usuario ha activado la ejecución sin confirmación para esta tarea.',
};
async function ollamaModels(): Promise<Model[]> {
	const response = await requestJson<{ models?: OllamaTag[] }>(ollamaUrl() + '/api/tags');
	return (response.models ?? []).map(m => ({ id: m.name, name: m.name, free: !m.remote_host && !m.name.endsWith(':cloud') && (m.size ?? 0) > 1000000, local: !m.remote_host && !m.name.endsWith(':cloud'), desc: m.remote_host || m.name.endsWith(':cloud') ? 'Ollama Cloud · requiere cuenta y cuota de Ollama' : 'Ollama · ejecutado en tu equipo' }));
}
async function cloudModels(key: string, base?: string): Promise<Model[]> {
	const response = await requestJson<{ data?: CloudModel[] }>((base ?? cloudUrl()) + '/v1/models', undefined, key);
	return (response.data ?? []).filter(m => (!m.architecture?.output_modalities || m.architecture.output_modalities.includes('text')) && !/(?:embed|rerank|:batch|\/extract$)/i.test(m.id)).map(m => {
		const input = m.pricing?.prompt === undefined ? undefined : Number(m.pricing.prompt) * 1e6;
		const output = m.pricing?.completion === undefined ? undefined : Number(m.pricing.completion) * 1e6;
		return { id: m.id, name: m.name, ctx: m.context_length, desc: m.description?.split('\n')[0].slice(0, 180), free: !!m.oricode_free || (input === 0 && output === 0), inUsd: Number.isFinite(input) ? input : undefined, outUsd: Number.isFinite(output) ? output : undefined, mods: m.architecture?.input_modalities };
	});
}
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.build', '__pycache__', '.venv', 'venv', 'target', '.next', 'build', '.pytest_cache', '.vscode']);
const FREE_PLAN_MODEL = 'nvidia/nemotron-3.5-super-vl:free';
const FLAKY_MODELS = /argon|lyria|draft/i;
function pickAdaptive(available: Model[], text: string, preferQuality = false): string | undefined {
	const free = available.filter(m => m.free);
	const base = preferQuality ? available : (free.length ? free : available);
	const stable = base.filter(m => !FLAKY_MODELS.test(m.id));
	const pool = stable.length ? stable : base;
	if (/imag|foto|dibuj|logo|pictur|audio|v[ií]deo/i.test(text)) {
		const media = pool.find(m => /omni|gemma|gemini/i.test(m.id) && m.mods?.some(x => /image|audio|video/i.test(x)))
			|| pool.find(m => m.mods?.some(x => /image|audio|video/i.test(x)) || /flux|sd|diffus|image|imagen|dall/i.test(m.id));
		if (media) { return media.id; }
	}
	const codeish = /c[oó]digo|archivo|funci[oó]n|clase|bug|error|test|script|programa|refactor|compila|depura|debug|api|json|html|css|typescript|javascript|python|sql|\.[a-z]{1,4}\b/i.test(text);
	const pref = preferQuality
		? (codeish ? /deepseek|qwen.*coder|coder|devstral|codestral|sonnet|opus|claude|gpt|gemini/i : /sonnet|claude|gpt|gemini|deepseek|qwen|omni/i)
		: (codeish ? /qwen|coder|code|deepseek|devstral|codestral|gemma|omni|mimo|nemotron/i : /omni|nemotron|gemma|inkling|flint|llama|mistral|gemini|gpt|claude|qwen|deepseek/i);
	const matches = pool.filter(m => pref.test(m.id));
	const candidates = matches.length ? matches : pool;
	adaptivePickIdx++;
	return candidates[adaptivePickIdx % candidates.length]?.id;
}
let adaptivePickIdx = -1;
async function projectContext(maxChars = 15000) {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		return '';
	}
	const root = folders[0].uri;
	const name = root.path.split('/').pop() ?? 'proyecto';
	const tree: string[] = [];
	const walk = async (dir: vscode.Uri, prefix: string, depth: number): Promise<void> => {
		if (depth > 3 || tree.length > 120) {
			return;
		}
		let entries;
		try {
			entries = await vscode.workspace.fs.readDirectory(dir);
		}
		catch {
			return;
		}
		entries.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
		for (const [n, t] of entries) {
			if (tree.length > 120) {
				break;
			}
			if (t === vscode.FileType.Directory && SKIP_DIRS.has(n)) {
				continue;
			}
			if (n.startsWith('.')) {
				continue;
			}
			tree.push(prefix + (t === vscode.FileType.Directory ? n + '/' : n));
			if (t === vscode.FileType.Directory) {
				await walk(vscode.Uri.joinPath(dir, n), prefix + '  ', depth + 1);
			}
		}
	};
	await walk(root, '', 0);
	const KEY = /^(app|main|server|index|run|manage|cli)\.(py|js|ts|tsx|jsx|go|rs|java|cs|php)$/i;
	const files: string[] = [];
	let budget = maxChars;
	const read = async (u: vscode.Uri): Promise<void> => {
		if (budget <= 0 || isSensitivePath(vscode.workspace.asRelativePath(u))) {
			return;
		}
		if (vscode.workspace.getWorkspaceFolder(u)?.uri.toString() !== root.toString()) {
			return;
		}
		try {
			const safe = await workspaceTarget(vscode.workspace.asRelativePath(u));
			if ((await vscode.workspace.fs.stat(safe)).size > 1000000) {
				return;
			}
			const buf = await vscode.workspace.fs.readFile(safe);
			let txt = Buffer.from(buf).toString('utf8');
			txt = txt.slice(0, Math.min(txt.length, budget, 4000));
			files.push(`--- ${vscode.workspace.asRelativePath(u)} ---\n${txt}`);
			budget -= txt.length;
		}
		catch { /* skip */ }
	};
	const find = async (dir: vscode.Uri, depth: number): Promise<void> => {
		if (files.length >= 4 || budget <= 0 || depth > 3) {
			return;
		}
		let entries;
		try {
			entries = await vscode.workspace.fs.readDirectory(dir);
		}
		catch {
			return;
		}
		for (const [n, t] of entries) {
			if (files.length >= 4 || budget <= 0) {
				return;
			}
			if (n.startsWith('.') || (t === vscode.FileType.Directory && SKIP_DIRS.has(n))) {
				continue;
			}
			if (t === vscode.FileType.File && KEY.test(n)) {
				await read(vscode.Uri.joinPath(dir, n));
			}
			if (t === vscode.FileType.Directory) {
				await find(vscode.Uri.joinPath(dir, n), depth + 1);
			}
		}
	};
	for (const name of ['AGENTS.md', 'package.json', 'pyproject.toml']) {
		await read(vscode.Uri.joinPath(root, name));
	}
	await find(root, 0);
	const active = vscode.window.activeTextEditor?.document.uri;
	if (active) {
		await read(active);
	}
	return `[Proyecto: ${name}]\n${tree.join('\n')}\n\n[Archivos principales]\n${files.join('\n\n')}`;
}
class AgentViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private readonly _secrets: vscode.SecretStorage;
	private readonly _state: vscode.Memento;
	private readonly _extensionUri: vscode.Uri;
	_model = '';
	private _mode: ConnectionMode;
	private _freePlan = false;
	private _agentMode: AgentMode;
	private _history: HistoryItem[];
	private _sessionId: string;
	private _models: Model[] = [];
	private _controller?: AbortController;
	private _queue: { text: string; model: string }[] = [];
	private _lastUser = '';
	private _lastModel = '';
	private _disposables: vscode.Disposable[] = [];
	private _view?: vscode.WebviewView;
	constructor(_secrets: vscode.SecretStorage, _state: vscode.Memento, _extensionUri: vscode.Uri, private readonly authentication: OriCodeAuthProvider) {
		this._secrets = _secrets;
		this._state = _state;
		this._extensionUri = _extensionUri;
		this._mode = _state.get('oricode.mode', 'cloud');
		this._agentMode = _state.get('oricode.agentMode', 'code');
		this._history = _state.get('oricode.history', []);
		this._sessionId = _state.get('oricode.sessionId', '') || 'ide-' + randomBytes(12).toString('hex');
		void _state.update('oricode.sessionId', this._sessionId);
	}
	_post(message: object): void { void this._view?.webview.postMessage(message); }
	async onSignedIn(): Promise<void> {
		this._mode = 'cloud';
		await this._state.update('oricode.mode', 'cloud');
  await vscode.commands.executeCommand('setContext', 'oricode.authenticated', true);
		const user = await this._secrets.get('oricode.username');
		this._post({ type: 'gate', signed: true, user });
		this._post({ type: 'notice', text: vscode.l10n.t('Sesión iniciada en OriCode Cloud.') });
		await this._loadModels();
	}
	async signIn(): Promise<void> {
		await this.authentication.createSession();
	}
	async restoreSession(): Promise<void> {
  const signed = await this._signed();
  await vscode.commands.executeCommand('setContext', 'oricode.authenticated', signed);
  if (signed) {
			await this.onSignedIn();
		}
	}
	async signOut(): Promise<void> {
		this._controller?.abort();
		await this.authentication.removeSession();
		this._mode = 'cloud';
		await this._state.update('oricode.mode', 'cloud');
  await vscode.commands.executeCommand('setContext', 'oricode.authenticated', false);
		this._post({ type: 'gate', signed: false });
		await this._loadModels();
	}
	async _key() { return (await this.authentication.getSessions())[0]?.accessToken ?? ''; }
 async _signed() { return !!(await this._key()); }
	async _syncPush() {
		if (!vscode.workspace.getConfiguration('oricode').get('syncHistory', false)) {
			return;
		}
		try {
			const key = await this._key();
			if (key && this._history.length) {
				await requestJson(cloudUrl() + '/api/sessions', { id: this._sessionId, title: (this._history.find(m => m.r === 'user')?.x || 'Chat IDE').slice(0, 60), msgs: this._history }, key);
			}
		}
		catch (error) {
			this._post({ type: 'notice', text: vscode.l10n.t('No se pudo sincronizar el historial: {0}', String(error)) });
		}
	}
	async _loadModels() {
		const mode = this._mode;
		this._post({ type: 'loadingModels', mode });
		try {
  const key = await this._key();
			if (mode === 'cloud' && !key) {
				throw new Error(vscode.l10n.t('Inicia sesión con tu cuenta OriCode para usar Cloud. También puedes elegir Local.'));
			}
  const models = mode === 'cloud' ? await cloudModels(key) : await ollamaModels();
			if (mode !== this._mode) {
				return;
			}
			if (!models.length) {
				throw new Error(vscode.l10n.t('No hay modelos disponibles. Revisa el proveedor o instala un modelo en Ollama.'));
			}
			if (mode === 'cloud') {
				models.unshift({ id: 'adaptive', name: 'Adaptive', free: false, desc: vscode.l10n.t('Elige el mejor modelo disponible para la tarea, priorizando los gratuitos; muestra el elegido antes de usarlo.') });
			}
			this._models = models;
			const saved = this._state.get('oricode.model.' + mode, '');
			const preferred = mode === 'local' ? models.find(m => m.id === 'qwen3:8b') || models.find(m => m.local) : undefined;
			const freePlan = mode === 'cloud' && models.length > 0 && models.every(m => m.free || m.id === 'adaptive');
			this._freePlan = freePlan;
			if (freePlan) {
				this._model = models.find(m => m.id === FREE_PLAN_MODEL)?.id || models.find(m => m.free)?.id || models[0].id;
			} else {
				this._model = models.find(m => m.id === saved)?.id || preferred?.id || models[0].id;
			}
			this._post({ type: 'models', models, current: this._model, mode, signedIn: !!key, freePlan });
		}
		catch (error) {
			if (mode !== this._mode) {
				return;
			}
			this._models = [];
			this._model = '';
			this._post({ type: 'models', models: [], current: '', mode, error: error instanceof Error ? error.message : String(error) });
		}
	}
	resolveWebviewView(view: vscode.WebviewView): void {
		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
		this._view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')] };
		view.webview.html = this._html(view.webview);
		this._disposables.push(view.onDidDispose(() => { this._controller?.abort(); void this._speechCancel(); this._view = undefined; }));
		this._disposables.push(view.onDidChangeVisibility(() => { if (!view.visible) { void this._speechCancel(); } }));
		this._disposables.push(view.webview.onDidReceiveMessage(async (msg: PanelMessage) => {
			try {
				if (msg.type === 'ready') {
					this._post({ type: 'history', items: this._history });
					this._post({ type: 'agentMode', mode: this._agentMode });
					this._post({ type: 'gate', signed: await this._signed(), user: await this._secrets.get('oricode.username') });
					await this._loadModels();
				}
				else if (msg.type === 'cancel') {
					this._queue = [];
					this._controller?.abort();
				}
				else if (msg.type === 'copy' && typeof msg.text === 'string') {
					await vscode.env.clipboard.writeText(msg.text);
				}
				else if (msg.type === 'retry') {
					if (!this._controller && this._lastUser) {
						await this._run(this._lastUser, this._lastModel);
					}
				}
				else if (msg.type === 'feedback') {
					const items = this._state.get<unknown[]>('oricode.feedback', []).slice(-49);
					items.push({ vote: msg.vote, text: String(msg.text || '').slice(0, 500), when: Date.now() });
					await this._state.update('oricode.feedback', items);
				}
				else if (msg.type === 'attach') {
					const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: vscode.l10n.t('Adjuntar') });
					if (pick?.[0]) {
						if (isSensitivePath(pick[0].fsPath)) {
							throw new Error(vscode.l10n.t('No se pueden adjuntar archivos de secretos.'));
						}
						const stat = await vscode.workspace.fs.stat(pick[0]);
						if (stat.size > 1000000) {
							throw new Error(vscode.l10n.t('Adjunta un archivo de texto de menos de 1 MB.'));
						}
						const bytes = await vscode.workspace.fs.readFile(pick[0]);
						if (bytes.includes(0)) {
							throw new Error(vscode.l10n.t('Solo se admiten archivos de texto.'));
						}
						this._post({ type: 'attached', name: vscode.workspace.asRelativePath(pick[0]), content: Buffer.from(bytes).toString('utf8').slice(0, 16000) });
					}
				}
				else if (msg.type === 'speechStart') {
					void this._speechStart();
				}
				else if (msg.type === 'speechStop') {
					await this._speechStop();
				}
				else if (msg.type === 'speechCancel') {
					await this._speechCancel();
				}
				else if (msg.type === 'apply') {
					if (this._controller) {
						throw new Error(vscode.l10n.t('Espera a que termine la tarea.'));
					}
					const target = await workspaceTarget(msg.file);
					let exists = false;
					try {
						await vscode.workspace.fs.stat(target);
						exists = true;
					}
					catch { /* new file */ }
					if (exists) {
						const uri = proposedUri(msg.file);
						proposedContent.set(uri.toString(), String(msg.code || ''));
						await vscode.commands.executeCommand('vscode.diff', target, uri, vscode.l10n.t('{0}: actual y propuesto', msg.file));
					}
					const result = await executeAction({ tool: 'write_file', path: msg.file, content: msg.code }, 'code', new AbortController().signal);
					this._post({ type: 'notice', text: result });
				}
				else if (msg.type === 'send') {
					if (!(await this._signed())) {
						this._post({ type: 'gate', signed: false });
						this._post({ type: 'notice', text: vscode.l10n.t('Inicia sesión con tu cuenta OriCode para continuar.') });
						return;
					}
					if (this._controller) {
						this._queue.push({ text: msg.text, model: msg.model });
						this._post({ type: 'notice', text: vscode.l10n.t('Mensaje en cola: se enviará al terminar la tarea actual.') });
						return;
					}
					await this._run(msg.text, msg.model);
				}
				else if (msg.type === 'signOut') {
					const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('¿Cerrar la sesión de OriCode en este equipo?'), { modal: true }, vscode.l10n.t('Cerrar sesión'));
					if (confirm) {
						await this.signOut();
						this._post({ type: 'notice', text: vscode.l10n.t('Sesión cerrada.') });
					}
				}
				else if (msg.type === 'setAgentMode' && Object.hasOwn(MODE_PROMPTS, msg.mode)) {
					this._agentMode = msg.mode as AgentMode;
					await this._state.update('oricode.agentMode', this._agentMode);
				}
				else if (!this._controller) {
					if (msg.type === 'setModel') {
						if (this._models.some(m => m.id === msg.model)) {
							this._model = msg.model;
							await this._state.update('oricode.model.' + this._mode, this._model);
						}
					}
					else if (msg.type === 'setMode' && (msg.mode === 'local' || msg.mode === 'cloud')) {
						this._mode = msg.mode;
						await this._state.update('oricode.mode', this._mode);
						await this._loadModels();
					}
					else if (msg.type === 'refreshModels') {
						await this._loadModels();
					}
					else if (msg.type === 'clearHistory') {
						this._history = [];
						this._sessionId = 'ide-' + randomBytes(12).toString('hex');
						await this._state.update('oricode.history', []);
						await this._state.update('oricode.sessionId', this._sessionId);
						this._post({ type: 'history', items: [] });
					}
					else if (msg.type === 'signIn') {
						await this.signIn();
					}
				}
			}
			catch (error) {
				this._post({ type: 'notice', text: error instanceof Error ? error.message : String(error) });
			}
		}));
	}
	async _run(text: string, model: string): Promise<void> {
		if (this._controller) {
			return;
		}
		const controller = new AbortController();
		this._controller = controller;
		this._post({ type: 'busy', value: true });
		let final = '';
		try {
			if (!vscode.workspace.isTrusted && this._agentMode !== 'ask' && this._agentMode !== 'plan') {
				this._post({ type: 'notice', text: vscode.l10n.t('Esta carpeta está en modo restringido: confía en ella (botón Trust de arriba) para que pueda escribir archivos y ejecutar comandos.') });
			}
			if (typeof text !== 'string' || !text.trim() || text.length > 64000) {
				throw new Error(vscode.l10n.t('El mensaje está vacío o supera 64.000 caracteres.'));
			}
			if (!this._models.length) {
				throw new Error(vscode.l10n.t('No hay modelos. Usa Actualizar modelos o revisa la conexión.'));
			}
			if (this._models.some(m => m.id === model)) {
				this._model = model;
			}
			this._lastUser = text;
			this._lastModel = model;
 const key = this._mode === 'cloud' ? await this._key() : '';
			if (this._mode === 'cloud' && !key) {
				throw new Error(vscode.l10n.t('Inicia sesión para usar Cloud.'));
			}
			let selected = this._model;
			if (selected === 'adaptive') {
				selected = pickAdaptive(this._models.filter(m => m.id !== 'adaptive'), text, !this._freePlan) ?? '';
			}
			if (!selected) {
				throw new Error(vscode.l10n.t('Selecciona un modelo disponible.'));
			}
			this._post({ type: 'status', text: vscode.l10n.t('Leyendo el proyecto…') });
			const context = await projectContext();
			const messages: ChatMessage[] = [{ role: 'system', content: (MODE_PROMPTS[this._agentMode] || SYSTEM_PROMPT) + ACTION_PROMPT + '\n\n' + context }];
			let budget = 24000;
			const history: ChatMessage[] = [];
			for (const item of [...this._history].reverse()) {
				if (budget <= 0) {
					break;
				}
				if (!['user', 'bot', 'assistant'].includes(item.r)) {
					continue;
				}
				const content = item.x.slice(-Math.min(budget, 12000));
				budget -= content.length;
				history.unshift({ role: item.r === 'user' ? 'user' : 'assistant', content });
			}
			messages.push(...history, { role: 'user', content: text });
			this._history.push({ r: 'user', x: text });
			await this._state.update('oricode.history', this._history.slice(-80));
			const maxSteps = vscode.workspace.getConfiguration('oricode').get('maxSteps', 0);
			const limit = maxSteps > 0 ? maxSteps : Number.POSITIVE_INFINITY;
			const timeoutMs = Math.max(30000, Math.min(600000, vscode.workspace.getConfiguration('oricode').get('responseTimeout', 180000)));
			const triedFree = new Set<string>();
			const actionContext = { deniedExtensions: new Set<string>() };
			let lastSignature = '';
			let repeatCount = 0;
			let lastOutput = '';
			let formatFails = 0;
			for (let step = 1; step <= limit; step++) {
				controller.signal.throwIfAborted();
				while (messages.length > 3 && messages.reduce((sum, message) => sum + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length), 0) > 56000) {
					messages.splice(1, 1);
				}
				this._post({ type: 'status', text: limit === Number.POSITIVE_INFINITY ? vscode.l10n.t('Paso {0} · {1}', step, selected) : vscode.l10n.t('Paso {0}/{1} · {2}', step, limit, selected) });
				let result;
				try {
 result = await streamChat((this._mode === 'cloud' ? cloudUrl() + '/v1/chat/completions' : ollamaUrl() + '/api/chat'), selected, messages, {
						local: this._mode === 'local', key, signal: controller.signal, timeoutMs,
						onDelta: delta => this._post({ type: 'delta', text: delta }),
						onThinking: thinking => this._post({ type: 'thinking', text: thinking }),
					});
				}
				catch (error) {
					if (controller.signal.aborted) {
						throw error;
					}
					if (/413|too.?large|payload|exceed/i.test(String(error))) {
						for (const msg of messages) {
							if (Array.isArray(msg.content)) {
								msg.content = msg.content.map(part => (part as { type?: string }).type === 'image_url' || (part as { type?: string }).type === 'file'
									? { type: 'text', text: '[archivo multimedia omitido: supera el límite del proveedor]' }
									: part);
							}
						}
						messages.push({ role: 'user', content: 'El archivo multimedia supera el límite del proveedor. No lo vuelvas a pedir con read_image — usa la miniatura (thumb_*) o una versión más pequeña.' });
						step--;
						continue;
					}
					const free = this._models.find(m => m.free && m.id !== 'adaptive' && !triedFree.has(m.id));
					const next = free || this._models.find(m => m.id !== 'adaptive' && !triedFree.has(m.id));
					if (this._mode === 'cloud' && next && /402|403|404|413|429|503|quota|credit|cuota|crédito|rate.?limit|resourceexhausted|harness|unavailable|not.available|agotado|dejó de responder|timeout|ECONNRESET|socket|too.?large|payload|exceed/i.test(String(error))) {
						triedFree.add(selected);
						selected = next.id;
						this._post({ type: 'tool', text: next.free ? vscode.l10n.t('Proveedor sin cuota/disponibilidad. Reintentando con {0}.', selected) : vscode.l10n.t('Modelos gratuitos agotados. Reintentando con {0} (de pago).', selected) });
						step--;
						continue;
					}
					if (this._mode === 'cloud' && /402|429|quota|credit|cuota|crédito|resourceexhausted|rate.?limit/i.test(String(error))) {
						throw new Error(vscode.l10n.t('Los modelos gratuitos están saturados a esta hora (su cuota se reparte entre todos los usuarios y se renueva cada 24 h). Prueba otro modelo del selector, vuelve a intentarlo en un rato o mejora tu plan en oricode.orizonstudio.cloud/pricing. ({0})', error instanceof Error ? error.message : String(error)));
					}
					throw error;
				}
				if (result.credits !== undefined) {
					this._post({ type: 'credits', value: result.credits });
				}
				let action;
				try {
					action = parseAction(result.text) ?? parseAction(result.thinking ?? '');
				}
				catch (error) {
					formatFails++;
					const untried = this._models.find(m => m.free && !triedFree.has(m.id)) ?? this._models.find(m => !triedFree.has(m.id));
					if (formatFails >= 3 && untried && untried.id !== selected) {
						triedFree.add(selected);
						selected = untried.id;
						formatFails = 0;
						this._post({ type: 'thinking', text: vscode.l10n.t('El modelo no emite acciones válidas. Reintentando con {0}…', untried.name || untried.id) });
						step--;
						continue;
					}
					messages.push({ role: 'assistant', content: result.text }, { role: 'user', content: 'Error de formato: ' + String(error) });
					continue;
				}
				formatFails = 0;
				if (!action) {
					final = result.text;
					this._post({ type: 'reply', text: final, thinking: result.thinking });
					break;
				}
				messages.push({ role: 'assistant', content: result.text });
				this._post({ type: 'tool', text: action.tool + ': ' + (action.path || action.command || '') });
				const signature = action.tool + '|' + String(action.path || action.filename || '') + '|' + String(action.command || '') + '|' + String(action.prompt || '') + '|' + String(action.old_string || action.content || '').slice(0, 120);
				const isRepeat = signature === lastSignature;
				if (isRepeat) { repeatCount++; } else { repeatCount = 0; lastSignature = signature; }
				if (repeatCount >= 2) {
					const untried = this._models.find(m => m.free && !triedFree.has(m.id)) ?? this._models.find(m => !triedFree.has(m.id));
					if (untried && untried.id !== selected) {
						triedFree.add(selected);
						selected = untried.id;
						repeatCount = 0;
						lastSignature = '';
						this._post({ type: 'thinking', text: vscode.l10n.t('El modelo repitió la misma acción. Reintentando con {0}…', untried.name || untried.id) });
						step--;
						continue;
					}
					final = vscode.l10n.t('El modelo repitió la misma acción sin avanzar ({0}). Prueba con otro modelo o reformula la petición.', action.tool);
					this._post({ type: 'reply', text: final });
					break;
				}
				let output;
				try {
					const mediaReq = { read_image: 'imágenes', read_audio: 'audio', read_video: 'vídeo' }[action.tool];
					const selectedModel = this._models.find(m => m.id === selected);
					const modality = { read_image: 'image', read_audio: 'audio', read_video: 'video' }[action.tool];
					if (mediaReq && this._mode === 'cloud' && selectedModel?.mods && !selectedModel.mods.includes(modality!) && !selectedModel.mods.includes('file')) {
						output = 'El modelo ' + selected + ' es solo-texto y no puede procesar ' + mediaReq + '. Cambia a un modelo multimodal (p. ej. Gemini) y vuelve a intentarlo.';
					} else if (isRepeat) {
						output = lastOutput.startsWith('Error:')
							? 'La acción anterior falló con: ' + lastOutput.slice(0, 280) + ' — NO la repitas idéntica; corrige los argumentos (otra ruta u otro valor) o responde el resumen final.'
							: 'Acción ya ejecutada: tienes su resultado arriba. NO la repitas — continúa con OTRA acción (por ejemplo read_file de un archivo concreto del listado) o responde el resumen final.';
					} else {
						output = await executeAction(action, this._agentMode, controller.signal, { url: cloudUrl() + '/v1/chat/completions', key: this._mode === 'cloud' && !this._freePlan ? key : '' }, actionContext);
						if ((action.tool === 'write_file' || action.tool === 'edit_file') && action.path) {
							try {
								const uri = await workspaceTarget(action.path);
								const doc = await vscode.workspace.openTextDocument(uri);
								await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
							} catch { /* vista opcional */ }
						}
					}
				}
				catch (error) {
					if (controller.signal.aborted) {
						throw error;
					}
					output = 'Error: ' + (error instanceof Error ? error.message : String(error));
				}
				lastOutput = String(output);
				this._post({ type: 'toolResult', text: output.startsWith('ORICODE_IMAGE::') ? '🖼️ ' + (action.path || 'imagen') : output.startsWith('ORICODE_MEDIA::') ? 'Media cargado: ' + (action.path || 'archivo') : output.slice(0, 16000) });
				if (action.tool === 'generate_image') {
					try {
						const req = String(action.filename || 'imagen.png').replace(/\\/g, '/').replace(/^\/+/, '');
						const parts = req.split('/').filter(part => part && part !== '.' && part !== '..').map(part => part.replace(/[^\w.-]/g, '_'));
						const name = (parts.pop() || 'imagen').replace(/\.png$/i, '') + '.png';
						const uri = await workspaceTarget('media/' + [...parts, name].join('/'));
						await vscode.commands.executeCommand('vscode.open', uri, { preserveFocus: true });
					} catch { /* vista opcional */ }
				}
				if (output.startsWith('ORICODE_IMAGE::')) {
					messages.push({ role: 'user', content: [
						{ type: 'text', text: '[Imagen: ' + (action.path || '') + '] — analiza esta imagen' },
						{ type: 'image_url', image_url: { url: output.slice(15) } },
					] });
				} else if (output.startsWith('ORICODE_MEDIA::')) {
					const parts = output.slice(15).split('::');
					const mime = parts[0] || 'application/octet-stream';
					const b64 = parts.slice(1).join('');
					messages.push({ role: 'user', content: [
						{ type: 'text', text: '[' + action.tool + ': ' + (action.path || '') + '] — analiza este archivo (' + mime + ')' },
						{ type: 'file', file: { filename: action.path || 'media', file_data: 'data:' + mime + ';base64,' + b64 } },
					] });
				} else {
					messages.push({ role: 'user', content: '[Resultado de ' + action.tool + ']\n' + output.slice(0, 16000) });
				}
				if (step === limit) {
					final = vscode.l10n.t('Se alcanzó el límite de {0} pasos. Revisa las acciones y continúa con otro mensaje.', limit);
					this._post({ type: 'reply', text: final });
				}
			}
			if (!final) {
				final = vscode.l10n.t('El modelo no completó una respuesta válida. Revisa el registro e inténtalo con otro modelo.');
				this._post({ type: 'reply', text: final });
			}
		}
		catch (error) {
			final = controller.signal.aborted ? vscode.l10n.t('Tarea detenida. Los cambios ya guardados permanecen en el proyecto.') : vscode.l10n.t('Error: {0}', error instanceof Error ? error.message : String(error));
			this._post({ type: 'reply', text: final });
		}
		finally {
			if (final) {
				this._history.push({ r: 'bot', x: final });
			}
			this._history = this._history.slice(-80);
			await this._state.update('oricode.history', this._history);
			this._controller = undefined;
			const next = this._queue.shift();
			this._post({ type: 'busy', value: !!next });
			void this._syncPush();
			if (next) { void this._run(next.text, next.model); }
		}
	}
	private _speechSession: string | undefined;
	private _speechPollTimer: NodeJS.Timeout | undefined;
	private async _speechStart(): Promise<void> {
		if (this._speechSession) {
			return; // already active — ignore double-start
		}
		try {
			const started = await vscode.commands.executeCommand<{ sessionId: string }>('oricode.dictation.start');
			if (!started?.sessionId) {
				throw new Error('sin sessionId');
			}
			this._speechSession = started.sessionId;
			this._speechPoll();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const missing = /command .*not found|no .*command/i.test(detail);
			this._post({ type: 'notice', text: missing ? vscode.l10n.t('Actualiza OriCode para usar el dictado multilingüe') : vscode.l10n.t('No se pudo iniciar el dictado: {0}', detail) });
			this._post({ type: 'speechEnd' });
		}
	}
	private _speechPoll(): void {
		const tick = async () => {
			const sessionId = this._speechSession;
			if (!sessionId) {
				return;
			}
			try {
				const snap = await vscode.commands.executeCommand<Record<string, unknown>>('oricode.dictation.poll', sessionId);
				if (this._speechSession !== sessionId) {
					return; // cancelled meanwhile
				}
				this._post({ type: 'speechUpdate', ...snap });
				if (snap?.state === 'done' || snap?.state === 'error') {
					this._speechSession = undefined;
					this._post({ type: 'speechEnd' });
					return;
				}
			} catch (error) {
				this._speechSession = undefined;
				const detail = error instanceof Error ? error.message : String(error);
				this._post({ type: 'notice', text: vscode.l10n.t('El dictado terminó con un error: {0}', detail) });
				this._post({ type: 'speechEnd' });
				return;
			}
			this._speechPollTimer = setTimeout(tick, 100);
		};
		void tick();
	}
	private async _speechStop(): Promise<void> {
		const sessionId = this._speechSession;
		if (!sessionId) {
			return;
		}
		try {
			const snap = await vscode.commands.executeCommand<Record<string, unknown>>('oricode.dictation.stop', sessionId);
			if (this._speechSession === sessionId && snap) {
				this._post({ type: 'speechUpdate', ...snap });
				this._speechSession = undefined;
				this._post({ type: 'speechEnd' });
			}
		} catch { /* poll loop surfaces errors */ }
	}
	private async _speechCancel(): Promise<void> {
		const sessionId = this._speechSession;
		this._speechSession = undefined;
		if (this._speechPollTimer) {
			clearTimeout(this._speechPollTimer);
			this._speechPollTimer = undefined;
		}
		if (sessionId) {
			try { await vscode.commands.executeCommand('oricode.dictation.cancel', sessionId); } catch { /* session may already be gone */ }
		}
		this._post({ type: 'speechEnd' });
	}
	dispose() { void this._speechCancel(); this._controller?.abort(); this._disposables.forEach(d => d.dispose()); }
	_html(webview: vscode.Webview): string {
		const media = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media'));
		const nonce = randomBytes(18).toString('base64');
		return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${media}/agent.css"></head><body data-assets="${media}">
<header id="top"><div class="connection"><button class="mode" id="mLocal">Local</button><button class="mode" id="mCloud">Cloud</button></div><span id="credits" hidden></span><button class="top-tool" id="refresh" title="Actualizar modelos" aria-label="Actualizar modelos">↻</button><button class="top-tool" id="newChat" title="Nueva conversación" aria-label="Nueva conversación">＋</button><button class="top-tool" id="signin" title="Iniciar sesión en OriCode Cloud">Cuenta</button></header>
<div id="connection" role="status">Conectando con el proveedor…</div>
<main id="log" role="log" aria-label="Conversación con OriCode"></main>
<div id="status" role="status" aria-live="polite"></div>
<div id="composer"><textarea id="in" aria-label="Mensaje para OriCode" placeholder="Pide a OriCode que construya, arregle o explique…" rows="3"></textarea><div id="atchip" hidden></div><div id="actions"><button class="tool" id="attach" title="Adjuntar archivo" aria-label="Adjuntar archivo">＋</button><div class="picker"><button class="tool" id="modeBtn" aria-haspopup="listbox" aria-expanded="false">Code</button><div id="modePanel" class="popup" role="listbox" aria-label="Modo del agente" hidden></div></div><div id="mpick"><button id="selBtn" aria-haspopup="listbox" aria-expanded="false">Cargando…</button><div id="selPanel" class="popup" hidden><input id="selSearch" aria-label="Buscar modelos" placeholder="Buscar modelos o proveedores" autocomplete="off" role="combobox" aria-controls="selList" aria-expanded="false"><div id="selList" role="listbox" aria-label="Modelos disponibles"></div></div></div><button id="send" title="Enviar" aria-label="Enviar" disabled>↑</button></div></div>
<script nonce="${nonce}" src="${media}/agent.js"></script></body></html>`;
	}
}
class OriCodeAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
	private readonly _secrets: vscode.SecretStorage;
	private readonly browser = new BrowserSignIn();
	private pending?: Promise<vscode.AuthenticationSession>;
	_onDidChange = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	onDidChangeSessions = this._onDidChange.event;
	constructor(_secrets: vscode.SecretStorage) {
		this._secrets = _secrets;
	}
	async getSessions() {
		if (await this._secrets.get('oricode.server') !== cloudUrl()) { return []; }
		const key = await this._secrets.get('oricode.apiKey');
		const name = await this._secrets.get('oricode.username');
		return key ? [{
				id: 'oricode-session', accessToken: key,
				scopes: [],
				account: { id: 'oricode', label: name ?? 'OriCode Cloud' },
			}] : [];
	}
	async createSession() {
		if (this.pending) { return this.pending; }
		this.pending = this.signIn();
		try { return await this.pending; }
		finally { this.pending = undefined; }
	}
	private async signIn(): Promise<vscode.AuthenticationSession> {
		const base = cloudUrl();
		const credentials = await this.browser.signIn(base, async url => await vscode.env.openExternal(vscode.Uri.parse(url)), async key => {
			try {
				const identity = await requestJson<{ authenticated: boolean; user: { username: string } }>(base + '/api/auth/ide/me', undefined, key);
				if (identity.authenticated && identity.user?.username) { return identity.user.username; }
			} catch { /* accounts without /api access still own a valid gateway key */ }
			await requestJson(base + '/v1/models', undefined, key);
			return undefined;
		});
		if (base !== cloudUrl()) { throw new Error(vscode.l10n.t('El servidor cambió durante el inicio de sesión. Inténtalo de nuevo.')); }
		await this._secrets.store('oricode.apiKey', credentials.key);
		await this._secrets.store('oricode.username', credentials.username);
		await this._secrets.store('oricode.server', base);
		const session = { id: 'oricode-session', accessToken: credentials.key, scopes: [], account: { id: 'oricode', label: credentials.username || 'OriCode Cloud' } };
		this._onDidChange.fire({ added: [session], removed: undefined, changed: undefined });
		return session;
	}
	async removeSession() {
		this.browser.dispose();
		const key = await this._secrets.get('oricode.apiKey');
		if (!key) {
			return;
		}
		await this._secrets.delete('oricode.apiKey');
		await this._secrets.delete('oricode.username');
		await this._secrets.delete('oricode.server');
		this._onDidChange.fire({
			added: undefined, changed: undefined,
			removed: [{ id: 'oricode-session', accessToken: key, scopes: [], account: { id: 'oricode', label: 'OriCode Cloud' } }],
		});
	}
	dispose() { this.browser.dispose(); this._onDidChange.dispose(); }
}
// ── Diff de propuestas del agente (documento virtual con el contenido propuesto) ──
const proposedContent = new Map<string, string>();
class ProposedContentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri): string {
		return proposedContent.get(uri.toString()) ?? '';
	}
}
function proposedUri(name: string): vscode.Uri {
	return vscode.Uri.parse(`oricode-proposed:${Date.now()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
}
export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('oricode-proposed', new ProposedContentProvider()));
	const authProvider = new OriCodeAuthProvider(context.secrets);
	context.subscriptions.push(authProvider);
	const provider = new AgentViewProvider(context.secrets, context.workspaceState, context.extensionUri, authProvider);
  void vscode.commands.executeCommand('setContext', 'oricode.authenticated', false);
  void provider.restoreSession();
	context.subscriptions.push(provider);
	context.subscriptions.push(authProvider.onDidChangeSessions(async event => {
		if (event.added?.length) {
			await provider.onSignedIn();
			await vscode.commands.executeCommand('oricode.chatView.focus');
			await vscode.commands.executeCommand('workbench.action.focusWindow');
		}
	}));
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('oricode.chatView', provider), vscode.commands.registerCommand('oricode.focusAgent', () => vscode.commands.executeCommand('oricode.chatView.focus')), vscode.commands.registerCommand('orizon.oricodeSignIn', () => provider.signIn()), vscode.commands.registerCommand('oricode.signIn', () => provider.signIn()), vscode.commands.registerCommand('oricode.signOut', () => provider.signOut()), vscode.authentication.registerAuthenticationProvider('oricode', 'OriCode', authProvider));
	void vscode.commands.executeCommand('oricode.chatView.focus');
}
export function deactivate(): void { }
