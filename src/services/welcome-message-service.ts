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

				case "Tell someone on 𝕏":
					const message = getRandomTwitterMessage();
					goToUrl(`https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}`);
					break;
			}
		})
}

/**
 * Returns a random message from the predefined list of messages
 * for sharing the extension on Twitter.
 */
function getRandomTwitterMessage(): string {
	/**
	 * Max length of a tweet is 280 characters. Emphasize "DevDb" and "VSCode" in the message.
	 * Because we currently do not provide lots of db admin features, we will advertise it as
	 * a tool for viewing databases rather than managing them. We also need to project that it
	 * does not matter the programming language you are using. Some messages can also project
	 * the advantages of using DevDb, and it is a must-have for developers.
	 */
	const messages = [
		"DevDb is fantastic for viewing databases right inside VSCode. Check it out here: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"If you work with databases and use VSCode, check out DevDb, a database viewer for VSCode: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"DevDb is a great extension for viewing databases right inside VSCode. Check it out here: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"DevDb is a fantastic extension for viewing databases right inside VSCode. Check it out here: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"When working with databases in VSCode, DevDb is a must-have. Check it out here: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"DevDb is a must-have for developers who work with databases in VSCode. Check it out here: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"No matter the programming language you are using, DevDb makes it easy to view databases in VSCode. Check it out here: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"No matter the framework you are using, DevDb makes it easy to view databases in VSCode. Check it out here: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"Anytime you need to view databases in VSCode, DevDb is the way to go. Check it out here: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"A great extension for viewing databases right inside VSCode is DevDb. Check it out here: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"If you find yourself switching between VSCode and a database viewer, you should check out DevDb. It's a database viewer for VSCode: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"DevDb in VSCode simplifies your workflow by eliminating the need for switching between applications. Check it out: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"Streamline your database work with DevDb in VSCode. No more context switching: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"DevDb brings the power of database viewing to your favorite editor, VSCode. Give it a try: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"Working with databases in VSCode has never been easier thanks to DevDb. Discover more: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"DevDb for VSCode: A seamless database viewing experience in the comfort of your code editor. Explore now: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"DevDb transforms VSCode into a powerful database viewer. See for yourself: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"Enhance your VSCode with DevDb for a seamless database viewing experience. Check it out: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
		"DevDb in VSCode: Because your database work deserves the same environment as your coding. Discover more: https://marketplace.visualstudio.com/items?itemName=damms005.devdb",
	];

	const randomIndex = Math.floor(Math.random() * messages.length);
	return messages[randomIndex]
}

function goToUrl(url: string) {
	vscode.env.openExternal(vscode.Uri.parse(url));
}