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
let extensionVersion = '4.0.0';
const extensionPath = path.resolve(__dirname, '../../../..');
const asWebviewUri = (uri: { value: string }) => ({ toString: () => `vscode-resource:${uri.value}` });

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
				webview: { cspSource: 'vscode-resource:', html: '', asWebviewUri, onDidReceiveMessage: () => ({ dispose() { } }) },
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
		extensionPath,
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
		extensionVersion = '4.0.0';
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

		it('matches only the 4.x release line (prereleases included)', () => {
			assert.ok(newDatastores.isNoticeReleaseLine('4.0.0'));
			assert.ok(newDatastores.isNoticeReleaseLine('4.3.7'));
			assert.ok(newDatastores.isNoticeReleaseLine('4.0.0-beta.1'));
			assert.ok(!newDatastores.isNoticeReleaseLine('3.2.0'));
			assert.ok(!newDatastores.isNoticeReleaseLine('3.9.9'));
			assert.ok(!newDatastores.isNoticeReleaseLine('5.0.0'));
			assert.ok(!newDatastores.isNoticeReleaseLine('not-a-version'));
		});
	});

	describe('DevDb v4 notice gating', () => {
		it('shows the webview once for free users and stores a single awaited flag', async () => {
			const context = makeFakeContext();

			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '4.0.0'), 'webview');
			assert.strictEqual(context.store.get(newDatastores.NOTICE_SHOWN_KEY), true);
			assert.strictEqual(context.pendingUpdates.length, 0, 'globalState.update must be awaited');

			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '4.0.1'), 'none');
			await flushTimers();
			assert.deepStrictEqual(createdPanels, ['devdb-new-datastores-notice']);
		});

		it('never shows outside the 4.x line', async () => {
			const context = makeFakeContext();
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '3.2.0'), 'none');
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '5.0.0'), 'none');
			assert.strictEqual(context.store.has(newDatastores.NOTICE_SHOWN_KEY), false);
		});

		it('shows on a 4.0 prerelease', async () => {
			const context = makeFakeContext();
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '4.0.0-beta.1'), 'webview');
		});

		it('shows even when a 3.2 build already showed its notice (new key)', async () => {
			const context = makeFakeContext({ 'newDatastores.notice.shown': true });
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '4.0.0'), 'webview');
		});

		it('shows a one-time toast (no webview) for licensed users', async () => {
			const context = makeFakeContext();
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '4.0.0', { hasLicense: true }), 'toast');
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '4.0.0', { hasLicense: true }), 'none');
			await flushTimers();
			assert.deepStrictEqual(infoMessages, [newDatastores.PRO_TOAST_MESSAGE]);
			assert.deepStrictEqual(createdPanels, []);
		});

		it('defers the webview when another full-page promo showed this launch', async () => {
			const context = makeFakeContext();
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '4.0.0', { fullPagePromoShownThisLaunch: true }), 'none');
			assert.strictEqual(context.store.has(newDatastores.NOTICE_SHOWN_KEY), false, 'must stay pending for a later launch');
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '4.0.0'), 'webview');
		});

		it('respects showFewerUpdateNotificationActions and dontShowNewVersionMessage', async () => {
			settings.showFewerUpdateNotificationActions = true;
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(makeFakeContext(), '4.0.0'), 'none');
			delete settings.showFewerUpdateNotificationActions;
			settings.dontShowNewVersionMessage = true;
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(makeFakeContext(), '4.0.0'), 'none');
		});

		it('forcePreview bypasses gating and reset clears the flag', async () => {
			const context = makeFakeContext({ [newDatastores.NOTICE_SHOWN_KEY]: true, 'newDatastores.notice.dismissed': true, 'newDatastores.notice.shown': true });
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(context, '9.9.9', { forcePreview: true, hasLicense: true }), 'toast');

			await newDatastores.resetNewDatastoresNotice(context);
			assert.strictEqual(context.store.size, 0);
		});
	});

	describe('DevWorkspace Pro showcase gating', () => {
		const shouldShow = (context: any, ddev = true, fewer = false) => devWorkspacePro.shouldShowDevWorkspaceProNotice(context, ddev, fewer);

		it('shows once per content version, not per DevDb version', async () => {
			const ddevRoot = makeDdevWorkspace();
			const context = makeFakeContext({ 'devworkspacepro.notice.shown': '3.2.0' });

			assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForDdevWorkspaces(context), true);
			assert.strictEqual(context.store.get(devWorkspacePro.NOTICE_CONTENT_VERSION_KEY), devWorkspacePro.NOTICE_CONTENT_VERSION);
			assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForDdevWorkspaces(context), false);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, ['devworkspacepro-notice']);

			fs.rmSync(ddevRoot, { recursive: true, force: true });
		});

		it('shows again for a newer content version', () => {
			assert.ok(shouldShow(makeFakeContext({ [devWorkspacePro.NOTICE_CONTENT_VERSION_KEY]: '2025-01' })));
			assert.ok(!shouldShow(makeFakeContext({ [devWorkspacePro.NOTICE_CONTENT_VERSION_KEY]: devWorkspacePro.NOTICE_CONTENT_VERSION })));
		});

		it('needs a DDEV workspace, and respects the fewer-notifications settings and an old dismissal', async () => {
			assert.ok(!shouldShow(makeFakeContext(), false));
			assert.ok(!shouldShow(makeFakeContext(), true, true));
			assert.ok(!shouldShow(makeFakeContext({ 'devworkspacepro.notice.dismissed': true })));

			const ddevRoot = makeDdevWorkspace();
			settings.dontShowNewVersionMessage = true;
			assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForDdevWorkspaces(makeFakeContext()), false);
			fs.rmSync(ddevRoot, { recursive: true, force: true });
		});

		it('stays pending when another full-page promo showed this launch', async () => {
			const ddevRoot = makeDdevWorkspace();
			const context = makeFakeContext();
			assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForDdevWorkspaces(context, false, { fullPagePromoShownThisLaunch: true }), false);
			assert.strictEqual(context.store.has(devWorkspacePro.NOTICE_CONTENT_VERSION_KEY), false);
			fs.rmSync(ddevRoot, { recursive: true, force: true });
		});
	});

	describe('welcome message', () => {
		it('shows the DevDb v4 notice first and defers the DevWorkspace Pro showcase', async () => {
			const ddevRoot = makeDdevWorkspace();

			const context = makeFakeContext({ 'devdb-version': '3.1.0' });
			await welcome.showWelcomeMessage(context, false);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, ['devdb-new-datastores-notice']);
			assert.strictEqual(context.store.has(devWorkspacePro.NOTICE_CONTENT_VERSION_KEY), false);

			// Next launch, same version: the deferred showcase shows.
			createdPanels.length = 0;
			await welcome.showWelcomeMessage(context, false);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, ['devworkspacepro-notice']);

			// Third launch: nothing left to show.
			createdPanels.length = 0;
			await welcome.showWelcomeMessage(context, false);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, []);

			fs.rmSync(ddevRoot, { recursive: true, force: true });
		});

		it('licensed users get the DevDb v4 toast and the showcase on the same launch', async () => {
			const ddevRoot = makeDdevWorkspace();

			const context = makeFakeContext({ 'devdb-version': '3.1.0' });
			await welcome.showWelcomeMessage(context, true);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, ['devworkspacepro-notice']);
			assert.ok(infoMessages.includes(newDatastores.PRO_TOAST_MESSAGE));

			fs.rmSync(ddevRoot, { recursive: true, force: true });
		});

		it('mentions the new engines on 4.x only', () => {
			assert.ok(welcome.getUpdateMessage('4.0.0').includes('New in 4.0'));
			assert.ok(!welcome.getUpdateMessage('3.3.0').includes('New in 4.0'));
			assert.ok(!welcome.getUpdateMessage('4.0.0').includes('$9'));
		});
	});

	describe('notice pages', () => {
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

		const webview = { cspSource: 'vscode-resource:', asWebviewUri };
		for (const [name, render] of [
			['devdb-4', (nonce: string) => newDatastores.getNoticeHtml(webview, nonce, extensionPath)],
			['devworkspacepro', (nonce: string) => devWorkSpaceProHtml(nonce, false)],
			['devworkspacepro (new install)', (nonce: string) => devWorkSpaceProHtml(nonce, true)],
		] as const) {
			it(`${name} notice has a strict CSP, no inline handlers or styles, and only local assets that exist`, () => {
				const nonce = html.getNonce();
				const page: string = render(nonce);

				assert.ok(page.includes(`default-src 'none'; img-src https: vscode-resource:; style-src vscode-resource: 'nonce-${nonce}'; script-src 'nonce-${nonce}';`));
				assert.ok(!page.includes('unsafe-inline'));
				assert.ok(!page.includes('{{'), 'all placeholders are expanded');
				assert.ok(!/\son[a-z]+=/i.test(page), 'no inline event handlers');
				assert.ok(!/\sstyle=/i.test(page), 'no inline style attributes (the CSP blocks them)');
				assert.ok(!/<style/i.test(page), 'styles come from local files');
				assert.ok(!page.includes('http://'), 'no plain http resources');

				const scripts = [...page.matchAll(/<script\b([^>]*)>/gi)].map(match => match[1]);
				assert.ok(scripts.length > 0);
				for (const attributes of scripts) {
					assert.ok(attributes.includes(`nonce="${nonce}"`), `script without nonce: ${attributes}`);
				}

				const assets = [...page.matchAll(/\s(?:src|href)="([^"]+)"/g)].map(match => match[1]);
				assert.ok(assets.length >= 2, 'links the stylesheet and the script');
				for (const asset of assets) {
					assert.ok(asset.startsWith('vscode-resource:'), `remote or relative asset: ${asset}`);
					const file = asset.slice('vscode-resource:'.length);
					assert.ok(file.startsWith(path.join(extensionPath, 'resources', 'notices') + path.sep), `asset outside resources/notices: ${file}`);
					assert.ok(fs.existsSync(file), `missing asset: ${file}`);
				}
			});
		}

		it('the DevDb v4 notice shows the Pro price and both CTAs', () => {
			const page: string = newDatastores.getNoticeHtml(webview, html.getNonce(), extensionPath);
			assert.ok(page.includes(`$${newDatastores.PRO_LIFETIME_PRICE_USD}`));
			assert.ok(page.includes('data-command="getLicense"'));
			assert.ok(page.includes('data-command="docs"'));
			assert.strictEqual(newDatastores.PRICING_URL, 'https://devdbpro.com/?ref=ide&pro=true#pricing');
		});

		it('names the release "DevDb v4", never "DevDb 4"', () => {
			const page: string = newDatastores.getNoticeHtml(webview, html.getNonce(), extensionPath);
			assert.ok(page.includes('DevDb v4'));
			assert.ok(newDatastores.PRO_TOAST_MESSAGE.startsWith('DevDb v4'));
			assert.ok(!/DevDb 4\b/.test(page + newDatastores.PRO_TOAST_MESSAGE));
		});

		it('the DevWorkspace Pro notice embeds every mock it includes', () => {
			const template = fs.readFileSync(path.join(extensionPath, 'resources/notices', devWorkspacePro.NOTICE_TEMPLATE), 'utf8');
			const includes = [...template.matchAll(/\{\{include:([^}]+)\}\}/g)].map(match => match[1]);
			assert.ok(includes.length >= 2);
			const page = devWorkSpaceProHtml(html.getNonce(), false);
			assert.ok(page.includes('mock-ui'));
			assert.ok(!page.includes('data-tab'), 'no tabs');
		});

		it('the DevWorkspace Pro notice leads with the New AI session shortcut', () => {
			const page = devWorkSpaceProHtml(html.getNonce(), false);
			assert.match(page, /class="key key-letter">J</);
			const highlights = page.slice(page.indexOf('class="highlights"'));
			assert.ok(highlights.indexOf('New AI session') < highlights.indexOf('<li>'), 'New AI session is the first highlight');
		});

		for (const isNewInstall of [false, true]) {
			it(`the DevWorkspace Pro notice shows the ${isNewInstall ? 'welcome' : 'launch'} offer next to the CTA`, () => {
				const { offerTitle, discountCode, offerText } = devWorkspacePro.getOffer(isNewInstall);
				const page = devWorkSpaceProHtml(html.getNonce(), isNewInstall);
				const hero = page.slice(page.indexOf('<section class="hero">'), page.indexOf('<div class="visual"'));
				assert.ok(hero.includes('data-command="getLicense"'));
				for (const text of [offerTitle, offerText, discountCode, 'data-command="copyCode"']) {
					assert.ok(hero.includes(text), `hero misses ${text}`);
				}
			});
		}

		it('notice styles use no linear gradients, gradient text or glass effects', () => {
			for (const file of ['v4/notice.css', 'devworkspacepro/notice.css']) {
				const css = fs.readFileSync(path.join(extensionPath, 'resources/notices', file), 'utf8');
				assert.ok(!/(linear|conic)-gradient\(|background-clip:\s*text|backdrop-filter/i.test(css), `${file} uses a banned effect`);
			}
		});

		it('rejects unknown placeholders and paths outside resources/notices', () => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devdb-notice-'));
			fs.mkdirSync(path.join(tmp, 'resources', 'notices'), { recursive: true });
			fs.writeFileSync(path.join(tmp, 'resources', 'notices', 'a.html'), '{{typo}}');
			fs.writeFileSync(path.join(tmp, 'resources', 'notices', 'b.html'), '{{include:../../package.json}}');
			fs.writeFileSync(path.join(tmp, 'resources', 'notices', 'c.html'), '<p>{{name}}</p>');

			assert.throws(() => html.renderNoticeTemplate(tmp, webview, 'n', 'a.html'), /Unknown notice placeholder/);
			assert.throws(() => html.renderNoticeTemplate(tmp, webview, 'n', 'b.html'), /escapes/);
			assert.strictEqual(html.renderNoticeTemplate(tmp, webview, 'n', 'c.html', { name: '<b>"x"</b>' }), '<p>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</p>');

			fs.rmSync(tmp, { recursive: true, force: true });
		});
	});
});

function devWorkSpaceProHtml(nonce: string, isNewInstall: boolean): string {
	return devWorkspacePro.getNoticeHtml({ cspSource: 'vscode-resource:', asWebviewUri }, nonce, extensionPath, isNewInstall);
}

function makeDdevWorkspace(): string {
	const ddevRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devdb-ddev-'));
	fs.mkdirSync(path.join(ddevRoot, '.ddev'));
	workspaceFolders = [{ uri: { fsPath: ddevRoot } }];
	return ddevRoot;
}
