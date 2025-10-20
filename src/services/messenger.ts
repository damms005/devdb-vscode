import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider, EngineProviderOption, TableQueryResponse, PaginatedTableQueryResponse, TableFilterPayload, TableFilterResponse, Column, SerializedMutation, EngineProviderCache, FilteredDatabaseEngineProvider } from '../types';
import { LaravelLocalSqliteProvider } from '../providers/sqlite/laravel-local-sqlite-provider';
import { FilePickerSqliteProvider } from '../providers/sqlite/file-picker-sqlite-provider';
import { ConfigFileProvider } from '../providers/config-file-provider';
import { LaravelMysqlProvider } from '../providers/mysql/laravel-mysql-provider';
import { getPaginationFor } from './pagination';
import { LaravelPostgresProvider } from '../providers/postgres/laravel-postgres-provider';
import { RailsPostgresProvider } from '../providers/postgres/rails-postgres-provider';
import { RailsMysqlProvider } from '../providers/mysql/rails-mysql-provider';
import { RailsSqliteProvider } from '../providers/sqlite/rails-sqlite-provider';
import { DjangoPostgresProvider } from '../providers/postgres/django-postgres-provider';
import { DjangoMysqlProvider } from '../providers/mysql/django-mysql-provider';
import { DjangoSqliteProvider } from '../providers/sqlite/django-sqlite-provider';
import { DdevMysqlProvider } from '../providers/mysql/ddev-mysql-provider';
import { DdevPostgresProvider } from '../providers/postgres/ddev-postgres-provider';
import { AdonisMysqlProvider } from '../providers/mysql/adonis-mysql-provider';
import { AdonisPostgresProvider } from '../providers/postgres/adonis-postgres-provider';
import { exportTableData } from './export-table-data';
import { log } from './logging-service';
import { getRandomString } from './random-string-generator';
import { logToOutput } from './output-service';
import { SqliteEngine } from '../database-engines/sqlite-engine';
import { DevDbViewProvider } from '../devdb-view-provider';
import { getWorkspaceId } from './mcp/http-server';
import { join } from 'path';

const workspaceTables: string[] = [];

let selectedProvider: string | null = null

const providers: DatabaseEngineProvider[] = [
	LaravelLocalSqliteProvider,
	FilePickerSqliteProvider,
	LaravelMysqlProvider,
	LaravelPostgresProvider,
	RailsSqliteProvider,
	RailsMysqlProvider,
	RailsPostgresProvider,
	DjangoSqliteProvider,
	DjangoMysqlProvider,
	DjangoPostgresProvider,
	ConfigFileProvider,
	DdevMysqlProvider,
	DdevPostgresProvider,
	AdonisMysqlProvider,
	AdonisPostgresProvider,
]

export let database: DatabaseEngine | null = null;

export async function getConnectedDatabase(): Promise<DatabaseEngine | null> {
	return database;
}

export async function handleIncomingMessage(data: any, webviewView: vscode.WebviewView) {
	const actions: Record<string, () => unknown> = {
		'request:get-user-preferences': async () => vscode.workspace.getConfiguration('Devdb'),
		'request:get-available-providers': async () => await getAvailableProviders(),
		'request:select-provider': async () => await selectProvider(data.value, data),
		'request:select-provider-option': async () => await selectProviderOption(data.value),
		'request:get-tables': async () => await getTables(),
		'request:get-fresh-table-data': async () => await getFreshTableData(data.value),
		'request:get-refreshed-table-data': async () => await getFreshTableData(data.value),
		'request:load-table-into-current-tab': async () => await getFreshTableData(data.value),
		'request:get-filtered-table-data': async () => await getFilteredTableData(data.value),
		'request:get-data-for-tab-page': async () => await loadRowsForPage(data.value),
		'request:open-settings': async () => await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:damms005.devdb'),
		'request:export-table-data': async () => await exportTableData(data.value, database),
		'request:write-mutations': async () => await writeMutations(data.value),
		'request:reconnect': async () => await reconnect(webviewView),
		'request:get-mcp-config': async () => {
			const cfg = vscode.workspace.getConfiguration('Devdb')
			if (!cfg.get<boolean>('enableMcpServer', true)) {
				return { error: "DevDb's MCP server is disabled" }
			}
			return getMcpConfig()
		},
	}

	const action = actions[data.type]
	if (!action) return

	const command = getResponseTagFor(data.type);

	const response = await action()
	if (response) reply(webviewView.webview, command, response)
	else acknowledge(webviewView.webview, command)
}

