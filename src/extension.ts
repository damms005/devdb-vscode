import * as vscode from 'vscode';
import { DevDbViewProvider } from './devdb-view-provider';
import { getVueAssets } from './services/html';
import { CodelensProvider } from './services/codelens/code-lens-service';

let devDbViewProvider: DevDbViewProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
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

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(DevDbViewProvider.viewType, devDbViewProvider, {
			webviewOptions: {
				retainContextWhenHidden: true,
			}
		})
	);

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
