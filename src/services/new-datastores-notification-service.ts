import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce, NOTICES_FOLDER, NoticeWebview, renderNoticeTemplate } from './html';
import { parseVersion } from './version';

export const NOTICE_SHOWN_KEY = 'devdb.v4.notice.shown';
/** Keys used by earlier builds; cleared by the dev preview command. */
export const LEGACY_NOTICE_KEYS = ['newDatastores.notice.shown', 'newDatastores.notice.shownForVersion', 'newDatastores.notice.dismissed'];

/** The notice announces the 4.x release line only. */
const NOTICE_MAJOR_VERSION = 4;
const DELAY_MS = 1200;

/** DevDb Pro lifetime price in USD. Keep in sync with devdb-ui ProAdvertCard `lifetimePrice`. */
export const PRO_LIFETIME_PRICE_USD = 15;

export const NOTICE_TEMPLATE = 'v4/notice.html';
export const PRO_TOAST_MESSAGE = 'DevDb 4 is here: Redis/Valkey, ClickHouse, DuckDB, DynamoDB, Turso, D1 and more are in your Pro plan.';
export const LEARN_MORE_URL = 'https://devdbpro.com/?ref=ide#features';
export const PRICING_URL = 'https://devdbpro.com/?ref=ide&pro=true#pricing';
export const DOCS_URL = 'https://docs.devdbpro.com';

export type NewDatastoresNoticeAction = 'none' | 'webview' | 'toast';

export interface NewDatastoresNoticeOptions {
	hasLicense?: boolean;
	/** A full-page promo was already shown on this launch: defer to a later launch. */
	fullPagePromoShownThisLaunch?: boolean;
	/** Dev preview: ignore the shown flag, release line and settings. */
	forcePreview?: boolean;
}

export function isNoticeReleaseLine(version: string): boolean {
	return parseVersion(version)?.core[0] === NOTICE_MAJOR_VERSION;
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
 * Shows the DevDb 4 launch notice at most once, only on the 4.x line.
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
		"What's new in DevDb 4",
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: false,
			localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, NOTICES_FOLDER))],
		},
	);

	panel.webview.html = getNoticeHtml(panel.webview, getNonce(), context.extensionPath);

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
				case 'docs':
					vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
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

export function getNoticeHtml(webview: NoticeWebview, nonce: string, extensionPath: string): string {
	return renderNoticeTemplate(extensionPath, webview, nonce, NOTICE_TEMPLATE, { price: PRO_LIFETIME_PRICE_USD });
}
