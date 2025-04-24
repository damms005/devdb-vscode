import * as vscode from 'vscode';
import { DevDbViewProvider } from './devdb-view-provider';
import { getVueAssets } from './services/html';
import { LaravelCodelensProvider } from './services/codelens/code-lens-service';
import { showWelcomeMessage } from './services/welcome-message-service';
import { LaravelFactoryGenerator } from './services/laravel/factory-generator';
import { database } from './services/messenger';
import { SqlQueryCodeLensProvider, explainSelectedQuery } from './services/codelens/laravel/sql-query-explainer-provider';
import { contextMenuQueryExplainer, contextMenuLaravelFactoryGenerator } from './services/context-menu-service';
import { DevDbUriHandler } from './uri-handler';
import { goToTable } from './services/go-to-table';
import { startHttpServer } from './services/mcp/http-server';

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

	const settings = vscode.workspace.getConfiguration('Devdb');
	if (settings.get<boolean>('enableMcpServer', true)) {
		startHttpServer();
	}

	context.subscriptions.push(provider);

	context.subscriptions.push(vscode.commands.registerCommand('devdb.codelens.open-laravel-model-table', tableName => {
		if (!devDbViewProvider) return;

		devDbViewProvider.setActiveTable(tableName);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('devdb.context-menu.open-table-at-cursor', () => {
		if (!devDbViewProvider) return;

		devDbViewProvider.openTableAtCurrentCursor();
	}));

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ scheme: 'file', language: 'php' }, new SqlQueryCodeLensProvider())
	);

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ scheme: 'file', language: 'php' }, new LaravelCodelensProvider())
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'devdb.laravel.explain-query',
			(document: vscode.TextDocument, selection: vscode.Selection) => explainSelectedQuery(document, selection))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'devdb.laravel.generate-factory',
			async (modelName: string, modelFilePath: string) => {
				const generator = new LaravelFactoryGenerator(database);
				await generator.generateFactory(modelName, modelFilePath);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'devdb.context-menu.laravel.generate-factory-from-word-under-cursor',
			contextMenuLaravelFactoryGenerator
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'devdb.context-menu.laravel.explain-query',
			contextMenuQueryExplainer
		)
	);

	/**
	 * Register URI handler for devdb:// protocol
	 *
	 * @see https://code.visualstudio.com/api/references/activation-events#onUri
	 */
	context.subscriptions.push(
		vscode.window.registerUriHandler(new DevDbUriHandler())
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('devdb.goto-table', () => goToTable(devDbViewProvider))
	);

	vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
		if (event.affectsConfiguration('Devdb')) {
			devDbViewProvider?.notifyConfigChange(event);
		}
	});

}
