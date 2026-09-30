import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce, NOTICES_FOLDER, NoticeWebview, renderNoticeTemplate } from './html';
import { userWantsFewerNotifications } from './new-datastores-notification-service';
import { isDdevProject } from './workspace';

/**
 * Version of the showcase content. Bump it when the showcase changes: each
 * content version shows once, whatever the DevDb version.
 */
export const NOTICE_CONTENT_VERSION = '2026-10';
export const NOTICE_CONTENT_VERSION_KEY = 'devworkspacepro.notice.contentVersion';
/** Set by earlier builds when the user dismissed the notice for good. */
const NOTICE_DISMISSED_KEY = 'devworkspacepro.notice.dismissed';
const DELAY_MS = 1000;

export const NOTICE_TEMPLATE = 'devworkspacepro/notice.html';
export const PRICING_URL = 'https://devworkspacepro.com/?ref=ide#pricing';
export const LEARN_MORE_URL = 'https://devworkspacepro.com/?ref=ide';
export const DOCS_URL = 'https://docs.devworkspacepro.com';

/**
 * Shows the DevWorkspace Pro showcase in DDEV workspaces, once per content version.
 * Returns true when the notice will show on this launch.
 */
export async function showDevWorkspaceProNoticeForDdevWorkspaces(
    context: vscode.ExtensionContext,
    isNewInstall: boolean = false,
    options: { fullPagePromoShownThisLaunch?: boolean } = {},
): Promise<boolean> {
    // Another full-page promo showed on this launch: stay pending for a later launch.
    if (options.fullPagePromoShownThisLaunch) {
        return false;
    }

    if (!shouldShowDevWorkspaceProNotice(context, isDdevProject(), userWantsFewerNotifications())) {
        return false;
    }

    await context.globalState.update(NOTICE_CONTENT_VERSION_KEY, NOTICE_CONTENT_VERSION);

    setTimeout(() => {
        createDevWorkspaceProWebview(context, isNewInstall);
    }, DELAY_MS);

    return true;
}

export function shouldShowDevWorkspaceProNotice(context: vscode.ExtensionContext, isDdevWorkspace: boolean, fewerNotifications: boolean): boolean {
    if (!isDdevWorkspace || fewerNotifications) {
        return false;
    }

    if (context.globalState.get<boolean>(NOTICE_DISMISSED_KEY, false)) {
        return false;
    }

    return context.globalState.get<string>(NOTICE_CONTENT_VERSION_KEY) !== NOTICE_CONTENT_VERSION;
}

/** Dev preview: shows the notice without any gating. */
export function previewDevWorkspaceProNotice(context: vscode.ExtensionContext, isNewInstall: boolean = false) {
    createDevWorkspaceProWebview(context, isNewInstall);
}

function createDevWorkspaceProWebview(context: vscode.ExtensionContext, isNewInstall: boolean = false) {
    const panel = vscode.window.createWebviewPanel(
        'devworkspacepro-notice',
        isNewInstall ? 'Welcome to DevDb - Get DevWorkspace Pro v2' : 'DevWorkspace Pro v2 - The Best GUI for DDEV',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: false,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, NOTICES_FOLDER))],
        }
    );

    panel.webview.html = getNoticeHtml(panel.webview, getNonce(), context.extensionPath, isNewInstall);

    panel.iconPath = {
        light: vscode.Uri.file(context.asAbsolutePath('resources/devdb.png')),
        dark: vscode.Uri.file(context.asAbsolutePath('resources/devdb.png'))
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
                case 'docs':
                    vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
                    break;
                case 'copyCode':
                    vscode.env.clipboard.writeText(getOffer(isNewInstall).discountCode);
                    break;
                case 'close':
                    panel.dispose();
                    break;
            }
        },
        undefined,
        context.subscriptions
    );
}

export function getNoticeHtml(webview: NoticeWebview, nonce: string, extensionPath: string, isNewInstall: boolean = false): string {
    return renderNoticeTemplate(extensionPath, webview, nonce, NOTICE_TEMPLATE, getOffer(isNewInstall));
}

export function getOffer(isNewInstall: boolean) {
    return {
        offerTitle: isNewInstall ? 'Welcome offer for DevDb users' : 'Special offer for DevDb users',
        offerText: isNewInstall ? 'Get 25% off your first yearly license.' : 'Get 30% off your first yearly license.',
        discountCode: isNewInstall ? 'GIFTFORDEVDBUSERS25' : 'LAUNCHDAYGIFTFORDEVDBUSERS',
    };
}
