import * as vscode from 'vscode';
import { DevDbViewProvider } from './devdb-view-provider';
import { getVueAssets } from './services/html';
import { CodelensProvider } from './services/codelens/code-lens-service';
import { showWelcomeMessage } from './services/welcome-message-service';
import { LaravelFactoryGenerator } from './services/laravel/factory-generator';
import { database } from './services/messenger';
import { SqlQueryCodeLensProvider, explainSelectedQuery } from './services/laravel/code-runner/sql-query-explainer-provider';

let devDbViewProvider: DevDbViewProvider | undefined;

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

	context.subscriptions.push(vscode.commands.registerCommand('devdb.focus', () => {
		if (!devDbViewProvider) return;
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

	context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file', language: 'php' }, new SqlQueryCodeLensProvider()));

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'devdb.explain-query',
			(document: vscode.TextDocument, selection: vscode.Selection) => { explainSelectedQuery(document, selection); })
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'devdb.generate-laravel-factory',
			async (modelName: string, modelFilePath: string) => {
				const generator = new LaravelFactoryGenerator(database);
				await generator.generateFactory(modelName, modelFilePath);
			}
		)
	);

	vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
		if (event.affectsConfiguration('Devdb')) {
			devDbViewProvider?.notifyConfigChange(event);
		}
	});
}
