import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider, EngineProviderOption, FreshTableQueryResponse, PaginatedTableQueryResponse, QueryResponse } from '../types';
import { LaravelLocalSqliteProvider } from '../providers/sqlite/laravel-local-sqlite-provider';
import { FilePickerSqliteProvider } from '../providers/sqlite/file-picker-sqlite-provider';
import { ConfigFileProvider } from '../providers/config-file-provider';
import { LaravelMysqlProvider } from '../providers/mysql/laravel-mysql-provider';
import { getPaginationFor } from './pagination';

const workspaceTables: string[] = [];

const providers: DatabaseEngineProvider[] = [
	LaravelLocalSqliteProvider,
	FilePickerSqliteProvider,
	ConfigFileProvider,
	LaravelMysqlProvider,
]

let database: DatabaseEngine | null = null;

export async function handleIncomingMessage(data: any, webviewView: vscode.WebviewView) {
	const command = data.type.substring(data.type.indexOf(':') + 1);

	const actions: Record<string, () => unknown> = {
		'request:get-user-preferences' : async () => vscode.workspace.getConfiguration('Devdb'),
		'request:get-available-providers': async () => await getAvailableProviders(),
		'request:select-provider': async () => await selectProvider(data.value),
		'request:select-provider-option': async () => await selectProviderOption(data.value),
		'request:get-tables': async () => getTables(),
		'request:get-table-data': async () => await getTableData(data.value),
		'request:get-data-for-page': async () => await loadRowsForPage(data.value),
		'request:open-settings': async () => await vscode.commands.executeCommand('workbench.action.openSettings', 'DevDb.'),
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
		const availableProviders = await Promise.all(providers.map(async (provider) => {
		if (provider.boot) await provider.boot()

		const canBeUsed = await provider.canBeUsedInCurrentWorkspace()
		return canBeUsed ? provider : null
	}))

	return (availableProviders.filter((provider) => provider !== null) as DatabaseEngineProvider[])
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
		await vscode.window.showErrorMessage(`Could not find provider with id ${providerId}`)
		return false
	}

	database = await provider.getDatabaseEngine() as DatabaseEngine

	if (!database) {
		await vscode.window.showErrorMessage(`Provider selection error: Could not get database engine for ${providerId}`)
		return false
	}

	return true
}

async function selectProviderOption(option: EngineProviderOption): Promise<boolean> {
	const provider = (providers.find((provider: DatabaseEngineProvider) => provider.id === option.provider))

	if (!provider) {
		await vscode.window.showErrorMessage(`Could not find provider with id ${option}`)
		return false
	}

	database = await provider.getDatabaseEngine(option) as DatabaseEngine

	if (!database) {
		await vscode.window.showErrorMessage(`Provider option error: Could not get database engine for ${option.provider}`)
		return false
	}

	return true
}

async function getTableData(requestPayload: {
	table: string,
	itemsPerPage: number,
	whereClause: Record<string, any>,
}): Promise<FreshTableQueryResponse | undefined> {

	if (!database) return

	const totalRows = (await database?.getTotalRows(requestPayload.table, requestPayload.whereClause)) || 0
	const pagination = getPaginationFor(requestPayload.table, 1, totalRows, requestPayload.itemsPerPage)
	const limit = pagination.itemsPerPage
	const offset = 0
	const tableCreationSql = await database.getTableCreationSql(requestPayload.table)
	const columns = await database.getColumns(requestPayload.table)
	const queryResponse = await database.getRows(requestPayload.table, limit, offset, requestPayload.whereClause)

	if (!queryResponse) return

	return {
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
	page: number,
	whereClause: Record<string, any>
	totalRows: number,
	itemsPerPage: number,
}): Promise<PaginatedTableQueryResponse | undefined> {

	if (!database) return

	const pagination = getPaginationFor(requestPayload.table, requestPayload.page, requestPayload.totalRows, requestPayload.itemsPerPage)
	const limit = pagination.itemsPerPage
	const offset = (pagination.currentPage - 1) * limit

	const rows = await database.getRows(requestPayload.table, limit, offset, requestPayload.whereClause)

	return {
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