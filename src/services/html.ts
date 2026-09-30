import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join, sep } from 'path';
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

	const uiFolder = allFiles.find((item) => item[0] === FRONTEND_FOLDER_NAME && item[1] === vscode.FileType.Directory);
	if (!uiFolder) {
		throw new Error('Could not find UI assets folder');
	}

	const projectFolder = join(context.extensionPath, FRONTEND_FOLDER_NAME, 'dist', 'assets');
	const uiFiles: [string, vscode.FileType][] = await vscode.workspace.fs.readDirectory(vscode.Uri.file(projectFolder));
	const jsFile = uiFiles.find((item) => item[1] === vscode.FileType.File && item[0].endsWith('.js'));
	const cssFile = uiFiles.find((item) => item[1] === vscode.FileType.File && item[0].endsWith('.css'));
	if (!jsFile || !cssFile) {
		throw new Error('UI asset files (JS or CSS) not found in build output');
	}

	return {
		jsFile: jsFile[0],
		cssFile: cssFile[0]
	};
}

/**
 * Generates a random nonce for webview Content Security Policy
 */
export function getNonce(): string {
	return randomBytes(16).toString('base64');
}

/**
 * Strict CSP for the promo notice webviews: nonce'd inline script and style
 * only, https images.
 */
export function buildNoticeCsp(cspSource: string, nonce: string): string {
	return `default-src 'none'; img-src https: ${cspSource}; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
}

/** Folder with the notice templates, relative to the extension root. */
export const NOTICES_FOLDER = 'resources/notices';

export interface NoticeWebview {
	cspSource: string;
	asWebviewUri(uri: vscode.Uri): { toString(): string };
}

/**
 * Renders a notice template from `resources/notices`. Placeholders:
 * `{{csp}}`, `{{nonce}}`, `{{name}}` (HTML-escaped value from `vars`),
 * `{{asset:path}}` (webview URI of a file) and `{{include:path}}` (raw file content).
 * Paths are relative to `resources/notices`. An unknown placeholder throws.
 */
export function renderNoticeTemplate(
	extensionPath: string,
	webview: NoticeWebview,
	nonce: string,
	template: string,
	vars: Record<string, string | number> = {},
): string {
	const root = join(extensionPath, NOTICES_FOLDER);
	const resolveNoticePath = (relative: string) => {
		const absolute = join(root, relative);
		if (!absolute.startsWith(root + sep)) {
			throw new Error(`Notice path escapes ${NOTICES_FOLDER}: ${relative}`);
		}
		return absolute;
	};

	const values: Record<string, string> = { csp: buildNoticeCsp(webview.cspSource, nonce), nonce };
	for (const [key, value] of Object.entries(vars)) {
		values[key] = escapeHtml(String(value));
	}

	const expand = (source: string, depth: number): string => source.replace(/\{\{\s*([a-z]+)(?::([^}\s]+))?\s*\}\}/gi, (_, name: string, arg?: string) => {
		if (name === 'asset' && arg) {
			return webview.asWebviewUri(vscode.Uri.file(resolveNoticePath(arg))).toString();
		}
		if (name === 'include' && arg && depth < 3) {
			return expand(readFileSync(resolveNoticePath(arg), 'utf8'), depth + 1);
		}
		if (!arg && name in values) {
			return values[name];
		}
		throw new Error(`Unknown notice placeholder {{${name}${arg ? `:${arg}` : ''}}} in ${template}`);
	});

	return expand(readFileSync(resolveNoticePath(template), 'utf8'), 0);
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}