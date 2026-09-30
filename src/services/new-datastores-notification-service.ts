import * as vscode from 'vscode';
import { buildNoticeCsp, getNonce } from './html';
import { parseVersion } from './welcome-message-service';

export const NOTICE_SHOWN_KEY = 'newDatastores.notice.shown';
/** Keys used by earlier builds; cleared by the dev preview command. */
export const LEGACY_NOTICE_KEYS = ['newDatastores.notice.shownForVersion', 'newDatastores.notice.dismissed'];

/** The notice announces datastores added in this release line only. */
const NOTICE_RELEASE_LINE: [number, number] = [3, 2];
const DELAY_MS = 1200;

export const PRO_TOAST_MESSAGE = '5 new datastores are in your Pro plan';
const LEARN_MORE_URL = 'https://devdbpro.com/?ref=ide#features';
const PRICING_URL = 'https://devdbpro.com/?ref=ide#pricing';

export type NewDatastoresNoticeAction = 'none' | 'webview' | 'toast';

export interface NewDatastoresNoticeOptions {
	hasLicense?: boolean;
	/** A full-page promo was already shown on this launch: defer to a later launch. */
	fullPagePromoShownThisLaunch?: boolean;
	/** Dev preview: ignore the shown flag, release line and settings. */
	forcePreview?: boolean;
}

export function isNoticeReleaseLine(version: string): boolean {
	const parsed = parseVersion(version);
	return !!parsed && parsed.core[0] === NOTICE_RELEASE_LINE[0] && parsed.core[1] === NOTICE_RELEASE_LINE[1];
}

export function userWantsFewerNotifications(): boolean {
	const config = vscode.workspace.getConfiguration('Devdb');
	return config.get<boolean>('showFewerUpdateNotificationActions', false)
		|| config.get<boolean>('dontShowNewVersionMessage', false);
}

/**
 * Decides what (if anything) to show. Reads `globalState` only.
 */
export function getNewDatastoresNoticeAction(
	context: vscode.ExtensionContext,
	version: string,
	options: NewDatastoresNoticeOptions & { fewerNotifications?: boolean } = {},
): NewDatastoresNoticeAction {
	const kind: NewDatastoresNoticeAction = options.hasLicense ? 'toast' : 'webview';

	if (options.forcePreview) {
		return kind;
	}

	if (context.globalState.get<boolean>(NOTICE_SHOWN_KEY, false)) {
		return 'none';
	}

	if (!isNoticeReleaseLine(version)) {
		return 'none';
	}

	if (kind === 'webview' && (options.fewerNotifications || options.fullPagePromoShownThisLaunch)) {
		return 'none';
	}

	return kind;
}

/**
 * Shows the "5 new datastores" notice at most once, only on the 3.2.x line.
 * Free users get a full-page webview, licensed users a short toast.
 */
export async function showNewDatastoresNotice(
	context: vscode.ExtensionContext,
	version: string,
	options: NewDatastoresNoticeOptions = {},
): Promise<NewDatastoresNoticeAction> {
	const action = getNewDatastoresNoticeAction(context, version, {
		...options,
		fewerNotifications: options.forcePreview ? false : userWantsFewerNotifications(),
	});

	if (action === 'none') {
		return action;
	}

	await context.globalState.update(NOTICE_SHOWN_KEY, true);

	if (action === 'toast') {
		showProToast();
		return action;
	}

	setTimeout(() => {
		createNewDatastoresWebview(context);
	}, options.forcePreview ? 0 : DELAY_MS);

	return action;
}

/** Clears the notice state so the dev preview command can show it again. */
export async function resetNewDatastoresNotice(context: vscode.ExtensionContext): Promise<void> {
	for (const key of [NOTICE_SHOWN_KEY, ...LEGACY_NOTICE_KEYS]) {
		await context.globalState.update(key, undefined);
	}
}

function showProToast() {
	vscode.window.showInformationMessage(PRO_TOAST_MESSAGE, 'Learn More').then(choice => {
		if (choice === 'Learn More') {
			vscode.env.openExternal(vscode.Uri.parse(LEARN_MORE_URL));
		}
	});
}

function createNewDatastoresWebview(context: vscode.ExtensionContext) {
	const panel = vscode.window.createWebviewPanel(
		'devdb-new-datastores-notice',
		'New in DevDb — 5 New Databases',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: false,
			localResourceRoots: [],
		},
	);

	panel.webview.html = getNoticeHtml(panel.webview.cspSource, getNonce());

	panel.iconPath = {
		light: vscode.Uri.file(context.asAbsolutePath('resources/devdb.png')),
		dark: vscode.Uri.file(context.asAbsolutePath('resources/devdb.png')),
	};

	panel.webview.onDidReceiveMessage(
		message => {
			switch (message.command) {
				case 'getLicense':
					vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
					panel.dispose();
					break;
				case 'learnMore':
					vscode.env.openExternal(vscode.Uri.parse(LEARN_MORE_URL));
					break;
				case 'close':
					panel.dispose();
					break;
			}
		},
		undefined,
		context.subscriptions,
	);
}

