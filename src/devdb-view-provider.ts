import * as vscode from 'vscode';
import { getWebviewHtml } from './services/html';
import { handleIncomingMessage, sendMessageToWebview, tableExists } from './services/messenger';
import { plural } from 'pluralize';
import * as stringcase from 'stringcase';

export class DevDbViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'devdb';

	private _view?: vscode.WebviewView;
	private _extensionUri: vscode.Uri;

	constructor(
		private context: vscode.ExtensionContext,
		private jsFile?: string,
		private cssFile?: string,
	) {
		this._extensionUri = context.extensionUri;
	}

	public async resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
		if (!this.jsFile || !this.cssFile) throw new Error('DevDb bundled asset files not found')

		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = getWebviewHtml(webviewView.webview, this.jsFile, this.cssFile, this._extensionUri);

		webviewView.webview.onDidReceiveMessage(async (data) => {
			if (!this._view) return console.log(`Message received but the webview not available`)

			await handleIncomingMessage(data, this._view)
		});
	}

	public setActiveTable(table: string) {
		if (!this._view) return console.log(`Message received but the webview not available`)
		if (!tableExists(table)) return vscode.window.showErrorMessage(`Table ${table} does not exist`)

		sendMessageToWebview(this._view.webview, { type: 'codelens-action:set-active-table', value: table })
		this._view.show()
	}

	/**
	 * Gets the word at the current cursor location and opens the table in the DevDb view
	 */
	public openTableAtCurrentCursor() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;

		const document = editor.document;
		const cursorPosition = editor.selection.active;
		const wordRange = document.getWordRangeAtPosition(cursorPosition);
		const word = document.getText(wordRange)
		const tableName = plural(stringcase.snakecase(word));

		this.setActiveTable(tableName);
	}

	public notifyConfigChange(event: vscode.ConfigurationChangeEvent) {
		if (!this._view) return console.log(`Config changed but webview not available`)

		const newSettings = vscode.workspace.getConfiguration('Devdb');
		sendMessageToWebview(this._view.webview, { type: 'config-changed', value: newSettings })
	}
}