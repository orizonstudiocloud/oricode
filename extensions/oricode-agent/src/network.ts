/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'file'; file: { filename: string; file_data: string } };
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }
export interface ChatResult { text: string; thinking?: string; credits?: number }
interface WireResponse {
	error?: string | { message?: string }; detail?: string; done?: boolean;
	message?: { content?: string; thinking?: string };
	choices?: { delta?: { content?: string; reasoning?: string; reasoning_content?: string }; message?: { content?: string; reasoning?: string } }[];
	oricode?: { credits_remaining?: number };
}

function errorText(data: WireResponse): string | undefined {
	return typeof data.error === 'string' ? data.error : data.error?.message || data.detail;
}

export function requestJson<T>(url: string, payload?: object, bearer?: string, signal?: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const body = payload === undefined ? undefined : JSON.stringify(payload);
		const request = new URL(url).protocol === 'https:' ? https.request : http.request;
		const req = request(url, {
			method: body ? 'POST' : 'GET', signal, timeout: 15000,
			headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
		}, res => {
			res.setEncoding('utf8');
			let data = '';
			res.on('data', chunk => { data += chunk; if (data.length > 8000000) { req.destroy(new Error('Respuesta demasiado grande')); } });
			res.on('error', reject);
			res.on('aborted', () => reject(new Error('Conexión interrumpida')));
			res.on('end', () => {
				try {
					const parsed = JSON.parse(data);
					if ((res.statusCode ?? 500) >= 400 || errorText(parsed)) { reject(new Error('HTTP ' + res.statusCode + ': ' + (errorText(parsed) || res.statusMessage))); }
					else { resolve(parsed as T); }
				} catch { reject(new Error('Respuesta JSON inválida (HTTP ' + res.statusCode + ')')); }
			});
		});
		req.on('error', reject);
		req.on('timeout', () => req.destroy(new Error('Tiempo de conexión agotado')));
		if (body) { req.write(body); }
		req.end();
	});
}

export function streamChat(url: string, model: string, messages: ChatMessage[], options: {
	key?: string; signal?: AbortSignal; timeoutMs?: number; local: boolean;
	onDelta: (text: string) => void; onThinking?: (text: string) => void;
}): Promise<ChatResult> {
	return new Promise((resolve, reject) => {
		let text = '', thinking = '', buffer = '', raw = '', credits: number | undefined, settled = false;
		const request = new URL(url).protocol === 'https:' ? https.request : http.request;
		const finish = (error?: Error) => {
			if (settled) { return; }
			settled = true; clearTimeout(deadline);
			if (error) { reject(error); }
			else {
				if (!text.trim() && thinking.trim()) { text = thinking; thinking = ''; }
				if (!text.trim()) { reject(new Error('El proveedor no devolvió contenido.')); }
				else { resolve({ text, thinking, credits }); }
			}
		};
		const consume = (line: string) => {
			if (!line.trim() || line.startsWith(':') || (!options.local && !line.startsWith('data:'))) { return; }
			const data = options.local ? line : line.slice(5).trim();
			if (data === '[DONE]') { finish(); req.destroy(); return; }
			const event = JSON.parse(data) as WireResponse;
			const error = errorText(event);
			if (error) { throw new Error(error); }
			const delta = event.choices?.[0]?.delta;
			const message = event.choices?.[0]?.message;
			const content = options.local ? event.message?.content : delta?.content;
			const thought = options.local ? event.message?.thinking : delta?.reasoning || delta?.reasoning_content;
			if (content) { text += content; options.onDelta(text); }
			if (message?.content && !text) { text = message.content; options.onDelta(text); }
			if (thought) { thinking += thought; options.onThinking?.(thinking); }
			if (event.oricode?.credits_remaining !== undefined) { credits = event.oricode.credits_remaining; }
			if (options.local && event.done) { finish(); req.destroy(); }
		};
		const req = request(url, {
			method: 'POST', signal: options.signal, timeout: options.timeoutMs ?? 120000,
			headers: { 'Content-Type': 'application/json', ...(options.key ? { Authorization: 'Bearer ' + options.key } : {}) },
		}, res => {
			res.setEncoding('utf8');
			const json = !options.local && /application\/json/i.test(String(res.headers['content-type']));
			const failed = (res.statusCode ?? 500) >= 400;
			res.on('data', chunk => {
				if (settled) { return; }
				if (json || failed) {
					raw += chunk;
					if (raw.length > 8000000) { req.destroy(new Error('Respuesta demasiado grande')); }
					return;
				}
				buffer += chunk;
				if (buffer.length > 2000000) { req.destroy(new Error('Evento demasiado grande')); return; }
				const lines = buffer.split('\n'); buffer = lines.pop() || '';
				try { for (const line of lines) { consume(line.replace(/\r$/, '')); } }
				catch (error) { finish(error instanceof Error ? error : new Error(String(error))); req.destroy(); }
			});
			res.on('error', finish);
			res.on('aborted', () => finish(new Error('El proveedor interrumpió la respuesta')));
			res.on('end', () => {
				if (settled) { return; }
				try {
					if (raw) {
						let data: WireResponse;
						try { data = JSON.parse(raw) as WireResponse; } catch { throw new Error('HTTP ' + res.statusCode + ': respuesta inválida del proveedor'); }
						if (failed || errorText(data)) { throw new Error('HTTP ' + res.statusCode + ': ' + (errorText(data) || res.statusMessage)); }
						text = data.choices?.[0]?.message?.content || '';
						thinking = data.choices?.[0]?.message?.reasoning || '';
						credits = data.oricode?.credits_remaining;
						if (text) { options.onDelta(text); }
					} else if (failed) { throw new Error('HTTP ' + res.statusCode); }
					else if (buffer.trim()) { consume(buffer.replace(/\r$/, '')); }
					finish();
				} catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
			});
		});
		const deadline = setTimeout(() => req.destroy(new Error('Tiempo máximo de respuesta agotado')), options.timeoutMs ?? 120000);
		req.on('error', finish);
		req.on('timeout', () => req.destroy(new Error('El proveedor dejó de responder')));
		req.write(JSON.stringify({ model, messages, stream: true, ...(options.local ? { options: { num_ctx: 16384 } } : {}) }));
		req.end();
	});
}