export function getNoticeHtml(cspSource: string, nonce: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${buildNoticeCsp(cspSource, nonce)}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>New in DevDb — 5 New Databases</title>
	<style nonce="${nonce}">
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
			line-height: 1.6;
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
			padding: 32px;
			max-width: 820px;
			margin: 0 auto;
		}
		.header { text-align: center; margin-bottom: 32px; }
		.title {
			font-size: 2.4em;
			font-weight: 700;
			margin-bottom: 12px;
			background: linear-gradient(135deg, var(--vscode-textLink-foreground), var(--vscode-textLink-activeForeground));
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
			background-clip: text;
		}
		.subtitle { font-size: 1.15em; opacity: 0.9; }
		.features { margin: 32px 0; }
		.features h3 { font-size: 1.3em; margin-bottom: 16px; color: var(--vscode-textLink-foreground); }
		.feature {
			display: flex;
			gap: 14px;
			padding: 14px 0;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.feature .icon { font-size: 1.6em; line-height: 1.2; flex-shrink: 0; width: 38px; text-align: center; }
		.feature .name { font-weight: 600; font-size: 1.08em; }
		.feature .desc { opacity: 0.85; font-size: 0.95em; }
		.pro-pill {
			display: inline-block;
			font-size: 0.62em;
			font-weight: 700;
			letter-spacing: 0.5px;
			padding: 2px 7px;
			border-radius: 999px;
			background: var(--vscode-editorWarning-foreground, #e2a03f);
			color: #1e1e1e;
			margin-left: 8px;
			vertical-align: middle;
		}
		.banner {
			background: var(--vscode-editor-selectionBackground, rgba(173, 214, 255, 0.15));
			padding: 22px;
			border-radius: 12px;
			text-align: center;
			margin: 28px 0;
			border: 2px solid var(--vscode-focusBorder);
		}
		.banner h3 { font-size: 1.25em; margin-bottom: 6px; font-weight: 600; }
		.banner p { opacity: 0.9; }
		.cta-section { text-align: center; margin-top: 32px; }
		.btn {
			padding: 15px 30px; margin: 8px; border: none; border-radius: 8px;
			font-size: 1.05em; font-weight: 600; cursor: pointer;
			transition: all 0.25s ease; text-decoration: none; display: inline-block;
		}
		.btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.btn-primary:hover { background: var(--vscode-button-hoverBackground); transform: translateY(-2px); }
		.btn-secondary { background: transparent; color: var(--vscode-textLink-foreground); border: 2px solid var(--vscode-textLink-foreground); }
		.btn-secondary:hover { background: var(--vscode-textLink-foreground); color: var(--vscode-button-foreground); transform: translateY(-2px); }
		.btn-text { background: none; color: var(--vscode-descriptionForeground); border: none; font-size: 0.9em; padding: 8px 16px; text-decoration: underline; opacity: 0.8; cursor: pointer; }
		.btn-text:hover { opacity: 1; }
		.close-btn {
			position: absolute; top: 16px; right: 16px; background: none; border: none;
			font-size: 24px; cursor: pointer; color: var(--vscode-foreground); opacity: 0.7; padding: 4px; border-radius: 4px;
		}
		.close-btn:hover { opacity: 1; background: var(--vscode-button-secondaryBackground); }
		@media (max-width: 600px) { body { padding: 16px; } .title { font-size: 1.9em; } .btn { display: block; margin: 8px 0; } }
	</style>
</head>
<body>
	<button class="close-btn" data-command="close" aria-label="Close">×</button>

	<div class="header">
		<h1 class="title">5 New Databases in DevDb</h1>
		<p class="subtitle">AI-era datastores — embeddings, analytics, cache &amp; cloud Postgres, right inside your IDE.</p>
	</div>

	<div class="features">
		<h3>What's new</h3>

		<div class="feature">
			<div class="icon">🧬</div>
			<div>
				<div class="name">Vector search — pgvector<span class="pro-pill">PRO</span></div>
				<div class="desc">Inspect embedding columns humanely and run "find similar rows" right from a cell — in any Postgres or Neon database.</div>
			</div>
		</div>

		<div class="feature">
			<div class="icon">⚡</div>
			<div>
				<div class="name">Redis / Valkey<span class="pro-pill">PRO</span></div>
				<div class="desc">Browse keys as tables — strings, hashes, lists, sets, sorted sets and streams.</div>
			</div>
		</div>

		<div class="feature">
			<div class="icon">📊</div>
			<div>
				<div class="name">ClickHouse<span class="pro-pill">PRO</span></div>
				<div class="desc">Explore real-time analytics tables over HTTP — arrays, nullables and all.</div>
			</div>
		</div>

		<div class="feature">
			<div class="icon">🦆</div>
			<div>
				<div class="name">DuckDB<span class="pro-pill">PRO</span></div>
				<div class="desc">Open embedded analytics databases and read LIST / STRUCT / MAP columns.</div>
			</div>
		</div>

		<div class="feature">
			<div class="icon">☁️</div>
			<div>
				<div class="name">Neon<span class="pro-pill">PRO</span></div>
				<div class="desc">Connect to serverless Postgres securely over SSL.</div>
			</div>
		</div>
	</div>

	<div class="banner">
		<h3>✨ Unlock all five with DevDb Pro</h3>
		<p>One license · use on all your IDEs.</p>
	</div>

	<div class="cta-section">
		<button class="btn btn-primary" data-command="getLicense">Unlock with DevDb Pro</button>
		<button class="btn btn-secondary" data-command="learnMore">Learn More</button>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		document.querySelectorAll('[data-command]').forEach(button => {
			button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
		});
	</script>
</body>
</html>`;
}
