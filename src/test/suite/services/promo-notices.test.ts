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
const optOuts = require('../../../services/notice-opt-outs');

/** Dates around the end of the launch window, when opt-outs start to count again. */
const BEFORE_OPT_OUTS = new Date(2026, 11, 24, 23, 59);
const AFTER_OPT_OUTS = new Date(2026, 11, 25, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

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

		it('respects showFewerUpdateNotificationActions and dontShowNewVersionMessage from the opt-out date', async () => {
			settings.showFewerUpdateNotificationActions = true;
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(makeFakeContext(), '4.0.0', { now: AFTER_OPT_OUTS }), 'none');
			delete settings.showFewerUpdateNotificationActions;
			settings.dontShowNewVersionMessage = true;
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(makeFakeContext(), '4.0.0', { now: AFTER_OPT_OUTS }), 'none');
		});

		it('ignores the fewer-notifications settings before the opt-out date', async () => {
			settings.showFewerUpdateNotificationActions = true;
			settings.dontShowNewVersionMessage = true;
			assert.strictEqual(await newDatastores.showNewDatastoresNotice(makeFakeContext(), '4.0.0', { now: BEFORE_OPT_OUTS }), 'webview');
		});

		it('records when the full page showed, and the first 4.x start', async () => {
			const now = new Date(2026, 9, 1);
			const free = makeFakeContext();
			await newDatastores.showNewDatastoresNotice(free, '4.0.0', { now });
			assert.strictEqual(free.store.get(newDatastores.FULL_PAGE_SHOWN_AT_KEY), now.getTime());
			assert.strictEqual(free.store.get(newDatastores.FIRST_START_AT_KEY), now.getTime());

			const pro = makeFakeContext();
			await newDatastores.showNewDatastoresNotice(pro, '4.0.0', { now, hasLicense: true });
			assert.strictEqual(pro.store.has(newDatastores.FULL_PAGE_SHOWN_AT_KEY), false, 'a toast is not a full page');
			await newDatastores.showNewDatastoresNotice(pro, '4.0.1', { now: new Date(now.getTime() + DAY_MS) });
			assert.strictEqual(pro.store.get(newDatastores.FIRST_START_AT_KEY), now.getTime(), 'keeps the first start');

			const old = makeFakeContext();
			await newDatastores.showNewDatastoresNotice(old, '3.2.0', { now });
			assert.strictEqual(old.store.has(newDatastores.FIRST_START_AT_KEY), false);
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

		it('needs a DDEV workspace, and respects the fewer-notifications settings and an old dismissal from the opt-out date', async () => {
			assert.ok(!shouldShow(makeFakeContext(), false));
			assert.ok(!devWorkspacePro.shouldShowDevWorkspaceProNotice(makeFakeContext(), true, true, AFTER_OPT_OUTS));
			assert.ok(!devWorkspacePro.shouldShowDevWorkspaceProNotice(makeFakeContext({ 'devworkspacepro.notice.dismissed': true }), true, false, AFTER_OPT_OUTS));

			const ddevRoot = makeDdevWorkspace();
			settings.dontShowNewVersionMessage = true;
			assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForDdevWorkspaces(makeFakeContext(), false, { now: AFTER_OPT_OUTS }), false);
			fs.rmSync(ddevRoot, { recursive: true, force: true });
		});

		it('ignores the fewer-notifications settings and an old dismissal before the opt-out date', async () => {
			assert.ok(devWorkspacePro.shouldShowDevWorkspaceProNotice(makeFakeContext({ 'devworkspacepro.notice.dismissed': true }), true, true, BEFORE_OPT_OUTS));

			const ddevRoot = makeDdevWorkspace();
			settings.dontShowNewVersionMessage = true;
			assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForDdevWorkspaces(makeFakeContext({ 'devworkspacepro.notice.dismissed': true }), false, { now: BEFORE_OPT_OUTS }), true);
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

	describe('full-page notice opt-out date', () => {
		it('honors opt-outs from 2026-12-25 local time, not before', () => {
			assert.strictEqual(optOuts.HONOR_FULL_PAGE_NOTICE_OPT_OUTS_FROM, '2026-12-25');
			assert.strictEqual(optOuts.honorsFullPageNoticeOptOuts(new Date(2026, 9, 1)), false);
			assert.strictEqual(optOuts.honorsFullPageNoticeOptOuts(BEFORE_OPT_OUTS), false);
			assert.strictEqual(optOuts.honorsFullPageNoticeOptOuts(AFTER_OPT_OUTS), true);
			assert.strictEqual(optOuts.honorsFullPageNoticeOptOuts(new Date(2027, 5, 1)), true);
		});
	});

	describe('DevWorkspace Pro showcase for PHP and other projects without DDEV', () => {
		const t0 = new Date(2026, 9, 1).getTime();
		const at = (days: number) => new Date(t0 + days * DAY_MS);
		const shown = (extra: Record<string, any> = {}) => makeFakeContext({ [newDatastores.FULL_PAGE_SHOWN_AT_KEY]: t0, ...extra });
		const shouldShow = (context: any, variant: string | undefined = 'php', fewer = false, now = at(7)) => devWorkspacePro.shouldShowFollowUpNotice(context, variant, fewer, now);

		it('targets composer.json or artisan projects without .ddev', () => {
			const root = makeWorkspace();
			const workspace = require('../../../services/workspace');
			assert.strictEqual(workspace.isPhpProjectWithoutDdev(), false, 'not a PHP project');
			fs.writeFileSync(path.join(root, 'artisan'), '');
			assert.strictEqual(workspace.isPhpProjectWithoutDdev(), true);
			fs.rmSync(path.join(root, 'artisan'));
			fs.writeFileSync(path.join(root, 'composer.json'), '{}');
			assert.strictEqual(workspace.isPhpProjectWithoutDdev(), true);
			assert.strictEqual(devWorkspacePro.getFollowUpNoticeVariant(), 'php');
			fs.mkdirSync(path.join(root, '.ddev'));
			assert.strictEqual(workspace.isPhpProjectWithoutDdev(), false, 'DDEV projects get the DDEV showcase');
			assert.strictEqual(devWorkspacePro.getFollowUpNoticeVariant(), undefined);
			fs.rmSync(root, { recursive: true, force: true });
		});

		it('targets Git repositories and Node, Python, Go, Ruby or Rust projects without PHP or .ddev', () => {
			const workspace = require('../../../services/workspace');
			const empty = makeWorkspace();
			assert.strictEqual(workspace.isNonPhpProjectWithoutDdev(), false, 'an empty folder is not a project');
			assert.strictEqual(devWorkspacePro.getFollowUpNoticeVariant(), undefined);
			fs.rmSync(empty, { recursive: true, force: true });

			for (const marker of ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Gemfile', 'Cargo.toml']) {
				const root = makeWorkspace();
				if (marker === '.git') fs.mkdirSync(path.join(root, marker)); else fs.writeFileSync(path.join(root, marker), '');
				assert.strictEqual(workspace.isNonPhpProjectWithoutDdev(), true, marker);
				assert.strictEqual(devWorkspacePro.getFollowUpNoticeVariant(), 'any-project', marker);

				fs.writeFileSync(path.join(root, 'composer.json'), '{}');
				assert.strictEqual(workspace.isNonPhpProjectWithoutDdev(), false, `${marker} + composer.json is PHP`);
				assert.strictEqual(devWorkspacePro.getFollowUpNoticeVariant(), 'php');
				fs.rmSync(path.join(root, 'composer.json'));

				fs.mkdirSync(path.join(root, '.ddev'));
				assert.strictEqual(workspace.isNonPhpProjectWithoutDdev(), false, `${marker} + .ddev gets the DDEV showcase`);
				fs.rmSync(root, { recursive: true, force: true });
			}
		});

		for (const variant of ['php', 'any-project']) {
			describe(`${variant} gating`, () => {
				it('waits 7 days after the DevDb v4 full page', () => {
					assert.ok(!shouldShow(shown(), variant, false, at(6.99)));
					assert.ok(shouldShow(shown(), variant, false, at(7)));
					assert.ok(!devWorkspacePro.shouldShowFollowUpNotice(shown(), undefined, false, at(7)), 'no matching workspace');
				});

				it('waits 7 days after the first 4.x start when DevDb v4 was a toast, and never without either', () => {
					assert.ok(!shouldShow(makeFakeContext({ [newDatastores.FIRST_START_AT_KEY]: t0 }), variant, false, at(6)));
					assert.ok(shouldShow(makeFakeContext({ [newDatastores.FIRST_START_AT_KEY]: t0 }), variant, false, at(7)));
					assert.ok(!shouldShow(makeFakeContext(), variant, false, at(400)));
				});

				it('shows once per release, whatever variant the user saw', () => {
					for (const key of [devWorkspacePro.NOTICE_CONTENT_VERSION_KEY, devWorkspacePro.PHP_NOTICE_CONTENT_VERSION_KEY, devWorkspacePro.ANY_PROJECT_NOTICE_CONTENT_VERSION_KEY, devWorkspacePro.LEGACY_PHP_NOTICE_CONTENT_VERSION_KEY]) {
						assert.ok(!shouldShow(shown({ [key]: '2026-10' }), variant), `seen via ${key}`);
						assert.ok(shouldShow(shown({ [key]: '2025-01' }), variant), `old content in ${key}`);
					}
					assert.ok(!shouldShow(shown({ [devWorkspacePro.ADVERTISED_RELEASE_KEY]: devWorkspacePro.DEVWORKSPACEPRO_RELEASE }), variant));
					assert.ok(shouldShow(shown({ [devWorkspacePro.ADVERTISED_RELEASE_KEY]: 'v1' }), variant));
				});

				it('ignores opt-outs before 2026-12-25 and honors them from then on', () => {
					const dismissed = { [devWorkspacePro.NOTICE_DISMISSED_KEY]: true };
					assert.ok(shouldShow(shown(dismissed), variant, true, BEFORE_OPT_OUTS));
					assert.ok(!shouldShow(shown(), variant, true, AFTER_OPT_OUTS));
					assert.ok(!shouldShow(shown(dismissed), variant, false, AFTER_OPT_OUTS));
					assert.ok(shouldShow(shown(), variant, false, AFTER_OPT_OUTS));
				});
			});
		}

		for (const [variant, makeRoot, viewType] of [
			['php', makePhpWorkspace, 'devworkspacepro-php-notice'],
			['any-project', makeGitWorkspace, 'devworkspacepro-any-project-notice'],
		] as const) {
			it(`${variant}: stays pending when another full-page promo showed this launch, then records the release`, async () => {
				const root = makeRoot();
				const context = shown();
				assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForOtherWorkspaces(context, false, { fullPagePromoShownThisLaunch: true, now: at(8) }), false);
				assert.strictEqual(context.store.size, 1, 'nothing stored');
				assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForOtherWorkspaces(context, false, { now: at(8) }), true);
				assert.strictEqual(context.store.get(devWorkspacePro.ADVERTISED_RELEASE_KEY), devWorkspacePro.DEVWORKSPACEPRO_RELEASE);
				assert.strictEqual(context.store.get(devWorkspacePro.NOTICE_VARIANTS[variant].contentVersionKey), devWorkspacePro.NOTICE_VARIANTS[variant].contentVersion);
				assert.strictEqual(context.pendingUpdates.length, 0, 'globalState.update must be awaited');
				assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForOtherWorkspaces(context, false, { now: at(9) }), false);
				await flushTimers();
				assert.deepStrictEqual(createdPanels, [viewType]);
				fs.rmSync(root, { recursive: true, force: true });
			});
		}

		it('one showcase per release across all three variants', async () => {
			// Seen in a Git repository first: no PHP or DDEV showcase later.
			const context = shown();
			const git = makeGitWorkspace();
			assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForOtherWorkspaces(context, false, { now: at(8) }), true);
			fs.rmSync(git, { recursive: true, force: true });

			const php = makePhpWorkspace();
			assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForOtherWorkspaces(context, false, { now: at(9) }), false);
			fs.rmSync(php, { recursive: true, force: true });

			const ddev = makeDdevWorkspace();
			assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForDdevWorkspaces(context, false, { now: at(10) }), false);
			fs.rmSync(ddev, { recursive: true, force: true });

			// Seen in a DDEV project first: no other showcase later.
			const other = shown();
			const ddev2 = makeDdevWorkspace();
			assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForDdevWorkspaces(other, false, { now: at(1) }), true);
			fs.rmSync(ddev2, { recursive: true, force: true });
			for (const makeRoot of [makePhpWorkspace, makeGitWorkspace]) {
				const root = makeRoot();
				assert.strictEqual(await devWorkspacePro.showDevWorkspaceProNoticeForOtherWorkspaces(other, false, { now: at(30) }), false);
				fs.rmSync(root, { recursive: true, force: true });
			}

			await flushTimers();
			assert.deepStrictEqual(createdPanels, ['devworkspacepro-any-project-notice', 'devworkspacepro-notice']);
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

		for (const [kind, makeRoot, viewType] of [
			['PHP projects', makePhpWorkspace, 'devworkspacepro-php-notice'],
			['other code projects', makeGitWorkspace, 'devworkspacepro-any-project-notice'],
		] as const) it(`${kind} without DDEV: DevDb v4 first, the showcase on a start 7 days later, one full page per start`, async () => {
			const root = makeRoot();
			const context = makeFakeContext({ 'devdb-version': '3.1.0' });

			await welcome.showWelcomeMessage(context, false);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, ['devdb-new-datastores-notice']);

			createdPanels.length = 0;
			await welcome.showWelcomeMessage(context, false);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, [], 'too soon after the DevDb v4 notice');

			// A week later.
			context.store.set(newDatastores.FULL_PAGE_SHOWN_AT_KEY, Date.now() - 7 * DAY_MS);
			await welcome.showWelcomeMessage(context, false);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, [viewType]);

			createdPanels.length = 0;
			await welcome.showWelcomeMessage(context, false);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, []);

			fs.rmSync(root, { recursive: true, force: true });
		});

		for (const makeRoot of [makePhpWorkspace, makeGitWorkspace]) it(`never shows the ${makeRoot.name} showcase on the start that shows DevDb v4`, async () => {
			const root = makeRoot();
			// The wait from the first 4.x start has passed, but the v4 notice is still pending.
			const context = makeFakeContext({ 'devdb-version': '3.1.0', [newDatastores.FIRST_START_AT_KEY]: Date.now() - 30 * DAY_MS });
			await welcome.showWelcomeMessage(context, false);
			await flushTimers();
			assert.deepStrictEqual(createdPanels, ['devdb-new-datastores-notice']);
			fs.rmSync(root, { recursive: true, force: true });
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
			['devworkspacepro (PHP)', (nonce: string) => devWorkSpaceProHtml(nonce, false, 'php')],
			['devworkspacepro (any project)', (nonce: string) => devWorkSpaceProHtml(nonce, false, 'any-project')],
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

		it('every DevWorkspace Pro template exists and embeds its mocks', () => {
			for (const { template: file } of Object.values(devWorkspacePro.NOTICE_VARIANTS) as any[]) {
				const template = fs.readFileSync(path.join(extensionPath, 'resources/notices', file), 'utf8');
				assert.ok([...template.matchAll(/\{\{include:([^}]+)\}\}/g)].length >= 6, file);
			}
			const template = fs.readFileSync(path.join(extensionPath, 'resources/notices', devWorkspacePro.NOTICE_TEMPLATE), 'utf8');
			const includes = [...template.matchAll(/\{\{include:([^}]+)\}\}/g)].map(match => match[1]);
			assert.ok(includes.length >= 2);
			const page = devWorkSpaceProHtml(html.getNonce(), false);
			assert.ok(page.includes('mock-ui'));
			assert.ok(!page.includes('data-tab'), 'no tabs');
		});

		it('the DevWorkspace Pro deck leads with AI sessions, then Scratchpad, Git Changes and the file editor', () => {
			const page = devWorkSpaceProHtml(html.getNonce(), false);
			assert.match(page, /class="key key-letter">J</);
			const titles = [...page.matchAll(/data-deck-item><strong>([^<]+)<\/strong>/g)].map(match => match[1]);
			assert.deepStrictEqual(titles.slice(0, 4), ['AI sessions', 'Scratchpad', 'Git Changes', 'File editor']);
			assert.ok(!titles.includes('Session resume'), 'resume is part of AI sessions');
		});

		it('the DevWorkspace Pro deck has one window per strip item', () => {
			const page = devWorkSpaceProHtml(html.getNonce(), false);
			const tabs = [...page.matchAll(/role="tab" aria-selected="(?:true|false)" aria-controls="([^"]+)"/g)].map(match => match[1]);
			const cards = [...page.matchAll(/<figure class="win [^"]*" id="([^"]+)"[^>]*data-deck-card/g)].map(match => match[1]);
			assert.strictEqual(tabs.length, 6);
			assert.deepStrictEqual(cards, tabs);
			assert.strictEqual((page.match(/aria-selected="true"/g) || []).length, 1);
		});

		it('the deck honors reduced motion', () => {
			const script = fs.readFileSync(path.join(extensionPath, 'resources/notices/notice.js'), 'utf8');
			const css = fs.readFileSync(path.join(extensionPath, 'resources/notices/devworkspacepro/notice.css'), 'utf8');
			assert.ok(script.includes("matchMedia('(prefers-reduced-motion: reduce)')"));
			const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
			assert.match(reduced, /\.win[^{]*\{[^}]*transition: none/);
			assert.match(reduced, /\.tab\.is-running::after \{ animation: none; \}/);
		});

		it('the DevWorkspace Pro hero names v2 and says it is a desktop app', () => {
			const page = devWorkSpaceProHtml(html.getNonce(), false);
			const hero = page.slice(page.indexOf('<section class="hero">'), page.indexOf('<div class="visual"'));
			assert.ok(hero.includes('DevWorkspace Pro v2'));
			assert.ok(/desktop/i.test(hero));
			assert.ok(page.includes('v2.0.0') && !page.includes('v1.2.63'), 'mock status bar shows v2.0.0');
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

		it('notice styles use no linear gradients or gradient text, and glass only on the v4 numeral', () => {
			for (const file of ['v4/notice.css', 'devworkspacepro/notice.css', 'devworkspacepro/terminal.css']) {
				const css = fs.readFileSync(path.join(extensionPath, 'resources/notices', file), 'utf8');
				assert.ok(!/(linear|conic)-gradient\(|background-clip:\s*text/i.test(css), `${file} uses a gradient`);
				for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
					if (/backdrop-filter/i.test(body)) {
						assert.strictEqual(`${file} ${selector.trim()}`, 'v4/notice.css .eight-plate', 'glass is allowed on the v4 numeral only');
					}
				}
			}
		});

		it('the DevDb v4 notice leads the engine strip with the number 8', () => {
			const page: string = newDatastores.getNoticeHtml(webview, html.getNonce(), extensionPath);
			assert.ok(page.includes('<span class="eight-plate">8</span>'));
			assert.ok(page.includes('8 new engines.'));
			assert.ok(!/Eight new engines/i.test(page));
		});

		const deckTitles = (page: string) => [...page.matchAll(/data-deck-item><strong>([^<]+)<\/strong>/g)].map(match => match[1]);
		const assertOneWindowPerItem = (page: string) => {
			const tabs = [...page.matchAll(/role="tab" aria-selected="(?:true|false)" aria-controls="([^"]+)"/g)].map(match => match[1]);
			const cards = [...page.matchAll(/<figure class="win [^"]*" id="([^"]+)"[^>]*data-deck-card/g)].map(match => match[1]);
			assert.deepStrictEqual(cards, tabs);
			assert.strictEqual((page.match(/aria-selected="true"/g) || []).length, 1);
		};
		const heroOf = (page: string) => page.slice(page.indexOf('<section class="hero">'), page.indexOf('<div class="visual"'));
		const variantTitle = (variant: string, isNewInstall = false) => devWorkspacePro.NOTICE_VARIANTS[variant].title(isNewInstall);

		for (const variant of ['ddev', 'php', 'any-project']) {
			it(`the ${variant} showcase sends GitHub issues and Focus Pad tasks to AI`, () => {
				const page = devWorkSpaceProHtml(html.getNonce(), false, variant);
				assert.ok(page.includes('<strong>GitHub and Focus Pad to AI</strong><span>Send a GitHub issue or a Focus Pad task to your AI session.</span>'));
				assert.ok(!page.includes('Issues and tasks to AI'));
				assert.ok(page.includes('Send to AI') && page.includes('Add to Focus Pad'), 'the deck shows both actions');
			});

			it(`the ${variant} showcase names v2, the desktop app, and the offer under the CTA`, () => {
				const hero = heroOf(devWorkSpaceProHtml(html.getNonce(), false, variant));
				assert.ok(hero.includes('DevWorkspace Pro v2 · For Mac, Windows and Linux'));
				assert.ok(hero.includes('One desktop app.'));
				assert.ok(hero.includes('data-command="copyCode"') && hero.includes(devWorkspacePro.getOffer(false).discountCode));
			});
		}

		for (const variant of ['php', 'any-project']) {
			it(`the ${variant} showcase and its tab title never mention DDEV`, () => {
				const page = devWorkSpaceProHtml(html.getNonce(), false, variant);
				const text = page.replace(/<[^>]+>/g, ' ');
				assert.ok(!/ddev/i.test(text), 'no DDEV in the copy');
				assert.ok(!/ddev/i.test(page.replace(/devworkspacepro\/[^"]+/g, '')), 'no DDEV anywhere in the page');
				assert.ok(!/ddev/i.test(variantTitle(variant)) && !/ddev/i.test(variantTitle(variant, true)));
				assert.ok(!/one click/i.test(page), 'DevWorkspace Pro has no one-click move to DDEV');
			});
		}

		it('the PHP showcase leads with AI sessions, one window per strip item', () => {
			const page = devWorkSpaceProHtml(html.getNonce(), false, 'php');
			assert.ok(/desktop app/i.test(heroOf(page)));
			assert.deepStrictEqual(deckTitles(page), ['AI sessions', 'Git Changes', 'File editor', 'Terminal', 'GitHub and Focus Pad to AI', 'Voice-to-Text']);
			assert.ok(page.includes('PHP IntelliSense'));
			assertOneWindowPerItem(page);
		});

		it('the any-project showcase leads with AI sessions, then GitHub and Focus Pad, one window per strip item', () => {
			const page = devWorkSpaceProHtml(html.getNonce(), false, 'any-project');
			assert.deepStrictEqual(deckTitles(page), ['AI sessions', 'GitHub and Focus Pad to AI', 'Git Changes', 'Terminal', 'Voice-to-Text', 'File editor']);
			assert.match(page, /AI sessions<\/strong><span>.*Resume after a restart/);
			assertOneWindowPerItem(page);
		});

		it('the any-project showcase shows a TypeScript project and claims no PHP features', () => {
			const page = devWorkSpaceProHtml(html.getNonce(), false, 'any-project');
			for (const phpOnly of ['.php', 'PHP', 'IntelliSense', 'composer', 'artisan', 'Herd', 'Laravel', 'Scratchpad', 'fe-suggest']) {
				assert.ok(!page.includes(phpOnly), `any-project page shows ${phpOnly}`);
			}
			assert.ok(page.includes('invoices.ts') && page.includes('package.json') && page.includes('npm test'));
		});

		it('the PHP and any-project mocks show an imported project as the app does', () => {
			const read = (file: string) => fs.readFileSync(path.join(extensionPath, 'resources/notices/devworkspacepro/mocks', file), 'utf8');
			for (const file of ['overview-imported.html', 'overview-any-project.html']) {
				const overview = read(file);
				const tabs = [...overview.matchAll(/rounded-md px-3 text-sm font-medium">\s*([A-Za-z ]+?)\s*</g)].map(match => match[1]);
				// ProjectDetails.vue: allProjectTabs minus ddevExclusiveTabs.
				assert.deepStrictEqual(tabs, ['Overview', 'Terminal', 'Files', 'Git Changes', 'GitHub', 'Monitoring', 'Recipes'], file);
				for (const ddevOnly of ['RUNNING', 'Stop', 'Restart', 'Share', 'Start All', 'Quick Actions', 'phpMyAdmin', 'Mailpit', 'PHP Version', '>Laravel<']) {
					assert.ok(!overview.includes(ddevOnly), `${file}: external projects do not show ${ddevOnly}`);
				}
				assert.ok(overview.includes('New AI session'), 'the AI session button shows for every project');
			}
			assert.ok(read('status-bar-imported.html').includes('None running'), 'the footer counts DDEV projects only');
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

function devWorkSpaceProHtml(nonce: string, isNewInstall: boolean, variant: string = 'ddev'): string {
	return devWorkspacePro.getNoticeHtml({ cspSource: 'vscode-resource:', asWebviewUri }, nonce, extensionPath, isNewInstall, variant);
}

function makeWorkspace(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devdb-ws-'));
	workspaceFolders = [{ uri: { fsPath: root } }];
	return root;
}

function makePhpWorkspace(): string {
	const root = makeWorkspace();
	fs.writeFileSync(path.join(root, 'composer.json'), '{}');
	return root;
}

function makeGitWorkspace(): string {
	const root = makeWorkspace();
	fs.mkdirSync(path.join(root, '.git'));
	fs.writeFileSync(path.join(root, 'package.json'), '{}');
	return root;
}

function makeDdevWorkspace(): string {
	const ddevRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devdb-ddev-'));
	fs.mkdirSync(path.join(ddevRoot, '.ddev'));
	workspaceFolders = [{ uri: { fsPath: ddevRoot } }];
	return ddevRoot;
}
