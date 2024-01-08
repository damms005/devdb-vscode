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

	console.log({ previousVersion, currentVersion, previousVersionArray, currentVersionArray })

	if (previousVersion === undefined || previousVersion.length === 0) {
		message = `Thanks for using DevDb.`;
	} else if (
		currentVersion !== previousVersion &&
		// patch update
		((previousVersionArray[0] === currentVersionArray[0] &&
			previousVersionArray[1] === currentVersionArray[1] &&
			previousVersionArray[2] < currentVersionArray[2]) ||
			// minor update
			(previousVersionArray[0] === currentVersionArray[0] &&
				previousVersionArray[1] < currentVersionArray[1]) ||
			// major update
			previousVersionArray[0] < currentVersionArray[0])
	) {
		message = `DevDb updated to ${currentVersion}.`;
	}

	if (message) {
		vscode.window
			.showInformationMessage(
				message,
				"⭐️ Star on Github",
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
			});
		context.globalState.update(
			ExtensionConstants.globalVersionKey,
			currentVersion,
		);
	}
}