import * as vscode from 'vscode';
import { ExtensionConstants } from "../constants";

const BUTTON_STAR_GITHUB_REPO = "⭐️ Star on GitHub";
const BUTTON_FOLLOW_ON_X = "𝕏 Follow"
const BUTTON_SHARE_ON_X = "𝕏 Share"
const BUTTON_VIEW_REPO = "🔎 View Repo"

export function showWelcomeMessage(context: vscode.ExtensionContext) {
	const extensionConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(
		'Devdb'
	);
	if (extensionConfig.dontShowNewVersionMessage) {
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
			✨ Explain MySQL queries
			✨ Generate Eloquent factories
			✨ Contextual filtering for numeric columns
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

	if (!userHasClickedGitHubStarring) {
		buttons.push(BUTTON_STAR_GITHUB_REPO)
	}

	if (!userHasClickedToFollowOnX) {
		buttons.push(BUTTON_FOLLOW_ON_X)
	}

	if (userHasClickedGitHubStarring || userHasClickedToFollowOnX) {
		buttons.push(BUTTON_SHARE_ON_X)
	}

	buttons.push(BUTTON_VIEW_REPO)

	vscode.window.showInformationMessage(message, ...buttons)
		.then(function (val: string | undefined) {
			switch (val) {
				case BUTTON_STAR_GITHUB_REPO:
					context.globalState.update(ExtensionConstants.clickedGitHubStarring, true);
					vscode.env.openExternal(vscode.Uri.parse("https://github.com/damms005/devdb-vscode"))
					break;

				case BUTTON_FOLLOW_ON_X:
					context.globalState.update(ExtensionConstants.clickedToFollowOnX, true);
					vscode.env.openExternal(vscode.Uri.parse("https://twitter.com/_damms005"))
					break;

				case BUTTON_SHARE_ON_X:
					context.globalState.update(ExtensionConstants.clickedToShareOnX, true);
					const message = getSafeRandomShareTweet()
					// https://developer.twitter.com/en/docs/twitter-for-websites/tweet-button/overview
					const twitterIntentUri = vscode.Uri.parse(`https://twitter.com/intent/tweet?text=${message}`);
					vscode.env.openExternal(twitterIntentUri)
					break;

				case BUTTON_VIEW_REPO:
					vscode.env.openExternal(vscode.Uri.parse("https://github.com/damms005/devdb-vscode"))
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

function getCurrentVersion() {
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

/**
 * Gets a random message to share on X, within the 280 X character limit.
 * For the string to be 'safe', it must not contain any special characters because the URI may
 * get broken like so. VS Code opening link->Twitter decoding same is wacky, and neither
 * encodeUri nor encodeUriComponent is helpful for this. It is some bug in VS Code and/or Twitter
 * and I am not digging into that rabbit hole.
 */
function getSafeRandomShareTweet(): string {
	const messages = [
		"If you work with databases and use VS Code, you may want to check out DevDb. https://bit.ly/devdb",
		"DevDb is a VS Code extension that helps you work with databases. https://bit.ly/devdb",
		"DevDb makes working with databases in VS Code so much easier. https://bit.ly/devdb",
		"I just found this amazing VS Code extension for working with databases. It's called DevDb and it's awesome! https://bit.ly/devdb",
		"If you're a developer who works with databases, you should definitely check out DevDb for VS Code. https://bit.ly/devdb",
		"DevDb is a must-have VS Code extension for anyone who works with databases. https://bit.ly/devdb",
		"I use DevDb to work with databases in VS Code. It's a game changer! https://bit.ly/devdb",
	];

	const message = messages[Math.floor(Math.random() * messages.length)];

	return message;
}