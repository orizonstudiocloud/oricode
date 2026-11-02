/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { BrowserSignIn } = require('../out/browserSignIn.js');

const base = 'https://oricode.orizonstudio.cloud';
const key = 'orz_test_key';
async function callback(url, changes = {}) {
	const params = new URL(url).searchParams;
	const redirect = new URL('http://127.0.0.1:' + params.get('port') + '/oricode/callback');
	redirect.searchParams.set('state', params.get('state'));
	redirect.searchParams.set('key', key);
	redirect.searchParams.set('user', 'prueba');
	for (const [name, value] of Object.entries(changes)) { redirect.searchParams.set(name, value); }
	return fetch(redirect);
}

test('browser callback verifies the key and completes without a protocol handler', async () => {
	const signIn = new BrowserSignIn();
	let verification;
	try {
		const result = await signIn.signIn(base, async url => {
			assert.equal(new URL(url).origin, base);
			assert.equal(new URL(url).searchParams.has('redirect_uri'), false);
			assert.ok(!url.includes('%'));
			const response = await callback(url);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('cache-control'), 'no-store');
			const html = await response.text();
			assert.ok(!html.includes(key));
			assert.match(html, /replaceState/);
			return true;
		}, async value => { verification = value; });
		assert.deepEqual({ result, verification }, { result: { key, username: 'prueba' }, verification: key });
	} finally { signIn.dispose(); }
});

test('unsolicited callbacks, Unicode states and invalid keys do not consume the pending login', async () => {
	const signIn = new BrowserSignIn();
	try {
		await signIn.signIn(base, async url => {
			for (const changes of [{ state: 'x'.repeat(64) }, { state: 'ñ'.repeat(64) }, { key: 'wrong' }]) {
				assert.equal((await callback(url, changes)).status, 400);
			}
			assert.equal((await callback(url)).status, 200);
			return true;
		}, async () => { });
	} finally { signIn.dispose(); }
});

test('a rejected server credential never produces a session', async () => {
	const signIn = new BrowserSignIn();
	try {
		await assert.rejects(signIn.signIn(base, async url => {
			assert.equal((await callback(url)).status, 401);
			return true;
		}, async () => { throw new Error('401'); }), /verify/);
	} finally { signIn.dispose(); }
});

test('browser failure, timeout and disposal close the pending login', async () => {
	const signIn = new BrowserSignIn(30);
	await assert.rejects(signIn.signIn(base, async () => false, async () => { }), /open the browser/);
	await assert.rejects(signIn.signIn(base, async () => true, async () => { }), /timed out/);
	const pending = signIn.signIn(base, async () => { signIn.dispose(); return true; }, async () => { });
	await assert.rejects(pending, /cancelled/);
});

async function runWebLogin(search, loggedIn = true) {
	const script = await fs.readFile(path.resolve(__dirname, '../../../resources/oricode/auth/ide/login.js'), 'utf8');
	const elements = new Map();
	let destination;
	const location = { pathname: '/auth/ide/', search, replace: value => { destination = value; } };
	await vm.runInNewContext(script, {
		URL, URLSearchParams, location,
		localStorage: { getItem: name => loggedIn ? ({ oc_key: key, oc_user: 'prueba' })[name] : null, setItem: () => { }, removeItem: () => { } },
		fetch: async () => ({ ok: true, json: async () => ({ ai_api_key: key }) }),
		document: { getElementById: id => { if (!elements.has(id)) { elements.set(id, {}); } return elements.get(id); } }
	});
	return { destination, elements };
}

test('web login preserves the loopback return across sign-in and rejects credential redirects to other hosts', async () => {
	const flatSearch = '?port=45678&state=' + 'b'.repeat(64);
	const flatSignedOut = await runWebLogin(flatSearch, false);
	assert.equal(new URL(flatSignedOut.destination, base).searchParams.get('next'), '/auth/ide/' + flatSearch);
	const flatSignedIn = await runWebLogin(flatSearch);
	assert.equal(new URL(flatSignedIn.destination).searchParams.get('state'), 'b'.repeat(64));
	for (const search of ['?port=80&state=' + 'b'.repeat(64), '?port=99999&state=' + 'b'.repeat(64), '?port=45678&state=invalid']) {
		assert.equal((await runWebLogin(search)).destination, undefined);
	}
	const redirect = 'http://127.0.0.1:45678/oricode/callback?state=' + 'a'.repeat(64);
	const search = '?redirect_uri=' + encodeURIComponent(redirect);
	const signedOut = await runWebLogin(search, false);
	assert.equal(new URL(signedOut.destination, base).searchParams.get('next'), '/auth/ide/' + search);
	const signedIn = await runWebLogin(search);
	assert.equal(new URL(signedIn.destination).searchParams.get('key'), key);
	for (const invalid of ['https://evil.example/callback', 'http://127.0.0.1.evil.example:45678/oricode/callback', redirect + '&key=evil', redirect.replace('127.0.0.1', 'localhost'), redirect.replace('45678', '80')]) {
		const result = await runWebLogin('?redirect_uri=' + encodeURIComponent(invalid));
		assert.equal(result.destination, undefined);
		assert.match(result.elements.get('err').textContent, /no es válido/);
	}
});
