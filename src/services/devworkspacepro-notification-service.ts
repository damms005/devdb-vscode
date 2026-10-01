import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce, NOTICES_FOLDER, NoticeWebview, renderNoticeTemplate } from './html';
import { FIRST_START_AT_KEY, FULL_PAGE_SHOWN_AT_KEY, userWantsFewerNotifications } from './new-datastores-notification-service';
import { honorsFullPageNoticeOptOuts } from './notice-opt-outs';
import { isDdevProject, isPhpProjectWithoutDdev } from './workspace';

/**
 * Version of the showcase content. Bump it when the showcase changes: each
 * content version shows once, whatever the DevDb version.
 */
export const NOTICE_CONTENT_VERSION = '2026-10';
export const NOTICE_CONTENT_VERSION_KEY = 'devworkspacepro.notice.contentVersion';
/** Content version of the showcase for PHP projects without DDEV. */
export const NON_DDEV_NOTICE_CONTENT_VERSION = '2026-10';
export const NON_DDEV_NOTICE_CONTENT_VERSION_KEY = 'devworkspacepro.nonDdevNotice.contentVersion';
/** Days between the DevDb v4 notice (or the first 4.x start) and the non-DDEV showcase. */
export const NON_DDEV_NOTICE_WAIT_DAYS = 7;
/** Set by earlier builds when the user dismissed the notice for good. */
export const NOTICE_DISMISSED_KEY = 'devworkspacepro.notice.dismissed';
const DELAY_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const NOTICE_TEMPLATE = 'devworkspacepro/notice.html';
export const NON_DDEV_NOTICE_TEMPLATE = 'devworkspacepro/notice-non-ddev.html';
export const PRICING_URL = 'https://devworkspacepro.com/?ref=ide#pricing';
export const LEARN_MORE_URL = 'https://devworkspacepro.com/?ref=ide';
export const DOCS_URL = 'https://docs.devworkspacepro.com';

export type DevWorkspaceProNoticeVariant = 'ddev' | 'non-ddev';

interface ShowOptions {
    /** A full-page promo was already shown on this launch: stay pending for a later launch. */
    fullPagePromoShownThisLaunch?: boolean;
    now?: Date;
}

/**
 * Shows the DevWorkspace Pro showcase in DDEV workspaces, once per content version.
 * Returns true when the notice will show on this launch.
 */
export async function showDevWorkspaceProNoticeForDdevWorkspaces(
    context: vscode.ExtensionContext,
    isNewInstall: boolean = false,
    options: ShowOptions = {},
): Promise<boolean> {
    if (options.fullPagePromoShownThisLaunch) {
        return false;
    }

    if (!shouldShowDevWorkspaceProNotice(context, isDdevProject(), userWantsFewerNotifications(), options.now)) {
        return false;
    }

    await context.globalState.update(NOTICE_CONTENT_VERSION_KEY, NOTICE_CONTENT_VERSION);

    setTimeout(() => {
        createDevWorkspaceProWebview(context, isNewInstall, 'ddev');
    }, DELAY_MS);

    return true;
}

export function shouldShowDevWorkspaceProNotice(context: vscode.ExtensionContext, isDdevWorkspace: boolean, fewerNotifications: boolean, now: Date = new Date()): boolean {
    if (!isDdevWorkspace) {
        return false;
    }

    if (optedOut(context, fewerNotifications, now)) {
        return false;
    }

    return context.globalState.get<string>(NOTICE_CONTENT_VERSION_KEY) !== NOTICE_CONTENT_VERSION;
}

/**
 * Shows the DevWorkspace Pro showcase in PHP projects without DDEV, once per content
 * version, at least NON_DDEV_NOTICE_WAIT_DAYS after the DevDb v4 notice.
 * Returns true when the notice will show on this launch.
 */
