import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Minimal `vscode` stand-in so the notice services can load outside VS Code.
 */
const settings: Record<string, any> = {};
const infoMessages: string[] = [];
const createdPanels: string[] = [];
let workspaceFolders: any[] | undefined;
let extensionVersion = '3.2.0';

const vscodeStub = {
	ViewColumn: { One: 1 },
	Uri: { parse: (value: string) => ({ value }), file: (value: string) => ({ value }) },
	env: { openExternal: async () => true },
	extensions: { getExtension: () => ({ packageJSON: { version: extensionVersion } }) },
	workspace: {
		get workspaceFolders() { return workspaceFolders; },
		getConfiguration: () => ({ get: (key: string, fallback?: any) => (key in settings ? settings[key] : fallback) }),
	},
	window: {
		showInformationMessage: (message: string) => { infoMessages.push(message); return Promise.resolve(undefined); },
		createWebviewPanel: (viewType: string) => {
			createdPanels.push(viewType);
			return {
				webview: { cspSource: 'vscode-resource:', html: '', onDidReceiveMessage: () => ({ dispose() { } }) },
				iconPath: undefined,
				dispose() { },
			};
		},
	},
};

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.call(this, request, ...rest);
};

// Other suites may have loaded these services with a different `vscode` stub.
const servicesDir = path.resolve(__dirname, '../../../services');
for (const cached of Object.keys(require.cache)) {
	if (cached.startsWith(servicesDir)) delete require.cache[cached];
}

const newDatastores = require('../../../services/new-datastores-notification-service');
const welcome = require('../../../services/welcome-message-service');
const version = require('../../../services/version');
const html = require('../../../services/html');
const devWorkspacePro = require('../../../services/devworkspacepro-notification-service');

function makeFakeContext(initial: Record<string, any> = {}) {
	const store = new Map<string, any>(Object.entries(initial));
	const pendingUpdates: string[] = [];
	return {
		store,
		pendingUpdates,
		subscriptions: [],
		asAbsolutePath: (p: string) => p,
		globalState: {
			get: (key: string, fallback?: any) => (store.has(key) ? store.get(key) : fallback),
			update: (key: string, value: any) => {
				pendingUpdates.push(key);
				return new Promise<void>(resolve => setTimeout(() => {
					if (value === undefined) store.delete(key); else store.set(key, value);
					pendingUpdates.splice(pendingUpdates.indexOf(key), 1);
					resolve();
				}, 1));
			},
		},
	} as any;
}

async function flushTimers(ms = 1300) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

