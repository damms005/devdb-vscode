import * as vscode from 'vscode';
import { ExtensionConstants } from "../constants";
import { compareVersions } from './version';
import { showDevWorkspaceProNoticeForDdevWorkspaces, showDevWorkspaceProNoticeForOtherWorkspaces } from './devworkspacepro-notification-service';
import { isNoticeReleaseLine, showNewDatastoresNotice, userWantsFewerNotifications } from './new-datastores-notification-service';

const BUTTON_CONDITIONAL_STAR_GITHUB_REPO = "⭐️ Star on GitHub";
const BUTTON_CONDITIONAL_SPONSOR = "❤️ Sponsor"
const BUTTON_GET_PRO = "🚀 Get Pro"

export async function showWelcomeMessage(context: vscode.ExtensionContext, hasLicense = false) {
	const previousVersion = getPreviousVersion(context);
	const currentVersion = getCurrentVersion();

	await context.globalState.update(ExtensionConstants.globalVersionKey, currentVersion);

	const isNewInstall = !previousVersion;
	const isVersionUpdate = !isNewInstall && !!currentVersion && currentVersion !== previousVersion
		&& isUpdate(previousVersion, currentVersion);

	// Max one full-page promo per launch, in this order: DevDb v4, then the DevWorkspace Pro
	// showcase for DDEV projects, then the one for PHP or other code projects without DDEV (7 days later).
	// Licensed users get a toast for DevDb v4, so a showcase can still show on that launch.
	const launchNotice = currentVersion ? await showNewDatastoresNotice(context, currentVersion, { hasLicense }) : 'none';
	let fullPagePromoShownThisLaunch = launchNotice === 'webview';
	fullPagePromoShownThisLaunch = await showDevWorkspaceProNoticeForDdevWorkspaces(context, isNewInstall, { fullPagePromoShownThisLaunch }) || fullPagePromoShownThisLaunch;
	await showDevWorkspaceProNoticeForOtherWorkspaces(context, isNewInstall, { fullPagePromoShownThisLaunch });

	if (isNewInstall) {
		showMessageAndButtons(`Thanks for using DevDb.`, context)
		return
	}

	if (!isVersionUpdate || !currentVersion) {
		return;
	}

	showMessageAndButtons(getUpdateMessage(currentVersion), context);
}

export function getUpdateMessage(currentVersion: string): string {
	const lines = [`DevDb updated to ${currentVersion}.`];

	if (isNoticeReleaseLine(currentVersion)) {
		lines.push('✨ New in 4.0: Redis/Valkey, ClickHouse, DuckDB, DynamoDB, Turso, Cloudflare D1, Neon & pgvector.');
	}

	lines.push('✨ Gift DevDb Pro to your colleagues and friends!');

	return lines.join('\n');
}

function showMessageAndButtons(message: string, context: vscode.ExtensionContext) {
	const buttons = [];

	if (!hasUserClickedButton(context, ExtensionConstants.clickedToSponsor)) {
		buttons.push(BUTTON_CONDITIONAL_SPONSOR);
	}

	if (!userWantsFewerNotifications()) {
		if (!hasUserClickedButton(context, ExtensionConstants.clickedGitHubStarring)) {
			buttons.push(BUTTON_CONDITIONAL_STAR_GITHUB_REPO);
		}
	}

	buttons.push(BUTTON_GET_PRO);

	vscode.window.showInformationMessage(message, ...buttons)
		.then(async (val: string | undefined) => {
			switch (val) {
				case BUTTON_CONDITIONAL_SPONSOR:
					await updateUserAction(context, ExtensionConstants.clickedToSponsor);
					openExternalLink('https://github.com/sponsors/damms005');
					break;

				case BUTTON_CONDITIONAL_STAR_GITHUB_REPO:
					await updateUserAction(context, ExtensionConstants.clickedGitHubStarring);
					openExternalLink('https://github.com/damms005/devdb-vscode');
					break;

				case BUTTON_GET_PRO:
					openExternalLink('https://devdbpro.com/?ref=ide');
					break;
			}
		});
}

function hasUserClickedButton(context: vscode.ExtensionContext, key: string): boolean {
	return context.globalState.get<boolean>(key) || false;
}

async function updateUserAction(context: vscode.ExtensionContext, key: string) {
	await context.globalState.update(key, true);
}

function openExternalLink(url: string) {
	vscode.env.openExternal(vscode.Uri.parse(url));
}

export function getCurrentVersion(): string | undefined {
	return vscode.extensions.getExtension(ExtensionConstants.extensionId)?.packageJSON?.version;
}

function getPreviousVersion(context: vscode.ExtensionContext): string | undefined {
	return context.globalState.get<string>(ExtensionConstants.globalVersionKey);
}


export function isUpdate(previousVersion: string, currentVersion: string): boolean {
	return compareVersions(currentVersion, previousVersion) > 0;
}
