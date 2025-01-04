import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider, EngineProviderOption, TableQueryResponse, PaginatedTableQueryResponse, TableFilterPayload, TableFilterResponse, Column, SerializedMutation } from '../types';
import { LaravelLocalSqliteProvider } from '../providers/sqlite/laravel-local-sqlite-provider';
import { FilePickerSqliteProvider } from '../providers/sqlite/file-picker-sqlite-provider';
import { ConfigFileProvider } from '../providers/config-file-provider';
import { LaravelMysqlProvider } from '../providers/mysql/laravel-mysql-provider';
import { getPaginationFor } from './pagination';
import { LaravelPostgresProvider } from '../providers/postgres/laravel-postgres-provider';
import { exportTableData } from './export-table-data'; // Import the new export function
import { log } from './logging-service';
import { getRandomString } from './random-string-generator';

const workspaceTables: string[] = [];

const providers: DatabaseEngineProvider[] = [
	LaravelLocalSqliteProvider,
	FilePickerSqliteProvider,
	ConfigFileProvider,
	LaravelMysqlProvider,
	LaravelPostgresProvider,
]

export let database: DatabaseEngine | null = null;

export async function handleIncomingMessage(data: any, webviewView: vscode.WebviewView) {
	const command = data.type.substring(data.type.indexOf(':') + 1);

	const actions: Record<string, () => unknown> = {
		'request:get-user-preferences': async () => vscode.workspace.getConfiguration('Devdb'),
		'request:get-available-providers': async () => await getAvailableProviders(),
		'request:select-provider': async () => await selectProvider(data.value),
		'request:select-provider-option': async () => await selectProviderOption(data.value),
		'request:get-tables': async () => getTables(),
		'request:get-fresh-table-data': async () => await getFreshTableData(data.value),
		'request:get-refreshed-table-data': async () => await getFreshTableData(data.value),
		'request:load-table-into-current-tab': async () => await getFreshTableData(data.value),
		'request:get-filtered-table-data': async () => await getFilteredTableData(data.value),
		'request:get-data-for-tab-page': async () => await loadRowsForPage(data.value),
		'request:open-settings': async () => await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:damms005.devdb'),
		'request:export-table-data': async () => await exportTableData(data.value, database),
		'request:write-mutations': async () => await writeMutations(data.value),
	}

	const action = actions[data.type]
	if (!action) return

	const response = await action()
	if (response) reply(webviewView.webview, `response:${command}`, response)
	else acknowledge(webviewView.webview, `response:${command}`)
}

function reply(webview: vscode.Webview, command: string, response: unknown) {
	webview.postMessage({ type: command, value: response })
}

export function sendMessageToWebview(webview: vscode.Webview, payload: { type: string, value: any }) {
	webview.postMessage(payload)
}

function acknowledge(webview: vscode.Webview, command: string) {
	webview.postMessage({ type: command })
}

/**
 * Returns a list of all providers that can be used in the current workspace.
 */
async function getAvailableProviders() {
	log('Starting to get available providers...');

	const availableProviders = await Promise.all(providers.map(async (provider) => {
		log(`Checking provider: ${provider.name}`);
		if (provider.boot) await provider.boot()

		try {
			const canBeUsed = await provider.canBeUsedInCurrentWorkspace()
			log(`${provider.name} useable in workspace: ${canBeUsed ? 'yes' : 'no'}`);
			return canBeUsed ? provider : null
		} catch (error) {
			log(`error: ${provider.name} - ${String(error)}`);
			vscode.window.showErrorMessage(`Error resolving provider '${provider.name}': ${String(error)}`)
		}
	}))

	const filteredProviders = availableProviders.filter((provider) => provider) as DatabaseEngineProvider[];
	log(`Available providers: ${filteredProviders.map(provider => provider.name).join(', ')}`);

	return filteredProviders
		.map((provider) => ({
			name: provider.name,
			type: provider.type,
			id: provider.id,
			description: provider.description,
			options: provider.cache?.map((cache) => ({
				id: cache.id,
				description: cache.description,
				details: cache.details,
			})),
		}))
}

async function selectProvider(providerId: string): Promise<boolean> {
	const provider = (providers.find((provider: DatabaseEngineProvider) => provider.id === providerId))

	if (!provider) {
		vscode.window.showErrorMessage(`Could not find provider with id ${providerId}`)
		return false
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

	const totalRows = (await database?.getTotalRows(requestPayload.table, requestPayload.filters)) || 0
	const pagination = getPaginationFor(requestPayload.table, 1, totalRows, requestPayload.itemsPerPage)
	const limit = pagination.itemsPerPage
	const offset = 0
	const tableCreationSql = await database.getTableCreationSql(requestPayload.table)
	const columns = await database.getColumns(requestPayload.table)
	const queryResponse = await database.getRows(requestPayload.table, columns, limit, offset, requestPayload.filters)

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

	try {
		await Promise.all(serializedMutations.map(async (serializedMutation) => {
			if (!database) return
			return database.commitChange(serializedMutation)
		}))
	} catch (error) {
		response.outcome = 'error'
		response.errorMessage = String(error)
	}

	return response
}