function getResponseTagFor(request: string): string {
	const command = request.substring(request.indexOf(':') + 1);

	return `response:${command}`
}

export async function reply(webview: vscode.Webview, command: string, response: unknown) {
	await webview.postMessage({ type: command, value: response })
}

export async function sendMessageToWebview(webview: vscode.Webview, payload: { type: string, value: any }) {
	await webview.postMessage(payload)
}

export async function acknowledge(webview: vscode.Webview, command: string) {
	await webview.postMessage({ type: command })
}

/**
 * Returns a list of all providers that can be used in the current workspace.
 */
export async function getAvailableProviders(): Promise<FilteredDatabaseEngineProvider[]> {
	log('Init', 'Getting available providers...');

	const availableProviders = await Promise.all(providers.map(async (provider) => {
		log('Init', `Checking provider: ${provider.name}`);
		if (provider.boot) await provider.boot()

		try {
			const canBeUsed = await provider.canBeUsedInCurrentWorkspace()
			log('Init', `${provider.name} useable in workspace: ${canBeUsed ? 'yes' : 'no'}`);
			return canBeUsed ? provider : null
		} catch (error) {
			log('Init', `error: ${provider.name} - ${String(error)}`);
			vscode.window.showErrorMessage(`Error resolving provider '${provider.name}': ${String(error)}`)
		}
	}))

	const filteredProviders = availableProviders.filter((provider) => provider) as DatabaseEngineProvider[];
	log('Init', `Available providers: ${filteredProviders.map(provider => provider.name).join(', ')}`);

	return filteredProviders
		.map((provider) => ({
			name: provider.name,
			type: provider.type,
			id: provider.id,
			description: provider.description,
			isDefault: Boolean(provider.isDefault),
			options: provider.cache
				? provider.cache.map((cache: EngineProviderCache) => ({
					id: cache.id,
					type: cache.engine.getType(),
					description: cache.description || provider.description,
					details: cache.details,
				}))
				: null,
		}))
}

export async function autoConnectProvider(devDbViewProvider: DevDbViewProvider, provider: FilteredDatabaseEngineProvider): Promise<DatabaseEngine | null> {

	vscode.commands.executeCommand('devdb.focus');

	const availableProvidersCommand = getResponseTagFor('request:get-available-providers');
	await devDbViewProvider.sendUnsolicitedResponse(availableProvidersCommand, await getAvailableProviders())

	const selectProviderCommand = getResponseTagFor('request:select-provider')
	if (!await selectProvider(provider.id, { type: 'request:select-provider', value: provider.id })) {
		logToOutput('Failed to select provider', 'Auto Connect')
		return null
	}
	await devDbViewProvider.sendUnsolicitedResponse(selectProviderCommand, provider.id)

	const listTablesCommand = getResponseTagFor('request:get-tables')
	await devDbViewProvider.sendUnsolicitedResponse(listTablesCommand, await getTables())

	return database
}

async function selectProvider(providerId: string, data: any): Promise<boolean> {

	selectedProvider = data

	const provider = (providers.find((provider: DatabaseEngineProvider) => provider.id === providerId))

	if (!provider) {
		vscode.window.showErrorMessage(`Could not find provider with id ${providerId}`)
		return false
	}

	if (provider.ddev) {
		await provider.reconnect()
	}

	database = await provider.getDatabaseEngine() as DatabaseEngine

	if (!database) {
		vscode.window.showErrorMessage(`Provider selection error: Could not get database engine for ${providerId}`)
		return false
	}

	return true
}

async function selectProviderOption(option: EngineProviderOption): Promise<boolean> {
	const provider = (providers.find((provider: DatabaseEngineProvider) => provider.id === option.provider))

	if (!provider) {
		vscode.window.showErrorMessage(`Could not find provider with id ${option}`)
		return false
	}

	database = await provider.getDatabaseEngine(option) as DatabaseEngine

	if (!database) {
		vscode.window.showErrorMessage(`Provider option error: Could not get database engine for ${option.provider}`)
		return false
	}

	return true
}

async function getFreshTableData(requestPayload: {
	table: string,
	itemsPerPage: number,
}): Promise<TableQueryResponse | undefined> {
	return getTableData({
		table: requestPayload.table,
		itemsPerPage: requestPayload.itemsPerPage,
	})
}

