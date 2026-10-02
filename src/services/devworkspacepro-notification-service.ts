import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce, NOTICES_FOLDER, NoticeWebview, renderNoticeTemplate } from './html';
import { FIRST_START_AT_KEY, FULL_PAGE_SHOWN_AT_KEY, userWantsFewerNotifications } from './new-datastores-notification-service';
import { honorsFullPageNoticeOptOuts } from './notice-opt-outs';
import { isDdevProject, isNonPhpProjectWithoutDdev, isPhpProjectWithoutDdev } from './workspace';

export type DevWorkspaceProNoticeVariant = 'ddev' | 'php' | 'any-project';
/** Showcases that wait for the DevDb v4 notice: PHP projects and other code projects, both without DDEV. */
export type FollowUpNoticeVariant = Exclude<DevWorkspaceProNoticeVariant, 'ddev'>;

/**
 * Version of each showcase's content. Bump it when the showcase changes: each
 * content version shows once, whatever the DevDb version.
 */
export const NOTICE_CONTENT_VERSION = '2026-10';
export const NOTICE_CONTENT_VERSION_KEY = 'devworkspacepro.notice.contentVersion';
export const PHP_NOTICE_CONTENT_VERSION = '2026-10';
export const PHP_NOTICE_CONTENT_VERSION_KEY = 'devworkspacepro.phpNotice.contentVersion';
/** Key of the PHP showcase in earlier builds. Read as a fallback. */
export const LEGACY_PHP_NOTICE_CONTENT_VERSION_KEY = 'devworkspacepro.nonDdevNotice.contentVersion';
export const ANY_PROJECT_NOTICE_CONTENT_VERSION = '2026-10';
export const ANY_PROJECT_NOTICE_CONTENT_VERSION_KEY = 'devworkspacepro.anyProjectNotice.contentVersion';

/**
 * DevWorkspace Pro release the showcases advertise. A user sees at most one
 * showcase per release, whatever the variant. Bump it with a new release.
 */
export const DEVWORKSPACEPRO_RELEASE = 'v2';
export const ADVERTISED_RELEASE_KEY = 'devworkspacepro.notice.advertisedRelease';

/** Days between the DevDb v4 notice (or the first 4.x start) and the PHP or any-project showcase. */
export const FOLLOW_UP_NOTICE_WAIT_DAYS = 7;
/** Set by earlier builds when the user dismissed the notice for good. */
export const NOTICE_DISMISSED_KEY = 'devworkspacepro.notice.dismissed';
const DELAY_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const NOTICE_TEMPLATE = 'devworkspacepro/notice.html';
export const PHP_NOTICE_TEMPLATE = 'devworkspacepro/notice-php.html';
export const ANY_PROJECT_NOTICE_TEMPLATE = 'devworkspacepro/notice-any-project.html';
export const PRICING_URL = 'https://devworkspacepro.com/?ref=ide#pricing';
export const LEARN_MORE_URL = 'https://devworkspacepro.com/?ref=ide';
export const DOCS_URL = 'https://docs.devworkspacepro.com';

interface VariantConfig {
    contentVersion: string;
    contentVersionKey: string;
    legacyContentVersionKeys: string[];
    template: string;
    viewType: string;
    title: (isNewInstall: boolean) => string;
}

export const NOTICE_VARIANTS: Record<DevWorkspaceProNoticeVariant, VariantConfig> = {
    'ddev': {
        contentVersion: NOTICE_CONTENT_VERSION,
        contentVersionKey: NOTICE_CONTENT_VERSION_KEY,
        legacyContentVersionKeys: [],
        template: NOTICE_TEMPLATE,
        viewType: 'devworkspacepro-notice',
        title: isNewInstall => isNewInstall ? 'Welcome to DevDb - Get DevWorkspace Pro v2' : 'DevWorkspace Pro v2 - The Best GUI for DDEV',
    },
    'php': {
        contentVersion: PHP_NOTICE_CONTENT_VERSION,
        contentVersionKey: PHP_NOTICE_CONTENT_VERSION_KEY,
        legacyContentVersionKeys: [LEGACY_PHP_NOTICE_CONTENT_VERSION_KEY],
        template: PHP_NOTICE_TEMPLATE,
        viewType: 'devworkspacepro-php-notice',
        title: () => 'DevWorkspace Pro v2 - Your PHP projects, one desktop app',
    },
    'any-project': {
        contentVersion: ANY_PROJECT_NOTICE_CONTENT_VERSION,
        contentVersionKey: ANY_PROJECT_NOTICE_CONTENT_VERSION_KEY,
        legacyContentVersionKeys: [],
        template: ANY_PROJECT_NOTICE_TEMPLATE,
        viewType: 'devworkspacepro-any-project-notice',
        title: () => 'DevWorkspace Pro v2 - Your projects and agents, one desktop app',
    },
};

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

    await markShown(context, 'ddev');
    showLater(context, isNewInstall, 'ddev');

    return true;
}

