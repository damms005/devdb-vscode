import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider, EngineProviderOption, TableQueryResponse, PaginatedTableQueryResponse, TableFilterPayload, TableFilterResponse, Column, SerializedMutation, EngineProviderCache, FilteredDatabaseEngineProvider, MongodbConfig, MysqlSshConfigFile, PostgresSshConfigFile } from '../types';
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
import { SupabasePostgresProvider } from '../providers/postgres/supabase-postgres-provider';
import { exportTableData } from './export-table-data';
import { log } from './logging-service';
import { getRandomString } from './random-string-generator';
import { logToOutput } from './output-service';
import { SqliteEngine } from '../database-engines/sqlite-engine';
import { MysqlEngine } from '../database-engines/mysql-engine';
import { PostgresEngine } from '../database-engines/postgres-engine';
import { MongodbEngine } from '../database-engines/mongodb-engine';
import { MysqlSshEngine } from '../database-engines/mysql-ssh-engine';
import { PostgresSshEngine } from '../database-engines/postgres-ssh-engine';
import { DevDbViewProvider } from '../devdb-view-provider';
import { join } from 'path';
import { remoteConnectionStorageService, StoredRemoteConnection } from './remote-connection-storage-service';
import { remoteCredentialService } from './remote-credential-service';
import { getConnectionFor } from './connector';
import { getRandomString as generateId } from './random-string-generator';

const workspaceTables: string[] = [];

let selectedProvider: string | null = null
let licenseChecker: (() => boolean) | null = null

export function setLicenseChecker(checker: () => boolean) {
	licenseChecker = checker
}

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
	SupabasePostgresProvider,
]

export let database: DatabaseEngine | null = null;

export async function getConnectedDatabase(): Promise<DatabaseEngine | null> {
	return database;
}