describe('Promo notices', function () {
	this.timeout(10000);

	beforeEach(() => {
		for (const key of Object.keys(settings)) delete settings[key];
		infoMessages.length = 0;
		createdPanels.length = 0;
		workspaceFolders = undefined;
		extensionVersion = '3.2.0';
	});

	// Let delayed webview timers from a test fire before the next test starts.
	afterEach(() => flushTimers());

	after(() => {
		Module._load = originalLoad;
	});

	describe('version parsing', () => {
		it('parses release and prerelease versions', () => {
			assert.deepStrictEqual(version.parseVersion('3.2.0'), { core: [3, 2, 0], prerelease: [] });
			assert.deepStrictEqual(version.parseVersion('3.2.0-beta.1'), { core: [3, 2, 0], prerelease: ['beta', '1'] });
			assert.deepStrictEqual(version.parseVersion('3.2.1+build.5'), { core: [3, 2, 1], prerelease: [] });
			assert.strictEqual(version.parseVersion('not-a-version'), undefined);
		});

		it('compares with semver precedence', () => {
			assert.ok(welcome.isUpdate('3.1.9', '3.2.0-beta.1'));
			assert.ok(welcome.isUpdate('3.2.0-beta.1', '3.2.0'));
			assert.ok(welcome.isUpdate('3.2.0-beta.1', '3.2.0-beta.2'));
			assert.ok(welcome.isUpdate('3.2.0-beta.9', '3.2.0-beta.10'));
			assert.ok(welcome.isUpdate('3.2.0-alpha', '3.2.0-beta'));
			assert.ok(!welcome.isUpdate('3.2.0', '3.2.0-beta.1'));
			assert.ok(!welcome.isUpdate('3.2.0', '3.2.0'));
			assert.ok(!welcome.isUpdate('3.10.0', '3.9.0'));
		});

		it('matches only the 3.2.x release line (prereleases included)', () => {
			assert.ok(newDatastores.isNoticeReleaseLine('3.2.0'));
			assert.ok(newDatastores.isNoticeReleaseLine('3.2.7'));
			assert.ok(newDatastores.isNoticeReleaseLine('3.2.0-beta.1'));
			assert.ok(!newDatastores.isNoticeReleaseLine('3.3.0'));
			assert.ok(!newDatastores.isNoticeReleaseLine('3.1.9'));
			assert.ok(!newDatastores.isNoticeReleaseLine('4.2.0'));
		});
	});

	describe('new-datastores notice gating', () => {
		it('shows the webview once for free users and stores a single awaited flag', async () => {
			const context = makeFakeContext();

			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '3.2.0'), 'webview');
			assert.strictEqual(context.store.get(newDatastores.NOTICE_SHOWN_KEY), true);
			assert.strictEqual(context.pendingUpdates.length, 0, 'globalState.update must be awaited');

			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '3.2.1'), 'none');
			await flushTimers();
			assert.deepStrictEqual(createdPanels, ['devdb-new-datastores-notice']);
		});

		it('never shows outside the 3.2.x line', async () => {
			const context = makeFakeContext();
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '3.3.0'), 'none');
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '3.1.0'), 'none');
			assert.strictEqual(context.store.has(newDatastores.NOTICE_SHOWN_KEY), false);
		});

		it('shows a prerelease of 3.2', async () => {
			const context = makeFakeContext();
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '3.2.0-beta.1'), 'webview');
		});

		it('shows a one-time toast (no webview) for licensed users', async () => {
			const context = makeFakeContext();
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '3.2.0', { hasLicense: true }), 'toast');
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '3.2.0', { hasLicense: true }), 'none');
			await flushTimers();
			assert.deepStrictEqual(infoMessages, [newDatastores.PRO_TOAST_MESSAGE]);
			assert.deepStrictEqual(createdPanels, []);
		});

		it('defers the webview when another full-page promo showed this launch', async () => {
			const context = makeFakeContext();
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '3.2.0', { fullPagePromoShownThisLaunch: true }), 'none');
			assert.strictEqual(context.store.has(newDatastores.NOTICE_SHOWN_KEY), false, 'must stay pending for a later launch');
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '3.2.0'), 'webview');
		});

		it('respects showFewerUpdateNotificationActions', async () => {
			settings.showFewerUpdateNotificationActions = true;
			const context = makeFakeContext();
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '3.2.0'), 'none');
		});

		it('forcePreview bypasses gating and reset clears the flag', async () => {
			const context = makeFakeContext({ [newDatastores.NOTICE_SHOWN_KEY]: true, 'newDatastores.notice.dismissed': true });
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '9.9.9', { forcePreview: true, hasLicense: true }), 'toast');

			await newDatastores.resetNewDatastoresNotice(context);
			assert.strictEqual(context.store.size, 0);
		});
	});

	describe('welcome message', () => {
		it('shows at most one full-page promo per launch and defers the other', async () => {
			const ddevRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devdb-ddev-'));
			fs.mkdirSync(path.join(ddevRoot, '.ddev'));
			workspaceFolders = [{ uri: { fsPath: ddevRoot } }];

			const context = makeFakeContext({ 'devdb-version': '3.1.0' });
			await welcome.showWelcomeMessage(context, false);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, ['devworkspacepro-notice']);
			assert.strictEqual(context.store.has(newDatastores.NOTICE_SHOWN_KEY), false);

			// Next launch, same version: the deferred notice shows.
			createdPanels.length = 0;
			await welcome.showWelcomeMessage(context, false);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, ['devdb-new-datastores-notice']);

			fs.rmSync(ddevRoot, { recursive: true, force: true });
		});

		it('drops the Pro line and price offer outside 3.2.x', () => {
			assert.ok(welcome.getUpdateMessage('3.2.0').includes('New in Pro'));
			assert.ok(!welcome.getUpdateMessage('3.3.0').includes('New in Pro'));
			assert.ok(!welcome.getUpdateMessage('3.2.0').includes('$9'));
		});
	});

	describe('webview CSP', () => {
		it('generates random 16-byte base64 nonces', () => {
			const nonces = new Set<string>();
			for (let i = 0; i < 50; i++) {
				const nonce = html.getNonce();
				assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/);
				assert.strictEqual(Buffer.from(nonce, 'base64').length, 16);
				nonces.add(nonce);
			}
			assert.strictEqual(nonces.size, 50);
		});

		for (const [name, render] of [
			['new-datastores', (csp: string, nonce: string) => newDatastores.getNoticeHtml(csp, nonce)],
			['devworkspacepro', (csp: string, nonce: string) => devWorkspacePro.getNoticeHtml(csp, nonce, false)],
		] as const) {
			it(`${name} notice has a strict CSP and no inline handlers`, () => {
				const nonce = html.getNonce();
				const page: string = render('vscode-resource:', nonce);

				assert.ok(page.includes(`default-src 'none'; img-src https: vscode-resource:; style-src vscode-resource: 'nonce-${nonce}'; script-src 'nonce-${nonce}';`));
				assert.ok(page.includes(`<script nonce="${nonce}">`));
				assert.ok(!/\son[a-z]+=/i.test(page), 'no inline event handlers');
				assert.ok(!page.includes('http://'), 'no plain http resources');
				assert.ok(!page.includes('unsafe-inline'));
			});
		}
	});
});