export function shouldShowDevWorkspaceProNotice(context: vscode.ExtensionContext, isDdevWorkspace: boolean, fewerNotifications: boolean, now: Date = new Date()): boolean {
    if (!isDdevWorkspace) {
        return false;
    }

    if (optedOut(context, fewerNotifications, now)) {
        return false;
    }

    return !sawThisRelease(context);
}

/** The showcase that fits a workspace without DDEV: PHP projects, then any other code project. */
export function getFollowUpNoticeVariant(): FollowUpNoticeVariant | undefined {
    if (isPhpProjectWithoutDdev()) {
        return 'php';
    }

    return isNonPhpProjectWithoutDdev() ? 'any-project' : undefined;
}

/**
 * Shows the DevWorkspace Pro showcase in PHP projects and other code projects without
 * DDEV, once per release, at least FOLLOW_UP_NOTICE_WAIT_DAYS after the DevDb v4 notice.
 * Returns true when the notice will show on this launch.
 */
export async function showDevWorkspaceProNoticeForOtherWorkspaces(
    context: vscode.ExtensionContext,
    isNewInstall: boolean = false,
    options: ShowOptions = {},
): Promise<boolean> {
    if (options.fullPagePromoShownThisLaunch) {
        return false;
    }

    const variant = getFollowUpNoticeVariant();
    if (!variant || !shouldShowFollowUpNotice(context, variant, userWantsFewerNotifications(), options.now)) {
        return false;
    }

    await markShown(context, variant);
    showLater(context, isNewInstall, variant);

    return true;
}

export function shouldShowFollowUpNotice(context: vscode.ExtensionContext, variant: FollowUpNoticeVariant | undefined, fewerNotifications: boolean, now: Date = new Date()): boolean {
    if (!variant) {
        return false;
    }

    if (optedOut(context, fewerNotifications, now)) {
        return false;
    }

    if (sawThisRelease(context)) {
        return false;
    }

    const waitFrom = context.globalState.get<number>(FULL_PAGE_SHOWN_AT_KEY) ?? context.globalState.get<number>(FIRST_START_AT_KEY);
    if (waitFrom === undefined) {
        return false;
    }

    return now.getTime() - waitFrom >= FOLLOW_UP_NOTICE_WAIT_DAYS * DAY_MS;
}

/** True when the user saw a showcase for this DevWorkspace Pro release, in any variant. */
export function sawThisRelease(context: vscode.ExtensionContext): boolean {
    if (context.globalState.get<string>(ADVERTISED_RELEASE_KEY) === DEVWORKSPACEPRO_RELEASE) {
        return true;
    }

    // Builds before the release key stored only the content version of each variant.
    return Object.values(NOTICE_VARIANTS).some(({ contentVersion, contentVersionKey, legacyContentVersionKeys }) =>
        [contentVersionKey, ...legacyContentVersionKeys].some(key => context.globalState.get<string>(key) === contentVersion));
}

async function markShown(context: vscode.ExtensionContext, variant: DevWorkspaceProNoticeVariant) {
    const { contentVersionKey, contentVersion } = NOTICE_VARIANTS[variant];
    await context.globalState.update(contentVersionKey, contentVersion);
    await context.globalState.update(ADVERTISED_RELEASE_KEY, DEVWORKSPACEPRO_RELEASE);
}

function showLater(context: vscode.ExtensionContext, isNewInstall: boolean, variant: DevWorkspaceProNoticeVariant) {
    setTimeout(() => {
        createDevWorkspaceProWebview(context, isNewInstall, variant);
    }, DELAY_MS);
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
    const { viewType, title } = NOTICE_VARIANTS[variant];

    const panel = vscode.window.createWebviewPanel(
        viewType,
        title(isNewInstall),
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
    return renderNoticeTemplate(extensionPath, webview, nonce, NOTICE_VARIANTS[variant].template, getOffer(isNewInstall));
}

export function getOffer(isNewInstall: boolean) {
    return {
        offerTitle: isNewInstall ? 'Welcome offer for DevDb users' : 'Special offer for DevDb users',
        offerDiscount: isNewInstall ? '25% off' : '30% off',
        offerText: 'your first yearly license.',
        discountCode: isNewInstall ? 'GIFTFORDEVDBUSERS25' : 'DEVDBUSERSPROMO',
    };
}
