import * as vscode from 'vscode';
import { DevDbViewProvider } from './devdb-view-provider';
import { getVueAssets } from './services/html';
import { CodelensProvider } from './services/codelens/code-lens-service';
import { showWelcomeMessage } from './services/welcome-message-service';

let devDbViewProvider: DevDbViewProvider | undefined;
let isDevDbPanelVisible = false;

export async function activate(context: vscode.ExtensionContext) {

	showWelcomeMessage(context);

	let assets;

	try {
		assets = await getVueAssets(context)
	} catch (error) {
		return vscode.window.showErrorMessage(`Could not load frontend assets: ${String(error)}`);
	}

	if (!assets) return vscode.window.showErrorMessage('Could not load frontend assets')

	if (!devDbViewProvider) {
		devDbViewProvider = new DevDbViewProvider(context, assets.jsFile, assets.cssFile);
	}

	// Register the webview provider
	const provider = vscode.window.registerWebviewViewProvider(
		DevDbViewProvider.viewType,
		devDbViewProvider,
		{
			webviewOptions: {
				retainContextWhenHidden: true,
			}
		}
	);

	context.subscriptions.push(provider);

	// Track initial visibility state
	context.subscriptions.push(
		devDbViewProvider.onDidChangeVisibility(visible => {
			console.log('Extension received visibility change:', { visible });
		})
	);

	context.subscriptions.push(
		devDbViewProvider.onDidChangeVisibility(visible => {
			isDevDbPanelVisible = visible;
			console.log('DevDb visibility changed:', { isDevDbPanelVisible });
		})
	);

	context.subscriptions.push(vscode.commands.registerCommand('devdb.focus', () => {
		if (!devDbViewProvider) return;
		console.log('Toggle requested. Current visibility:', { isVisible: devDbViewProvider.isVisible });
		devDbViewProvider.toggleVisibility();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('devdb.codelens.open-laravel-model-table', tableName => {
		if (!devDbViewProvider) return;

		devDbViewProvider.setActiveTable(tableName);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('devdb.context-menu.open-table-at-cursor', () => {
		if (!devDbViewProvider) return;

		devDbViewProvider.openTableAtCurrentCursor();
	}));

	const codelensProvider = new CodelensProvider();
	vscode.languages.registerCodeLensProvider({ scheme: 'file', language: 'php' }, codelensProvider);

	vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
		if (event.affectsConfiguration('Devdb')) {
			devDbViewProvider?.notifyConfigChange(event);
		}
	});
}
