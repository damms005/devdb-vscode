import * as vscode from 'vscode';
import { getWebviewHtml } from './services/html';
import { handleIncomingMessage, isTablesLoaded, sendMessageToWebview, tableExists } from './services/messenger';
import { plural } from 'pluralize';
import Case from 'case';
import { getWordUnderCursor } from './services/document-service';
import { showEmptyTablesNotification } from './services/error-notification-service';

export class DevDbViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'devdb';

	private _view?: vscode.WebviewView;
	private _extensionUri: vscode.Uri;
	private _onDidChangeVisibility = new vscode.EventEmitter<boolean>();
	readonly onDidChangeVisibility = this._onDidChangeVisibility.event;
	private _isVisible = false;

	constructor(
		private context: vscode.ExtensionContext,
		private jsFile?: string,
		private cssFile?: string,
	) {
		this._extensionUri = context.extensionUri;
	}

	public get isVisible(): boolean {
		return this._isVisible;
	}

	public async resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
		if (!this.jsFile || !this.cssFile) throw new Error('DevDb bundled asset files not found')

		this._view = webviewView;
		this._isVisible = webviewView.visible;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = getWebviewHtml(webviewView.webview, this.jsFile, this.cssFile, this._extensionUri);

		webviewView.webview.onDidReceiveMessage(async (data) => {
			if (!this._view) return console.log(`Message received but the webview not available`)

			await handleIncomingMessage(data, this._view)
		});

		webviewView.onDidChangeVisibility(() => {
			this._isVisible = webviewView.visible;
			this._onDidChangeVisibility.fire(this._isVisible);
		});
	}

	public setActiveTable(table: string) {
		if (!this._view) return console.log(`Message received but the webview not available`)

		if (!isTablesLoaded()) {
			return showEmptyTablesNotification()
		}

		if (!tableExists(table)) return vscode.window.showErrorMessage(`Table ${table} does not exist`)

		sendMessageToWebview(this._view.webview, { type: 'ide-action:show-table-data', value: table })
		this._view.show()
	}

	/**
	 * Gets the word at the current cursor location and opens the table in the DevDb view
	 */
	public openTableAtCurrentCursor() {
		if (!isTablesLoaded()) {
			return showEmptyTablesNotification()
		}

		const word = getWordUnderCursor()
		if (!word) return;

		let tableName = Case.snake(word);

		if (!tableExists(tableName)) {
			tableName = plural(tableName);

			if (!tableExists(tableName)) {
				return vscode.window.showErrorMessage(`Table ${word} does not exist`)
			}
		}

		this.setActiveTable(tableName);
	}

	public notifyConfigChange(event: vscode.ConfigurationChangeEvent) {
		if (!this._view) return console.log(`Config changed but webview not available`)

		const newSettings = vscode.workspace.getConfiguration('Devdb');
		sendMessageToWebview(this._view.webview, { type: 'config-changed', value: newSettings })
	}
}