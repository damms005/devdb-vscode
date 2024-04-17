import * as vscode from 'vscode';
import { ExtensionConstants } from "../constants";

const BUTTON_STAR_GITHUB_REPO = "⭐️ Star on GitHub";
const BUTTON_FOLLOW_ON_X = "𝕏 Follow me"
const BUTTON_SHARE_ON_X = "𝕏 Share"
const BUTTON_REPORT_BUG = "🐞 Report bug";

export function showWelcomeMessage(context: vscode.ExtensionContext) {
	const extensionConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(
		'Devdb'
	);

	if (extensionConfig.dontShowNewVersionMessage) {
		return;
	}

	const previousVersion = getPreviousVersion(context);
	const currentVersion = getCurrentVersion();
	const previousVersionArray = getPreviousVersionArray(previousVersion);
	const currentVersionArray = getCurrentVersionArray(currentVersion);

	if (previousVersion === undefined || previousVersion.length === 0) {
		showMessage(`Thanks for using DevDb.`, context)
		return
	}

	if (currentVersion === previousVersion) {
		return;
	}

	context.globalState.update(ExtensionConstants.globalVersionKey, currentVersion);

	if (
		isMajorUpdate(previousVersionArray, currentVersionArray) ||
		isMinorUpdate(previousVersionArray, currentVersionArray) ||
		isPatchUpdate(previousVersionArray, currentVersionArray)
	) {
		showMessage(`DevDb updated to ${currentVersion}.`, context);
	}
}

function showMessage(message: string, context: vscode.ExtensionContext) {
	const buttons = []
	const userHasClickedGitHubStarring = hasClickedGitHubStarring(context)
	const userHasClickedToShareOnX = hasClickedToShareOnX(context)

	if (!userHasClickedGitHubStarring) {
		buttons.push(BUTTON_STAR_GITHUB_REPO)
	}

	if (!userHasClickedToShareOnX) {
		buttons.push(BUTTON_FOLLOW_ON_X)
	}

	if (userHasClickedGitHubStarring || userHasClickedToShareOnX) {
		buttons.push(BUTTON_SHARE_ON_X)
	}

	buttons.push(BUTTON_REPORT_BUG)

	vscode.window.showInformationMessage(message, ...buttons)
		.then(function (val: string | undefined) {
			switch (val) {
				case BUTTON_STAR_GITHUB_REPO:
					context.globalState.update(ExtensionConstants.clickedGitHubStarring, true);
					vscode.env.openExternal(vscode.Uri.parse("https://github.com/damms005/devdb-vscode"))
					break;

				case BUTTON_FOLLOW_ON_X:
					context.globalState.update(ExtensionConstants.clickedToShareOnX, true);
					vscode.env.openExternal(vscode.Uri.parse("https://twitter.com/_damms005"))
					break;

				case BUTTON_SHARE_ON_X:
					context.globalState.update(ExtensionConstants.clickedToShareOnX, true);
					const message = getRandomShareTweet()
					// https://developer.twitter.com/en/docs/twitter-for-websites/tweet-button/overview
					// const message = "DevDb page: https://marketplace.visualstudio.com/items?itemName=damms005.devdb"
					const twitterIntentUri = vscode.Uri.from({ scheme: 'https', path: 'twitter.com/intent/tweet', query: `text=${message}` });
					vscode.env.openExternal(twitterIntentUri)
					break;

				case BUTTON_REPORT_BUG:
					vscode.env.openExternal(vscode.Uri.parse("https://github.com/damms005/devdb-vscode/issues/new?assignees=&labels=bug%2Cunconfirmed%2Clow+priority&projects=&template=bug_report.yml"))
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

function getCurrentVersionArray(currentVersion: any) {
	return currentVersion
		.split(".")
		.map((s: string) => Number(s));
}

function getPreviousVersionArray(previousVersion: string | undefined) {
	return previousVersion
		? previousVersion.split(".").map((s: string) => Number(s))
		: [0, 0, 0];
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

function hasClickedToShareOnX(context: vscode.ExtensionContext) {
	return context.globalState.get<boolean>(ExtensionConstants.clickedToShareOnX);
}

/**
 * @returns A random message to share on X, within the 280 X character limit
 */
function getRandomShareTweet(): string {
	const messages = [
		// https://bit.ly/devdb
		"If you work with databases and use VS Code, you may want to check out DevDb. https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"Working with databases in your VS Code workspace? You should give DevDb a try. https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"DevDb is a VS Code extension that helps you work with databases. https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"DevDb makes working with databases in VS Code so much easier. https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"I just found this amazing VS Code extension for working with databases. It's called DevDb and it's awesome! https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"If you're a developer who works with databases, you should definitely check out DevDb for VS Code. https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"DevDb is a must-have VS Code extension for anyone who works with databases. https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"I use DevDb to work with databases in VS Code. It's a game changer! https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
	];

	const message = messages[Math.floor(Math.random() * messages.length)];

	return message;
}