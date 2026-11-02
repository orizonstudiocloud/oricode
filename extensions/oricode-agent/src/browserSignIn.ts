/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, timingSafeEqual } from 'crypto';
import { createServer, Server } from 'http';

export interface BrowserCredentials { key: string; username: string }

/** Receives one browser login on an ephemeral port bound exclusively to this PC. */
export class BrowserSignIn {
	private server?: Server;
	private timer?: ReturnType<typeof setTimeout>;
	private cancel?: () => void;

	constructor(private readonly timeoutMs = 180000) { }

	async signIn(baseUrl: string, openBrowser: (url: string) => Promise<boolean>, verify: (key: string) => Promise<string | void>): Promise<BrowserCredentials> {
		if (this.server) { throw new Error('OriCode browser sign-in is already in progress.'); }
		const state = randomBytes(32).toString('hex');
		let resolveLogin!: (value: BrowserCredentials) => void;
		let rejectLogin!: (error: Error) => void;
		const completion = new Promise<BrowserCredentials>((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });
		// Install the rejection handler before opening the browser or timing out.
		void completion.catch(() => { });
		let receiving = false;
		const server = createServer(async (request, response) => {
			response.setHeader('Cache-Control', 'no-store');
			response.setHeader('Referrer-Policy', 'no-referrer');
			response.setHeader('Content-Security-Policy', 'default-src \'none\'; script-src \'unsafe-inline\'');
			const callback = new URL(request.url ?? '/', 'http://127.0.0.1');
			const suppliedState = callback.searchParams.get('state') ?? '';
			if (request.method !== 'GET' || callback.pathname !== '/oricode/callback' || !/^[a-f0-9]{64}$/.test(suppliedState) || !timingSafeEqual(Buffer.from(suppliedState), Buffer.from(state))) {
				response.writeHead(400).end('Invalid login callback');
				return;
			}
			const key = callback.searchParams.get('key') ?? '';
			if (receiving || !/^orz_[a-zA-Z0-9_-]+$/.test(key)) {
				response.writeHead(400).end('Invalid login callback');
				return;
			}
			receiving = true;
			try {
				const username = await verify(key);
				response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				response.end('<!doctype html><html lang="es"><meta charset="utf-8"><title>OriCode</title><script>history.replaceState(null,"","/oricode/connected")</script><h1>Sesión iniciada en OriCode</h1><p>Ya puedes volver al IDE y cerrar esta pestaña.</p></html>');
				resolveLogin({ key, username: username ?? (callback.searchParams.get('user') ?? '').slice(0, 200) });
			} catch (error) {
				const reason = error instanceof Error && error.message ? error.message : '';
				const safe = reason.replace(/[&<>"]/g, c => '&#x' + c.charCodeAt(0).toString(16) + ';');
				response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
				response.end('<!doctype html><html lang="es"><meta charset="utf-8"><title>OriCode</title><script>history.replaceState(null,"","/oricode/error")</script><h1>No se pudo verificar la sesión</h1><p>Vuelve a iniciar sesión desde el IDE.</p>' + (safe ? '<p><code>' + safe + '</code></p>' : '') + '</html>');
				rejectLogin(new Error('OriCode could not verify the browser session.' + (reason ? ' ' + reason : '')));
			} finally {
				this.close();
			}
		});
		this.server = server;
		this.cancel = () => rejectLogin(new Error('OriCode browser sign-in cancelled.'));
		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
			});
			server.on('error', error => { rejectLogin(error); this.close(); });
			const address = server.address();
			if (!address || typeof address === 'string') { throw new Error('OriCode could not open the local callback.'); }
			const url = new URL('/auth/ide/', baseUrl);
			// Keep the browser URL flat: VS Code's URI opener re-encodes nested URLs.
			url.searchParams.set('port', String(address.port));
			url.searchParams.set('state', state);
			this.timer = setTimeout(() => { rejectLogin(new Error('OriCode browser sign-in timed out.')); this.close(); }, this.timeoutMs);
			if (!await openBrowser(url.href)) { throw new Error('OriCode could not open the browser.'); }
			return await completion;
		} finally {
			this.close();
		}
	}

	private close(): void {
		clearTimeout(this.timer);
		this.server?.close();
		this.server?.closeIdleConnections();
		this.server = undefined;
		this.cancel = undefined;
	}

	dispose(): void {
		this.cancel?.();
		this.close();
	}
}
