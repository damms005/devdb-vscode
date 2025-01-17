import * as vscode from 'vscode';
import { ExtensionConstants } from "../constants";

const BUTTON_CONDITIONAL_STAR_GITHUB_REPO = "⭐️ Star on GitHub";
const BUTTON_CONDITIONAL_FOLLOW_ON_X = "𝕏 Follow"
const BUTTON_CONDITIONAL_SUPPORT_THE_PROJECT = "❤️ Support this project"
const BUTTON_SUGGEST_FEATURE = "💡 Suggest Feature"

export function showWelcomeMessage(context: vscode.ExtensionContext) {

	const config = vscode.workspace.getConfiguration('Devdb');
	if (!config.get<boolean>('showUpdateSummary', true)) {
		return;
	}

	const previousVersion = getPreviousVersion(context);
	const currentVersion = getCurrentVersion();

	context.globalState.update(ExtensionConstants.globalVersionKey, currentVersion);

	if (!previousVersion) {
		showMessageAndButtons(`Thanks for using DevDb.`, context)
		return
	}

	const previousVersionArray = getVersionAsArray(previousVersion);
	const currentVersionArray = getVersionAsArray(currentVersion);

	if (currentVersion === previousVersion) {
		return;
	}

	if (
		isMajorUpdate(previousVersionArray, currentVersionArray) ||
		isMinorUpdate(previousVersionArray, currentVersionArray) ||
		isPatchUpdate(previousVersionArray, currentVersionArray)
	) {
		/**
		 * The weird formatting below is to work around lack of support for
		 * new lines in VS Code notification message API.
		 *
		 * @see https://github.com/microsoft/vscode/issues/101589
		 */
		showMessageAndButtons(`
			DevDb updated to ${currentVersion}.
			✨ Contextual filtering for numeric columns
			✨ One-click row deletion
			✨ One-click set column value to null
			✨ Easy column value editing
			✨ SQL query explanation using MySQL Visual Explain
			✨ Intelligent factory class generation for Laravel Eloquent models
			✨ (see details in the repo's README)
			`,
			context
		);
	}
}

function showMessageAndButtons(message: string, context: vscode.ExtensionContext) {
	const buttons = []
	const userHasClickedGitHubStarring = hasClickedGitHubStarring(context)
	const userHasClickedToFollowOnX = hasClickedToFollowOnX(context)
	const userSupportsTheProject = hasClickedToSupportTheProject(context)

	if (!userSupportsTheProject) {
		buttons.push(BUTTON_CONDITIONAL_SUPPORT_THE_PROJECT)
	}

	if (!userHasClickedGitHubStarring) {
		buttons.push(BUTTON_CONDITIONAL_STAR_GITHUB_REPO)
	}

	if (!userHasClickedToFollowOnX) {
		buttons.push(BUTTON_CONDITIONAL_FOLLOW_ON_X)
	}

	if (buttons.length < 3) {
		buttons.push(BUTTON_SUGGEST_FEATURE)
	}

	vscode.window.showInformationMessage(message, ...buttons)
		.then(function (val: string | undefined) {
			switch (val) {
				case BUTTON_CONDITIONAL_SUPPORT_THE_PROJECT:
					context.globalState.update(ExtensionConstants.clickedToSupportTheProject, true);
					vscode.env.openExternal(vscode.Uri.parse("https://github.com/sponsors/damms005"))
					break;

				case BUTTON_CONDITIONAL_STAR_GITHUB_REPO:
					context.globalState.update(ExtensionConstants.clickedGitHubStarring, true);
					vscode.env.openExternal(vscode.Uri.parse("https://github.com/damms005/devdb-vscode"))
					break;

				case BUTTON_CONDITIONAL_FOLLOW_ON_X:
					context.globalState.update(ExtensionConstants.clickedToFollowOnX, true);
					vscode.env.openExternal(vscode.Uri.parse("https://twitter.com/_damms005"))
					break;

				case BUTTON_SUGGEST_FEATURE:
					vscode.env.openExternal(vscode.Uri.parse("https://github.com/damms005/devdb-vscode/discussions/new?category=ideas"))
					break;
			}
		})
}

function isMajorUpdate(previousVersionArray: number[], currentVersionArray: any): boolean {
	return previousVersionArray[0] < currentVersionArray[0];
}

function isMinorUpdate(previousVersionArray: number[], currentVersionArray: any): boolean {
	return previousVersionArray[0] === currentVersionArray[0] &&
		previousVersionArray[1] < currentVersionArray[1];
}

function isPatchUpdate(previousVersionArray: number[], currentVersionArray: any) {
	return previousVersionArray[0] === currentVersionArray[0] &&
		previousVersionArray[1] === currentVersionArray[1] &&
		previousVersionArray[2] < currentVersionArray[2];
}

/**
 * Gets the previous version as an array of numbers.
 */
function getVersionAsArray(version: string): number[] {
	return version.split(".").map((s: string) => Number(s));
}

export function getCurrentVersion() {
	return vscode.extensions.getExtension(
		ExtensionConstants.extensionId
	)?.packageJSON?.version;
}

function getPreviousVersion(context: vscode.ExtensionContext) {
	return context.globalState.get<string>(ExtensionConstants.globalVersionKey);
}

function hasClickedGitHubStarring(context: vscode.ExtensionContext) {
	return context.globalState.get<boolean>(ExtensionConstants.clickedGitHubStarring);
}

function hasClickedToFollowOnX(context: vscode.ExtensionContext) {
	return context.globalState.get<boolean>(ExtensionConstants.clickedToFollowOnX);
}

function hasClickedToSupportTheProject(context: vscode.ExtensionContext) {
	return context.globalState.get<boolean>(ExtensionConstants.clickedToSupportTheProject);
}