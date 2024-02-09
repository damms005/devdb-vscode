import { join } from 'path';
import * as vscode from 'vscode';

export const FRONTEND_FOLDER_NAME = 'ui-shell'

export type VueAssets = {
	jsFile: string;
	cssFile: string;
};

/**
 * Gets the html for the webview
 */
export function getWebviewHtml(webview: vscode.Webview, jsFile: string, cssFile: string, _extensionUri: vscode.Uri) {

	// Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
	const vueAppScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(_extensionUri, FRONTEND_FOLDER_NAME, 'dist', 'assets', jsFile));

	// Do the same for the stylesheet.
	const styleVueAppUri = webview.asWebviewUri(vscode.Uri.joinPath(_extensionUri, FRONTEND_FOLDER_NAME, 'dist', 'assets', cssFile));

	// Use nonce to allow specific scripts to be run.
	const nonce1 = getNonce();
	const nonce2 = getNonce();

	/**
	 * Tailwindcss uses svg loaded from data:image..., at least for checkboxes.
	 */
	const tailwindcss = 'data:'

	return `<!DOCTYPE html>
		<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src https://fonts.googleapis.com; img-src ${webview.cspSource} ${tailwindcss}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce1}' 'nonce-${nonce2}'; connect-src https://icanhazdadjoke.com/ ">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleVueAppUri}" rel="stylesheet">
			</head>
			<body class="min-h-full min-w-full bg-white">
					<div id="app" class="w-full min-w-full h-full min-h-full" ></div>
					<script nonce="${nonce2}" src="${vueAppScriptUri}"></script>
			</body>
		</html>`;
}

/**
 * Gets the compiled Vue assets from the Vue project output folder
 */
export async function getVueAssets(context: vscode.ExtensionContext): Promise<VueAssets> {
	const allFiles = await vscode.workspace.fs.readDirectory(vscode.Uri.file(context.extensionPath));

	return new Promise(async (resolve, reject) => {
		const uiFolder = allFiles.find((item) => item[0] === FRONTEND_FOLDER_NAME && item[1] === vscode.FileType.Directory);

		if (uiFolder) {
			const projectFolder = join(context.extensionPath, FRONTEND_FOLDER_NAME, 'dist', 'assets')
			const uiFiles: [string, vscode.FileType][] = await vscode.workspace.fs.readDirectory(vscode.Uri.file(projectFolder));
			const jsFile = uiFiles.find((item) => item[1] === vscode.FileType.File && item[0].endsWith('.js'));
			const cssFile = uiFiles.find((item) => item[1] === vscode.FileType.File && item[0].endsWith('.css'));
			if (!jsFile || !cssFile) return

			resolve({
				jsFile: jsFile[0],
				cssFile: cssFile[0]
			})
		}

		reject('Could not find UI assets');
	})
}

/**
 * Generates a random nonce for webview Content Security Policy
 */
export function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}