/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
'use strict';

(async () => {
	const element = id => document.getElementById(id);
	try {
		const params = new URLSearchParams(location.search);
		const redirectUri = params.get('redirect_uri');
		const port = params.get('port');
		const state = params.get('state');
		let target;
		if (port !== null || state !== null) {
			if (redirectUri || !/^\d{4,5}$/.test(port || '') || Number(port) < 1024 || Number(port) > 65535 || !/^[a-f0-9]{64}$/.test(state || '')) {
				throw new Error('El retorno al IDE no es válido. Inicia la conexión desde OriCode.');
			}
			target = new URL('http://127.0.0.1:' + port + '/oricode/callback');
			target.searchParams.set('state', state);
		} else if (redirectUri) {
			target = new URL(redirectUri);
			if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || Number(target.port) < 1024 || target.username || target.password || target.hash || target.pathname !== '/oricode/callback' || !/^[a-f0-9]{64}$/.test(target.searchParams.get('state') || '') || [...target.searchParams.keys()].some(key => key !== 'state')) {
				throw new Error('El retorno al IDE no es válido. Inicia la conexión desde OriCode.');
			}
		}
		let key = localStorage.getItem('oc_key');
		const token = localStorage.getItem('oc_tok');
		if (token || key) {
			const response = await fetch('/api/auth/ide/connect', { method: 'POST', headers: { Authorization: 'Bearer ' + (token || key) } });
			if (response.ok) {
				const data = await response.json();
				key = data.ai_api_key;
				if (key) { localStorage.setItem('oc_key', key); }
				if (data.user?.username) { localStorage.setItem('oc_user', data.user.username); }
			} else if (response.status === 401) {
				key = '';
				localStorage.removeItem('oc_tok');
				localStorage.removeItem('oc_key');
				localStorage.removeItem('oc_user');
			} else {
				throw new Error('El servidor no pudo verificar la sesión. Inténtalo de nuevo.');
			}
		}
		if (!key || !/^orz_[a-zA-Z0-9_-]+$/.test(key)) {
			element('t').textContent = 'Inicia sesión en OriCode';
			element('m').textContent = 'Inicia sesión en la web. Después volverás al IDE automáticamente.';
			const login = '/?signin=1&next=' + encodeURIComponent(location.pathname + location.search);
			element('back').href = login;
			element('back').hidden = false;
			element('open').hidden = true;
			location.replace(login);
			return;
		}
		const username = localStorage.getItem('oc_user') || '';
		if (target) {
			target.searchParams.set('key', key);
			target.searchParams.set('user', username);
		} else {
			// Keep the installed client's existing protocol flow working.
			target = new URL('oricode://auth/callback');
			target.searchParams.set('key', key);
			target.searchParams.set('user', username);
		}
		element('open').href = target.href;
		element('m').textContent = 'Conectando con el IDE que inició la sesión…';
		location.replace(target.href);
	} catch (error) {
		element('t').textContent = 'No se pudo conectar con el IDE';
		element('open').hidden = true;
		element('err').textContent = error.message;
	}
})();
