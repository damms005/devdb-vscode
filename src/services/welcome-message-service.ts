import * as vscode from 'vscode';
import { ExtensionConstants } from "../constants";

export function showWelcomeMessage(context: vscode.ExtensionContext) {
	const extensionConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(
		'Devdb'
	);

	if (extensionConfig.dontShowNewVersionMessage) {
		return;
	}

	let message: string | null = null;

	const previousVersion = context.globalState.get<string>(
		ExtensionConstants.globalVersionKey,
	);

	const currentVersion = vscode.extensions.getExtension(
		ExtensionConstants.extensionId,
	)?.packageJSON?.version;

	const previousVersionArray = previousVersion
		? previousVersion.split(".").map((s: string) => Number(s))
		: [0, 0, 0];

	const currentVersionArray = currentVersion
		.split(".")
		.map((s: string) => Number(s));

	if (previousVersion === undefined || previousVersion.length === 0) {
		showMessage(`Thanks for using DevDb.`)
		return
	}

	if (currentVersion !== previousVersion) {

		context.globalState.update(ExtensionConstants.globalVersionKey, currentVersion);

		if (
			// patch update
			((previousVersionArray[0] === currentVersionArray[0] &&
				previousVersionArray[1] === currentVersionArray[1] &&
				previousVersionArray[2] < currentVersionArray[2]) ||
				// minor update
				(previousVersionArray[0] === currentVersionArray[0] &&
					previousVersionArray[1] < currentVersionArray[1]) ||
				// major update
				previousVersionArray[0] < currentVersionArray[0])) {

			showMessage(`DevDb updated to ${currentVersion}.`);
		}
	}
}

function showMessage(message: string) {
	vscode.window.showInformationMessage(message, "⭐️ Star on GitHub", "𝕏 Follow me", "🐞 Report bug")
		.then(function (val: string | undefined) {
			switch (val) {
				case "⭐️ Star on GitHub":
					goToUrl("https://github.com/damms005/devdb-vscode");
					break;

				case "𝕏 Follow me":
					goToUrl("https://twitter.com/_damms005");
					break;

				case "🐞 Report bug":
					goToUrl("https://github.com/damms005/devdb-vscode/issues/new?assignees=&labels=bug%2Cunconfirmed%2Clow+priority&projects=&template=bug_report.yml");
					break;
			}
		})
}

function goToUrl(url: string) {
	vscode.env.openExternal(vscode.Uri.parse(url));
}