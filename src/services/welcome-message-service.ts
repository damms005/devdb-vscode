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
	vscode.window
		.showInformationMessage(
			message,
			"⭐️ Star on GitHub",
			"🐞 Report Bug",
		)
		.then(function (val: string | undefined) {
			if (val === "🐞 Report Bug") {
				vscode.env.openExternal(
					vscode.Uri.parse(
						"https://github.com/damms005/devdb-vscode/issues/new?assignees=&labels=bug%2Cunconfirmed%2Clow+priority&projects=&template=bug_report.yml",
					),
				);
			} else if (val === "⭐️ Star on Github") {
				vscode.env.openExternal(
					vscode.Uri.parse(
						"https://github.com/damms005/devdb-vscode",
					),
				);
			}
		})
}