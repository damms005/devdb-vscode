import * as vscode from 'vscode';
import { DevDbViewProvider } from './devdb-view-provider';
import { getVueAssets } from './services/html';
import { LaravelCodelensProvider } from './services/codelens/code-lens-service';
import { getCurrentVersion, showWelcomeMessage } from './services/welcome-message-service';
import { resetNewDatastoresNotice, showNewDatastoresNotice } from './services/new-datastores-notification-service';
import { previewDevWorkspaceProNotice } from './services/devworkspacepro-notification-service';
import { LaravelFactoryGenerator } from './services/laravel/factory-generator';
import { getDatabase, setLicenseChecker } from './services/messenger';
import { SqlQueryCodeLensProvider, explainSelectedQuery } from './services/codelens/laravel/sql-query-explainer-provider';
import { contextMenuQueryExplainer, contextMenuLaravelFactoryGenerator } from './services/context-menu-service';
import { goToTable } from './services/go-to-table';
import { startHttpServer, stopHttpServer } from './services/mcp/http-server';
import { initializeDevWorkspaceProRecommendations } from './services/devworkspacepro-recommendation-service';
import { logToOutput } from './services/output-service';
import { LicenseService } from './services/license/license-service';
import { remoteCredentialService } from './services/remote-credential-service';
import { remoteConnectionStorageService } from './services/remote-connection-storage-service';
import { embeddingService } from './services/embedding-service';
import { sqlEditorStateStore } from './services/sql-editor/sql-editor-service';
import { setSshHostKeyStore } from './services/ssh-host-key-prompt';
import { setNeonLicenseChecker } from './providers/postgres/neon-postgres-provider';

let devDbViewProvider: DevDbViewProvider | undefined;
let licenseService: LicenseService;

export async function activate(context: vscode.ExtensionContext) {
	licenseService = new LicenseService(context.secrets);
	await licenseService.initialize();
	setLicenseChecker(() => licenseService.isValid());
	setNeonLicenseChecker(() => licenseService.isValid());
	setSshHostKeyStore(context.globalState);

	remoteCredentialService.setExtensionContext(context);
	remoteConnectionStorageService.setExtensionContext(context);
	embeddingService.setExtensionContext(context);
	sqlEditorStateStore.setExtensionContext(context);

	showWelcomeMessage(context, licenseService.isValid())
		.catch(error => logToOutput(`Could not show welcome message: ${String(error)}`));

	registerDevCommands(context);

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
		try {
			await startHttpServer();
			logToOutput('MCP HTTP server started', 'MCP Server');
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to start MCP server: ${error}`);
		}
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
				const generator = new LaravelFactoryGenerator(getDatabase());
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

	context.subscriptions.push(
		vscode.commands.registerCommand('devdb.goto-table', () => goToTable(devDbViewProvider))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('devdb.license.manage', () => licenseService.manageLicense())
	);

	vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
		if (event.affectsConfiguration('Devdb')) {
			devDbViewProvider?.notifyConfigChange(event);
		}
	});

	initializeDevWorkspaceProRecommendations(context);

}

/**
 * Preview commands for promo notices. Registered only in Extension Development Host.
 */
function registerDevCommands(context: vscode.ExtensionContext) {
	const isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
	vscode.commands.executeCommand('setContext', 'devdb.isDevelopment', isDevelopment);

	if (!isDevelopment) return;

	context.subscriptions.push(
		vscode.commands.registerCommand('devdb.dev.previewNewDatastoresNotice', async (args?: { licensed?: boolean }) => {
			let licensed = args?.licensed;
			if (licensed === undefined) {
				const pick = await vscode.window.showQuickPick(['Free (full-page notice)', 'Pro (toast)'], { placeHolder: 'Preview which copy?' });
				if (!pick) return;
				licensed = pick.startsWith('Pro');
			}

			await resetNewDatastoresNotice(context);
			await showNewDatastoresNotice(context, getCurrentVersion() ?? '0.0.0', { forcePreview: true, hasLicense: licensed });
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('devdb.dev.previewDevWorkspaceProNotice', (args?: { newInstall?: boolean }) => {
			previewDevWorkspaceProNotice(context, args?.newInstall ?? false);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('devdb.dev.previewDevWorkspaceProPhpNotice', (args?: { newInstall?: boolean }) => {
			previewDevWorkspaceProNotice(context, args?.newInstall ?? false, 'php');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('devdb.dev.previewDevWorkspaceProAnyProjectNotice', (args?: { newInstall?: boolean }) => {
			previewDevWorkspaceProNotice(context, args?.newInstall ?? false, 'any-project');
		})
	);
}

export function deactivate() {
	stopHttpServer();
}