export async function handleIncomingMessage(data: any, webviewView: vscode.WebviewView) {
	const actions: Record<string, () => unknown> = {
		'request:get-user-preferences': async () => vscode.workspace.getConfiguration('Devdb'),
		'request:get-license-status': async () => ({ hasLicense: licenseChecker?.() ?? false }),
		'request:activate-license': async () => {
			await vscode.commands.executeCommand('devdb.license.manage');
			const licenseStatus = { hasLicense: licenseChecker?.() ?? false };
			reply(webviewView.webview, 'response:get-license-status', licenseStatus);
			return undefined;
		},
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
		'request:get-remote-connections': async () => await remoteConnectionStorageService.getListItems(),
		'request:save-remote-connection': async () => await saveRemoteConnection(data.value),
		'request:connect-to-remote': async () => await connectToRemoteConnection(data.value),
		'request:delete-remote-connection': async () => {
			await remoteConnectionStorageService.delete(data.value)
			return await remoteConnectionStorageService.getListItems()
		},
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


async function saveRemoteConnection(formData: any) {
	const connectionType = formData.connectionType as string
	const port = formData.dbPort ? Number(formData.dbPort) : undefined
	const isPostgres = port === 5432

	let type: StoredRemoteConnection['type']
	if (connectionType === 'ssh-tunnel') {
		type = isPostgres ? 'postgres-ssh' : 'mysql-ssh'
	} else if (connectionType === 'mongodb') {
		type = 'mongodb'
	} else {
		type = isPostgres ? 'postgres' : 'mysql'
	}

	const connection: StoredRemoteConnection = {
		id: generateId('rc-'),
		name: formData.connectionName,
		type,
		host: formData.dbHost || 'localhost',
		port,
		username: formData.dbUsername || undefined,
		database: formData.dbName || undefined,
		sshHost: formData.sshHost || undefined,
		sshPort: formData.sshPort ? Number(formData.sshPort) : undefined,
		sshUsername: formData.sshUsername || undefined,
		sshPrivateKeyPath: formData.sshPrivateKeyPath || undefined,
		mongoConnectionString: formData.mongoConnectionString || undefined,
	}

	await remoteConnectionStorageService.save(connection, formData.dbPassword || undefined)

	return await remoteConnectionStorageService.getListItems()
}

async function connectToRemoteConnection(connectionId: string) {
	const connection = await remoteConnectionStorageService.getById(connectionId)
	if (!connection) {
		return { connected: false, error: 'Connection not found' }
	}

	try {
		let engine: DatabaseEngine | null = null

		if (connection.type === 'mongodb') {
			const password = await remoteCredentialService.getCredential(connection.name, 'password')
			const config: MongodbConfig = {
				name: connection.name,
				type: 'mongodb',
				host: connection.host,
				port: connection.port,
				username: connection.username,
				database: connection.database ?? '',
				authSource: connection.authSource,
				schemaSampleSize: connection.schemaSampleSize,
				password: password ?? undefined,
				connectionString: connection.mongoConnectionString,
			}
			const mongoEngine = new MongodbEngine(config)
			if (!(await mongoEngine.connect())) {
				return { connected: false, error: `Failed to connect to MongoDB: ${connection.name}` }
			}
			engine = mongoEngine
		}

		if (connection.type === 'mysql-ssh') {
			const config: MysqlSshConfigFile = {
				name: connection.name,
				type: 'mysql-ssh',
				host: connection.host,
				port: connection.port,
				username: connection.username,
				database: connection.database ?? '',
				sshHost: connection.sshHost ?? '',
				sshPort: connection.sshPort,
				sshUsername: connection.sshUsername ?? '',
				sshPrivateKeyPath: connection.sshPrivateKeyPath,
			}
			const sshEngine = new MysqlSshEngine(config, remoteCredentialService)
			if (!(await sshEngine.connect())) {
				return { connected: false, error: `Failed to connect via SSH to MySQL: ${connection.name}` }
			}
			engine = sshEngine
		}

		if (connection.type === 'postgres-ssh') {
			const config: PostgresSshConfigFile = {
				name: connection.name,
				type: 'postgres-ssh',
				host: connection.host,
				port: connection.port,
				username: connection.username,
				database: connection.database ?? '',
				sshHost: connection.sshHost ?? '',
				sshPort: connection.sshPort,
				sshUsername: connection.sshUsername ?? '',
				sshPrivateKeyPath: connection.sshPrivateKeyPath,
			}
			const sshEngine = new PostgresSshEngine(config, remoteCredentialService)
			if (!(await sshEngine.connect())) {
				return { connected: false, error: `Failed to connect via SSH to PostgreSQL: ${connection.name}` }
			}
			engine = sshEngine
		}

		if (connection.type === 'mysql') {
			const password = await remoteCredentialService.getCredential(connection.name, 'password')
			const knex = await getConnectionFor(
				connection.name, 'mysql2',
				connection.host, connection.port ?? 3306,
				connection.username ?? 'root', password ?? '',
				connection.database, false
			)
			if (!knex) {
				return { connected: false, error: `Failed to connect to MySQL: ${connection.name}` }
			}
			const mysqlEngine = new MysqlEngine(knex)
			if (!(await mysqlEngine.isOkay())) {
				return { connected: false, error: `MySQL connection not healthy: ${connection.name}` }
			}
			engine = mysqlEngine
		}

		if (connection.type === 'postgres') {
			const password = await remoteCredentialService.getCredential(connection.name, 'password')
			const knex = await getConnectionFor(
				connection.name, 'postgres',
				connection.host, connection.port ?? 5432,
				connection.username ?? 'postgres', password ?? '',
				connection.database, false
			)
			if (!knex) {
				return { connected: false, error: `Failed to connect to PostgreSQL: ${connection.name}` }
			}
			const pgEngine = new PostgresEngine(knex)
			if (!(await pgEngine.isOkay())) {
				return { connected: false, error: `PostgreSQL connection not healthy: ${connection.name}` }
			}
			engine = pgEngine
		}

		if (!engine) {
			return { connected: false, error: `Unsupported connection type: ${connection.type}` }
		}

		database = engine
		await remoteConnectionStorageService.updateLastConnected(connectionId)
		return { connected: true }
	} catch (error) {
		return { connected: false, error: String(error) }
	}
}

function getMcpConfig() {
	const scriptPath = join(__dirname, 'services/mcp/no-vscode/server.js')

	const codeConfig = JSON.stringify(
		{
			'devdb-mcp-server': {
				command: 'node',
				args: [scriptPath],
				env: [],
			},
		},
		null,
		2,
	)

	const mcpServerConfig = [
		{
			name: 'Claude Code',
			config: `claude mcp add --transport stdio devdb-mcp-server node "${scriptPath}"`,
			onCopyMessage: 'Command copied to clipboard. Run the command to add DevDb MCP server to Claude Code.',
		},
		{
			name: 'Cursor/VS Code',
			config: codeConfig,
			onCopyMessage: 'Config copied to clipboard. Add it to your config file. e.g. .vscode/mcp.json',
		},
		{
			name: 'Windsurf',
			onCopyMessage: 'Config copied to clipboard. Add it to your config file. e.g. ~/.codeium/windsurf/mcp_config.json',
			config: codeConfig,
		},
	]

	return mcpServerConfig
}