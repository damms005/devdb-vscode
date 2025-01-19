import * as vscode from 'vscode';
import { ExtensionConstants } from "../constants";

const BUTTON_CONDITIONAL_STAR_GITHUB_REPO = "⭐️ Star on GitHub";
const BUTTON_CONDITIONAL_FOLLOW_ON_X = "𝕏 Follow"
const BUTTON_CONDITIONAL_SUPPORT_THE_PROJECT = "❤️ Support this Project"
const BUTTON_SUGGEST_FEATURE = "💡 Suggest Feature"

export function showWelcomeMessage(context: vscode.ExtensionContext) {
	const previousVersion = getPreviousVersion(context);
	const currentVersion = getCurrentVersion();

	context.globalState.update(ExtensionConstants.globalVersionKey, currentVersion);

	if (!previousVersion) {
		showMessageAndButtons(`Thanks for using DevDb.`, context)
		return
	}

	const previousVersionArray = getVersionAsArray(previousVersion);
	const currentVersionArray = getVersionAsArray(currentVersion || '1.0.0');

	if (currentVersion === previousVersion || !isUpdate(previousVersionArray, currentVersionArray)) {
		return;
	}

	showMessageAndButtons(`
					DevDb updated to ${currentVersion}.
					✨ Contextual filtering for numeric columns
					✨ One-click row deletion
					✨ One-click set column value to null
					✨ Easy column value editing
					✨ SQL query explanation using MySQL Visual Explain
					✨ Intelligent factory class generation for Laravel Eloquent models
					✨ (see details in the repo's README)
			`, context);
}

function showMessageAndButtons(message: string, context: vscode.ExtensionContext) {
	const buttons = [];

	if (!hasUserClickedButton(context, ExtensionConstants.clickedToSupportTheProject)) {
		buttons.push(BUTTON_CONDITIONAL_SUPPORT_THE_PROJECT);
	}

	const config = vscode.workspace.getConfiguration('Devdb');
	const showAllNotifications = !config.get<boolean>('showFewerUpdateNotificationActions', false)
		|| !config.get<boolean>('dontShowNewVersionMessage', false); // being deprecated

	if (showAllNotifications) {
		if (!hasUserClickedButton(context, ExtensionConstants.clickedGitHubStarring)) {
			buttons.push(BUTTON_CONDITIONAL_STAR_GITHUB_REPO);
		}

		if (!hasUserClickedButton(context, ExtensionConstants.clickedToFollowOnX)) {
			buttons.push(BUTTON_CONDITIONAL_FOLLOW_ON_X);
		}
	}

	if (buttons.length < 3) {
		buttons.push(BUTTON_SUGGEST_FEATURE);
	}

	vscode.window.showInformationMessage(message, ...buttons)
		.then((val: string | undefined) => {
			switch (val) {
				case BUTTON_CONDITIONAL_SUPPORT_THE_PROJECT:
					updateUserAction(context, ExtensionConstants.clickedToSupportTheProject);
					openExternalLink('https://github.com/sponsors/damms005');
					break;

				case BUTTON_CONDITIONAL_STAR_GITHUB_REPO:
					updateUserAction(context, ExtensionConstants.clickedGitHubStarring);
					openExternalLink('https://github.com/damms005/devdb-vscode');
					break;

				case BUTTON_CONDITIONAL_FOLLOW_ON_X:
					updateUserAction(context, ExtensionConstants.clickedToFollowOnX);
					openExternalLink('https://x.com/_damms005');
					break;

				case BUTTON_SUGGEST_FEATURE:
					openExternalLink('https://github.com/damms005/devdb-vscode/discussions/new?category=ideas');
					break;
			}
		});
}

function hasUserClickedButton(context: vscode.ExtensionContext, key: string): boolean {
	return context.globalState.get<boolean>(key) || false;
}

function updateUserAction(context: vscode.ExtensionContext, key: string) {
	context.globalState.update(key, true);
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

function getVersionAsArray(version: string): number[] {
	try {
		// Validate version string format
		if (!/^\d+(\.\d+)*$/.test(version)) {
			console.warn(`Invalid version format: ${version}`);
			return [0, 0, 0];
		}
		return version.split(".").map(segment => {
			const num = parseInt(segment, 10);
			return isNaN(num) ? 0 : num;
		});
	} catch (error) {
		console.error('Error parsing version:', error);
		return [0, 0, 0];
	}
}

function isUpdate(previousVersion: number[], currentVersion: number[]): boolean {
	// Ensure arrays have same length
	const maxLength = Math.max(previousVersion.length, currentVersion.length);
	const normalizedPrev = [...previousVersion, ...Array(maxLength).fill(0)].slice(0, maxLength);
	const normalizedCurr = [...currentVersion, ...Array(maxLength).fill(0)].slice(0, maxLength);

	for (let i = 0; i < maxLength; i++) {
		if (normalizedCurr[i] > normalizedPrev[i]) return true;
		if (normalizedCurr[i] < normalizedPrev[i]) return false;
	}
	return false;
}