export async function showDevWorkspaceProNoticeForNonDdevWorkspaces(
    context: vscode.ExtensionContext,
    isNewInstall: boolean = false,
    options: ShowOptions = {},
): Promise<boolean> {
    if (options.fullPagePromoShownThisLaunch) {
        return false;
    }

    if (!shouldShowNonDdevNotice(context, isPhpProjectWithoutDdev(), userWantsFewerNotifications(), options.now)) {
        return false;
    }

    await context.globalState.update(NON_DDEV_NOTICE_CONTENT_VERSION_KEY, NON_DDEV_NOTICE_CONTENT_VERSION);

    setTimeout(() => {
        createDevWorkspaceProWebview(context, isNewInstall, 'non-ddev');
    }, DELAY_MS);

    return true;
}

export function shouldShowNonDdevNotice(context: vscode.ExtensionContext, isPhpWithoutDdev: boolean, fewerNotifications: boolean, now: Date = new Date()): boolean {
    if (!isPhpWithoutDdev) {
        return false;
    }

    if (optedOut(context, fewerNotifications, now)) {
        return false;
    }

    if (context.globalState.get<string>(NON_DDEV_NOTICE_CONTENT_VERSION_KEY) === NON_DDEV_NOTICE_CONTENT_VERSION) {
        return false;
    }

    // The user already saw this DevWorkspace Pro release in a DDEV project.
    if (context.globalState.get<string>(NOTICE_CONTENT_VERSION_KEY) === NOTICE_CONTENT_VERSION) {
        return false;
    }

    const waitFrom = context.globalState.get<number>(FULL_PAGE_SHOWN_AT_KEY) ?? context.globalState.get<number>(FIRST_START_AT_KEY);
    if (waitFrom === undefined) {
        return false;
    }

    return now.getTime() - waitFrom >= NON_DDEV_NOTICE_WAIT_DAYS * DAY_MS;
}

function optedOut(context: vscode.ExtensionContext, fewerNotifications: boolean, now: Date): boolean {
    if (!honorsFullPageNoticeOptOuts(now)) {
        return false;
    }

    return fewerNotifications || context.globalState.get<boolean>(NOTICE_DISMISSED_KEY, false);
}

/** Dev preview: shows the notice without any gating. */
export function previewDevWorkspaceProNotice(context: vscode.ExtensionContext, isNewInstall: boolean = false, variant: DevWorkspaceProNoticeVariant = 'ddev') {
    createDevWorkspaceProWebview(context, isNewInstall, variant);
}

function createDevWorkspaceProWebview(context: vscode.ExtensionContext, isNewInstall: boolean, variant: DevWorkspaceProNoticeVariant) {
    const title = variant === 'non-ddev'
        ? 'DevWorkspace Pro v2 - Your PHP projects, one desktop app'
        : isNewInstall ? 'Welcome to DevDb - Get DevWorkspace Pro v2' : 'DevWorkspace Pro v2 - The Best GUI for DDEV';

    const panel = vscode.window.createWebviewPanel(
        variant === 'non-ddev' ? 'devworkspacepro-non-ddev-notice' : 'devworkspacepro-notice',
        title,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: false,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, NOTICES_FOLDER))],
        }
    );

    panel.webview.html = getNoticeHtml(panel.webview, getNonce(), context.extensionPath, isNewInstall, variant);

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

export function getNoticeHtml(webview: NoticeWebview, nonce: string, extensionPath: string, isNewInstall: boolean = false, variant: DevWorkspaceProNoticeVariant = 'ddev'): string {
    const template = variant === 'non-ddev' ? NON_DDEV_NOTICE_TEMPLATE : NOTICE_TEMPLATE;
    return renderNoticeTemplate(extensionPath, webview, nonce, template, getOffer(isNewInstall));
}

export function getOffer(isNewInstall: boolean) {
    return {
        offerTitle: isNewInstall ? 'Welcome offer for DevDb users' : 'Special offer for DevDb users',
        offerText: isNewInstall ? 'Get 25% off your first yearly license.' : 'Get 30% off your first yearly license.',
        discountCode: isNewInstall ? 'GIFTFORDEVDBUSERS25' : 'LAUNCHDAYGIFTFORDEVDBUSERS',
    };
}
