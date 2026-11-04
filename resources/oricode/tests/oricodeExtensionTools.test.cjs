/* Tests for src/vs/workbench/contrib/extensions/browser/oricodeExtensionTools.ts
 * Transpiles the source at test time and stubs every vscode-internal import so
 * the real command logic runs against mocked workbench services + dialog. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require(path.resolve(__dirname, '../../../node_modules/typescript/lib/typescript.js'));

const SRC = path.resolve(__dirname, '../../../src/vs/workbench/contrib/extensions/browser/oricodeExtensionTools.ts');
const out = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

const commands = {};
const stubs = {
	'cancellation.js': { CancellationToken: { None: {} } },
	'nls.js': { localize: (_key, text, ...args) => text.replace(/\{(\d+)\}/g, (_, n) => args[n]) },
	'commands.js': { CommandsRegistry: { registerCommand: (id, fn) => { commands[id] = fn; } } },
	'dialogs.js': { IDialogService: 'dialogs' },
	'progress.js': { ProgressLocation: { Notification: 'notification' } },
	'workspaceTrust.js': { IWorkspaceTrustManagementService: 'trust' },
	'extensionManagement.js': { EnablementState: { DisabledGlobally: 0, EnabledGlobally: 1, EnabledWorkspace: 2 } },
	'extensions.js': { IExtensionsWorkbenchService: 'extensions' },
};

const fakeModule = { exports: {} };
const oldLoad = Module._load;
Module._load = function (id, ...args) {
	for (const key of Object.keys(stubs)) {
		if (id.endsWith(key)) { return stubs[key]; }
	}
	return oldLoad.call(this, id, ...args);
};
new Function('require', 'module', 'exports', out)(
	id => Module._load(path.posix.normalize(id), fakeModule, null),
	fakeModule, fakeModule.exports,
);
Module._load = oldLoad;

const accessorFor = services => ({ get: key => services[key] });

function ext(over = {}) {
	return {
		identifier: { id: 'ms-python.python' },
		displayName: 'Python',
		publisher: 'ms-python',
		publisherDisplayName: 'Microsoft',
		version: '2026.4.0',
		description: 'Python support',
		enablementState: 1,
		runtimeState: { reason: 'activated' },
		dependencies: [],
		extensionPack: [],
		...over,
	};
}

function services(over = {}) {
	return {
		extensions: {
			queryGallery: async () => ({ firstPage: [] }),
			queryLocal: async () => [],
			getExtensions: async () => [ext()],
			install: async () => { throw new Error('install should not be called'); },
			...over.extensions,
		},
		trust: { isWorkspaceTrusted: () => true, ...over.trust },
		dialogs: { confirm: async () => ({ confirmed: true }), ...over.dialogs },
	};
}

const search = args => commands['oricode.extensions.search'](accessorFor(services()), args);

test('search returns gallery summaries', async () => {
	const svc = services();
	svc.extensions.queryGallery = async (options) => {
		assert.equal(options.pageSize, 5);
		return { firstPage: [ext({ description: 'd' })] };
	};
	const result = await commands['oricode.extensions.search'](accessorFor(svc), { query: 'python' });
	assert.equal(result[0].id, 'ms-python.python');
	assert.equal(result[0].publisher, 'Microsoft');
});

test('check reports installed/enabled and missing', async () => {
	const svc = services();
	svc.extensions.queryLocal = async () => [ext({ enablementState: 0, runtimeState: undefined })];
	const off = await commands['oricode.extensions.check'](accessorFor(svc), { extensionId: 'MS-Python.Python' });
	assert.equal(off.installed, true);
	assert.equal(off.enabled, false);
	svc.extensions.queryLocal = async () => [];
	const missing = await commands['oricode.extensions.check'](accessorFor(svc), { extensionId: 'ms-python.python' });
	assert.equal(missing.installed, false);
});

test('already installed returns without prompting or installing', async () => {
	let confirmed = 0, installed = 0;
	const svc = services({
		extensions: { queryLocal: async () => [ext({ enablementState: 0 })] },
		dialogs: { confirm: async () => { confirmed++; return { confirmed: true }; } },
	});
	svc.extensions.install = async () => { installed++; };
	const result = await commands['oricode.extensions.install'](accessorFor(svc), { extensionId: 'ms-python.python', reason: 'necesito lint', requestId: 'r1' });
	assert.equal(result.alreadyInstalled, true);
	assert.equal(result.enabled, false); // disabled stays disabled — no silent enable
	assert.equal(confirmed, 0);
	assert.equal(installed, 0);
});

test('missing from gallery returns unavailable without consent dialog', async () => {
	let confirmed = 0;
	const svc = services({
		extensions: { getExtensions: async () => [] },
		dialogs: { confirm: async () => { confirmed++; return { confirmed: true }; } },
	});
	const result = await commands['oricode.extensions.install'](accessorFor(svc), { extensionId: 'ms-python.python', reason: 'r', requestId: 'r2' });
	assert.equal(result.unavailable, true);
	assert.equal(confirmed, 0);
});

test('declined dialog never calls install', async () => {
	let installed = 0;
	const svc = services({
		dialogs: { confirm: async () => ({ confirmed: false }) },
	});
	svc.extensions.install = async () => { installed++; };
	const result = await commands['oricode.extensions.install'](accessorFor(svc), { extensionId: 'ms-python.python', reason: 'r', requestId: 'r3' });
	assert.equal(result.declined, true);
	assert.equal(installed, 0);
});

test('cancel during dialog prevents install', async () => {
	let installed = 0;
	const svc = services({
		dialogs: { confirm: async () => {
			commands['oricode.extensions.cancel'](accessorFor(services()), 'r4');
			return { confirmed: true };
		} },
	});
	svc.extensions.install = async () => { installed++; };
	const result = await commands['oricode.extensions.install'](accessorFor(svc), { extensionId: 'ms-python.python', reason: 'r', requestId: 'r4' });
	assert.equal(result.declined, true);
	assert.equal(installed, 0);
});

test('confirmed install goes through native service and reports final state', async () => {
	const calls = [];
	const svc = services();
	svc.extensions.install = async (e, options, location) => {
		calls.push({ id: e.identifier.id, options, location });
		svc.extensions.queryLocal = async () => [ext()];
		return e;
	};
	const result = await commands['oricode.extensions.install'](accessorFor(svc), { extensionId: 'ms-python.python', reason: 'lint python', requestId: 'r5' });
	assert.equal(result.installed, true);
	assert.equal(result.enabled, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].options.installPreReleaseVersion, false);
	assert.equal(calls[0].options.isMachineScoped, true);
	assert.equal(calls[0].location, 'notification');
});

test('untrusted workspace rejected before anything', async () => {
	const svc = services({ trust: { isWorkspaceTrusted: () => false } });
	await assert.rejects(() => commands['oricode.extensions.install'](accessorFor(svc), { extensionId: 'ms-python.python', reason: 'r', requestId: 'r6' }), /confianza/);
});

test('invalid input rejected', async () => {
	await assert.rejects(() => commands['oricode.extensions.install'](accessorFor(services()), { extensionId: 'no-dot-id', reason: 'r', requestId: 'r7' }), /extensionId/);
	await assert.rejects(() => commands['oricode.extensions.install'](accessorFor(services()), { extensionId: 'ms-python.python', reason: '', requestId: 'r7' }), /reason/);
});