export async function getFilteredTableData(requestPayload: TableFilterPayload): Promise<TableFilterResponse | undefined> {
	const tableData: TableQueryResponse | undefined = await getTableData({
		table: requestPayload.table,
		itemsPerPage: requestPayload.itemsPerPage,
		filters: requestPayload.filters,
	})

	if (!tableData) return

	return {
		...tableData,
		filters: requestPayload.filters,
	}
}

async function getTableData(requestPayload: {
	table: string,
	itemsPerPage: number,
	filters?: Record<string, any>,
}): Promise<TableQueryResponse | undefined> {

	if (!database) return

	const columns = await database.getColumns(requestPayload.table)
	const queryResponse = await database.getRows(requestPayload.table, columns, requestPayload.itemsPerPage, 0, requestPayload.filters)
	const totalRows = (await database?.getTotalRows(requestPayload.table, columns, requestPayload.filters))
	const pagination = getPaginationFor(requestPayload.table, 1, totalRows, requestPayload.itemsPerPage)
	const tableCreationSql = await database.getTableCreationSql(requestPayload.table)

	if (!queryResponse) return

	return {
		id: getRandomString('tab-'),
		table: requestPayload.table,
		tableCreationSql,
		lastQuery: queryResponse.sql,
		columns,
		rows: queryResponse.rows || [],
		totalRows,
		pagination,
	}
}

async function loadRowsForPage(requestPayload: {
	table: string,
	columns: Column[],
	page: number,
	whereClause: Record<string, any>
	totalRows: number,
	itemsPerPage: number,
}): Promise<PaginatedTableQueryResponse | undefined> {

	if (!database) return

	const pagination = getPaginationFor(requestPayload.table, requestPayload.page, requestPayload.totalRows, requestPayload.itemsPerPage)
	const limit = pagination.itemsPerPage
	const offset = (pagination.currentPage - 1) * limit

	const rows = await database.getRows(requestPayload.table, requestPayload.columns, limit, offset, requestPayload.whereClause)

	return {
		id: getRandomString('tab-'),
		table: requestPayload.table,
		lastQuery: rows?.sql,
		rows: rows?.rows || [],
		totalRows: requestPayload.totalRows,
		pagination,
	}
}

async function getTables(): Promise<string[] | undefined> {
	const tables = await database?.getTables()

	if (tables) {

		logToOutput(`Tables available: ${tables.length}`, `Comm - ${database?.getType()}- ${await database?.getVersion()}`)

		workspaceTables.push(...tables)
	}

	return tables
}

export function getWorkspaceTables() {
	return workspaceTables
}

export function tableExists(tableName: string) {
	return workspaceTables.includes(tableName)
}

export function isTablesLoaded() {
	return workspaceTables.length > 0
}

async function writeMutations(serializedMutations: SerializedMutation[]) {
	const response = {
		tabId: serializedMutations[0].tabId,
		outcome: 'success',
		errorMessage: '',
	}

	if (!database) {
		response.outcome = 'error';
		response.errorMessage = 'No database selected';
		return response
	}

	const transaction = (database.getType()) === 'sqlite'
		? await (database as SqliteEngine).transaction()
		: await (database.getConnection())?.transaction();

	if (!transaction) {
		response.outcome = 'error';
		response.errorMessage = 'Could not start transaction';
		return response
	}

	try {
		await Promise.all(serializedMutations.map(async (serializedMutation) => {
			if (!database) return;
			return database.commitChange(serializedMutation, transaction);
		}));

		await transaction.commit();
	} catch (error) {
		response.outcome = 'error';
		response.errorMessage = String(error);
		await transaction.rollback();
	}

	return response
}

async function reconnect(webviewView: vscode.WebviewView) {
	if (selectedProvider) {
		await handleIncomingMessage(selectedProvider, webviewView);
		return true
	}

	vscode.window.showErrorMessage('No existing connection')
}


function getMcpConfig() {
	/**
	 * Get actual path even after building
	 *
	 * @see https://github.com/damms005/devdb-vscode/blob/f0f6e12616c860027e882eed9c602066e998aa1f/esbuild.js#L8
	 */
	const scriptPath = join(__dirname, 'services/mcp/no-vscode/server.js')

	return {
		'devdb-mcp-server': {
			command: 'node',
			args: [scriptPath],
			env: {
				'WORKSPACE_ID': getWorkspaceId()
			}
		}
	}
}