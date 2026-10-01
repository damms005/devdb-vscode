import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider, EngineProviderOption, TableQueryResponse, PaginatedTableQueryResponse, TableFilterPayload, TableFilterResponse, Column, SerializedMutation, EngineProviderCache, FilteredDatabaseEngineProvider } from '../types';
import { LaravelLocalSqliteProvider } from '../providers/sqlite/laravel-local-sqlite-provider';
import { FilePickerSqliteProvider } from '../providers/sqlite/file-picker-sqlite-provider';
import { FilePickerDuckDbProvider } from '../providers/duckdb/file-picker-duckdb-provider';
import { NeonPostgresProvider } from '../providers/postgres/neon-postgres-provider';
import { CloudflareD1LocalProvider } from '../providers/sqlite/cloudflare-d1-local-provider';
import { TursoProvider } from '../providers/sqlite/turso-provider';
import { findD1Suggestions } from '../providers/cloudflare/d1-suggestions';
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
import { LaravelDatastoresSource } from '../providers/laravel/laravel-datastores-source';
import { PrismaSource } from '../providers/prisma/prisma-source';
import { DrizzleSource } from '../providers/drizzle/drizzle-source';
import { DatabaseUrlSource } from '../providers/env/database-url-source';
import { DockerComposeSource } from '../providers/docker-compose/compose-source';
import { detectZeroConfigProviders, getKnownZeroConfigProviders } from '../providers/zero-config/zero-config-provider';
import { ZeroConfigSource } from '../providers/zero-config/detected-datastore';
import { exportTableData } from './export-table-data';
import { log } from './logging-service';
import { getRandomString } from './random-string-generator';
import { logToOutput } from './output-service';
import { SqliteEngine } from '../database-engines/sqlite-engine';
import { PostgresEngine } from '../database-engines/postgres-engine';
import { RedisEngine, RedisNamespace } from '../database-engines/redis-engine';
import { DuckDbEngine } from '../database-engines/duckdb-engine';
import { DevDbViewProvider } from '../devdb-view-provider';
import { join } from 'path';
import { connectionToFormData, RemoteConnectionFormData, remoteConnectionStorageService } from './remote-connection-storage-service';
import { errorMessage } from './remote-credential-service';
import { embeddingService, EmbeddingConfigInput } from './embedding-service';
import { createRemoteEngine, testRemoteConnection } from './connection-tester';
import { hasProLicense, proEngineLabel, proRequiredMessage, PRO_ENGINE_TYPES, PRO_PROVIDER_IDS, setProLicenseChecker } from './pro-gate';
import { listAwsProfiles } from './aws-profiles';
import { DynamoDbLocalProvider } from '../providers/dynamodb/dynamodb-local-provider';
import { createGiftLink } from './gift-service';
import { EditorRunResponse, getEditorSchema, runEditorQuery, sqlEditorStateStore } from './sql-editor/sql-editor-service';
import { classifyStatement, EditorStatementInfo } from './sql-editor/statement-classifier';

let workspaceTables: string[] = [];

let selectedProvider: string | null = null
let connectionId = 0

/**
 * Tracks the currently in-flight table-data/raw query so it can be cancelled.
 * Only engines that accept an {@link AbortSignal} (e.g. ClickHouse) will actually
 * abort; for others `cancel-query` is a harmless no-op.
 */
let activeQueryController: AbortController | null = null

function beginQuery(): AbortSignal {
	activeQueryController?.abort()
	activeQueryController = new AbortController()
	return activeQueryController.signal
}

function endQuery(controller: AbortController | null): void {
	if (activeQueryController === controller) {
		activeQueryController = null
	}
}

function cancelActiveQuery(): void {
	activeQueryController?.abort()
	activeQueryController = null
}

export function setLicenseChecker(checker: () => boolean) {
	setProLicenseChecker(checker)
}

/**
 * Runs a Pro-only request handler, or answers with `refusal` when no DevDb Pro license is active.
 */
async function withPro<T>(feature: string, refusal: (message: string) => T, handler: () => Promise<T>): Promise<T> {
	if (!hasProLicense()) {
		return refusal(proRequiredMessage(feature))
	}

	return handler()
}

const providers: DatabaseEngineProvider[] = [
	LaravelLocalSqliteProvider,
	FilePickerSqliteProvider,
	CloudflareD1LocalProvider,
	FilePickerDuckDbProvider,
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
	NeonPostgresProvider,
	TursoProvider,
	DynamoDbLocalProvider,
]

/**
 * Zero-config sources. Each detected datastore becomes its own provider row. When several
 * sources point at the same database, the first source in this list names the row.
 */
const zeroConfigSources: ZeroConfigSource[] = [
	LaravelDatastoresSource,
	PrismaSource,
	DrizzleSource,
	DatabaseUrlSource,
	DockerComposeSource,
]

function findProvider(providerId: string): DatabaseEngineProvider | undefined {
	return providers.find(provider => provider.id === providerId)
		?? getKnownZeroConfigProviders().find(provider => provider.id === providerId)
}

function isProProvider(provider: DatabaseEngineProvider): boolean {
	return PRO_PROVIDER_IDS.includes(provider.id) || PRO_ENGINE_TYPES.includes(provider.type)
}

let database: DatabaseEngine | null = null;

export function getDatabase(): DatabaseEngine | null {
	return database;
}

export async function handleIncomingMessage(data: any, webviewView: vscode.WebviewView) {
	const actions: Record<string, () => unknown> = {
		'request:get-user-preferences': async () => vscode.workspace.getConfiguration('Devdb'),
		'request:get-license-status': async () => ({ hasLicense: hasProLicense() }),
		'request:activate-license': async () => {
			await vscode.commands.executeCommand('devdb.license.manage');
			const licenseStatus = { hasLicense: hasProLicense() };
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
		'request:get-remote-connection': async () => await getRemoteConnectionFormData(data.value),
		'request:test-remote-connection': async () => await testRemoteConnection(data.value),
		'request:get-d1-suggestions': async () => findD1Suggestions(),
		'request:get-aws-profiles': async () => ({ profiles: listAwsProfiles() }),
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
		'request:create-gift-link': async () => await createGiftLink(data.value),
		'request:pgvector-similarity-search': async () => await withPro('Vector similarity search', error => ({ rows: [], error }), () => pgvectorSimilaritySearch(data.value)),
		'request:get-embedding-configs': async () => ({ configs: embeddingService.getConfigs() }),
		'request:save-embedding-config': async () => await withPro('Vector similarity search', (error): { configs: ReturnType<typeof embeddingService.getConfigs>, error?: string } => ({ configs: embeddingService.getConfigs(), error }), async () => ({ configs: await embeddingService.saveConfig(data.value.config as EmbeddingConfigInput) })),
		'request:delete-embedding-config': async () => ({ configs: await embeddingService.deleteConfig(data.value.id as string) }),
		'request:test-embedding-config': async () => await withPro('Vector similarity search', error => ({ ok: false, error }), () => embeddingService.testConfig(data.value)),
		'request:summarize-table': async () => await withPro('DuckDB', error => ({ error }), () => summarizeTable(data.value)),
		'request:run-raw-command': async () => await withPro(database?.getType() === 'redis' ? 'Redis / Valkey' : 'SQL Editor', error => ({ error, runId: data.value?.runId }), () => runRawCommand(data.value)),
		'request:get-sql-editor-schema': async () => await withPro('SQL Editor', error => ({ tables: {}, error }), () => getSqlEditorSchema()),
		'request:get-sql-editor-state': async () => ({ key: data.value?.key, state: sqlEditorStateStore.get(data.value?.key) }),
		'request:save-sql-editor-state': async () => {
			await sqlEditorStateStore.save(data.value?.key, data.value?.state)
			return undefined
		},
		'request:refresh-tables': async () => await getTables(),
		'request:get-redis-namespaces': async () => await withPro('Redis / Valkey', error => ({ error }), () => getRedisNamespaces()),
		'request:cancel-query': async () => {
			cancelActiveQuery()
			return undefined
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

	const zeroConfigProviders = await Promise.all(detectZeroConfigProviders(zeroConfigSources).map(async (provider) => {
		if (provider.isProLocked()) {
			log('Init', `${provider.name} needs DevDb Pro; listed as locked`);
			return { provider, proLocked: true }
		}

		const canBeUsed = await provider.canBeUsedInCurrentWorkspace()
		log('Init', `${provider.name} useable in workspace: ${canBeUsed ? 'yes' : 'no'}`);
		return canBeUsed ? { provider, proLocked: false } : null
	}))

	const usableZeroConfigProviders = zeroConfigProviders.filter((entry) => entry) as { provider: DatabaseEngineProvider, proLocked: boolean }[]
	log('Init', `Available providers: ${[...filteredProviders, ...usableZeroConfigProviders.map(entry => entry.provider)].map(provider => provider.name).join(', ')}`);

	return [
		...filteredProviders.map((provider) => ({ provider, proLocked: false })),
		...usableZeroConfigProviders,
	]
		.map(({ provider, proLocked }) => ({
			name: provider.name,
			type: provider.type,
			id: provider.id,
			description: provider.description,
			isDefault: Boolean(provider.isDefault),
			...(proLocked ? { proLocked: true } : {}),
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
	const thisConnectionId = ++connectionId

	const provider = findProvider(providerId)

	if (!provider) {
		vscode.window.showErrorMessage(`Could not find provider with id ${providerId}`)
		return false
	}

	if (isProProvider(provider) && !hasProLicense()) {
		vscode.window.showErrorMessage(proRequiredMessage(provider.name))
		return false
	}

	if (provider.ddev) {
		await provider.reconnect()
	}

	const engine = await provider.getDatabaseEngine() as DatabaseEngine

	if (thisConnectionId !== connectionId) return false

	if (!engine) {
		if (!provider.reportsOwnErrors) vscode.window.showErrorMessage(`Provider selection error: Could not get database engine for ${providerId}`)
		return false
	}

	if (!ensureProEngineAllowed(engine)) return false

	database = engine
	return true
}

async function selectProviderOption(option: EngineProviderOption): Promise<boolean> {
	const thisConnectionId = ++connectionId
	const provider = findProvider(option.provider)

	if (!provider) {
		vscode.window.showErrorMessage(`Could not find provider with id ${option}`)
		return false
	}

	if (isProProvider(provider) && !hasProLicense()) {
		vscode.window.showErrorMessage(proRequiredMessage(provider.name))
		return false
	}

	const engine = await provider.getDatabaseEngine(option) as DatabaseEngine

	if (thisConnectionId !== connectionId) return false

	if (!engine) {
		if (!provider.reportsOwnErrors) vscode.window.showErrorMessage(`Provider option error: Could not get database engine for ${option.provider}`)
		return false
	}

	if (!ensureProEngineAllowed(engine)) return false

	database = engine
	return true
}

/**
 * Refuses engines of Pro datastore types (Redis, ClickHouse, DuckDB, remote D1, libSQL, DynamoDB) without a DevDb Pro license.
 */
function ensureProEngineAllowed(engine: DatabaseEngine): boolean {
	const type = engine.getType()
	if (!PRO_ENGINE_TYPES.includes(type) || hasProLicense()) return true

	vscode.window.showErrorMessage(proRequiredMessage(proEngineLabel(type)))
	return false
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

	const signal = beginQuery()
	const controller = activeQueryController

	try {
		const columns = await database.getColumns(requestPayload.table)
		const queryResponse = await database.getRows(requestPayload.table, columns, requestPayload.itemsPerPage, 0, requestPayload.filters, signal)
		const totalRows = (await database?.getTotalRows(requestPayload.table, columns, requestPayload.filters, signal))
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
			stats: queryResponse.stats,
		}
	} finally {
		endQuery(controller)
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

	const signal = beginQuery()
	const controller = activeQueryController

	try {
		const rows = await database.getRows(requestPayload.table, requestPayload.columns, limit, offset, requestPayload.whereClause, signal)

		return {
			id: getRandomString('tab-'),
			table: requestPayload.table,
			lastQuery: rows?.sql,
			rows: rows?.rows || [],
			totalRows: requestPayload.totalRows,
			pagination,
			stats: rows?.stats,
		}
	} finally {
		endQuery(controller)
	}
}

async function summarizeTable(payload: { table: string }): Promise<{ rows?: Record<string, any>[], error?: string }> {
	if (!database) {
		return { error: 'No database selected' }
	}

	const engine = database as DuckDbEngine
	if (typeof engine.summarize !== 'function') {
		return { error: 'Summarize is only supported on DuckDB' }
	}

	const signal = beginQuery()
	const controller = activeQueryController

	try {
		return { rows: await engine.summarize(payload.table, signal) }
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
	} finally {
		endQuery(controller)
	}
}

/**
 * Runs SQL Editor text (any engine with `rawQuery`) or one Redis RESP command. Writes
 * run only when the webview says the user confirmed them.
 */
async function runRawCommand(payload: { command?: string, code?: string, runId?: string, confirmed?: boolean }): Promise<EditorRunResponse | { result?: string, error?: string, needsConfirmation?: EditorStatementInfo[] }> {
	if (!database) {
		return { error: 'No database selected', runId: payload?.runId } as EditorRunResponse
	}

	if (typeof database.rawQuery !== 'function') {
		return { error: 'This database does not run raw queries', runId: payload?.runId } as EditorRunResponse
	}

	const signal = beginQuery()
	const controller = activeQueryController

	try {
		if (database.getType() !== 'redis') {
			return await runEditorQuery(database, { runId: String(payload?.runId ?? ''), code: payload?.code ?? payload?.command ?? '', confirmed: payload?.confirmed }, signal)
		}

		const command = payload?.command ?? payload?.code ?? ''
		if (!command.trim()) {
			return { error: 'Empty command' }
		}

		const statement = classifyStatement(command.trim(), 'redis')
		if (statement.kind === 'write' && payload?.confirmed !== true) {
			return { needsConfirmation: [statement] }
		}

		const raw = await (database as RedisEngine).rawQuery(command, { signal })
		return { result: formatRawCommandResult(raw) }
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
	} finally {
		endQuery(controller)
	}
}

async function getSqlEditorSchema(): Promise<{ tables: Record<string, string[]>, error?: string }> {
	if (!database) {
		return { tables: {}, error: 'No database selected' }
	}

	try {
		return await getEditorSchema(database)
	} catch (error) {
		return { tables: {}, error: error instanceof Error ? error.message : String(error) }
	}
}

function formatRawCommandResult(result: unknown): string {
	if (result === null || result === undefined) {
		return '(nil)'
	}
	if (typeof result === 'string') {
		return result
	}
	if (Buffer.isBuffer(result)) {
		return result.toString()
	}
	return JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)
}

async function getRedisNamespaces(): Promise<{ namespaces?: RedisNamespace[], error?: string }> {
	if (!database) {
		return { error: 'No database selected' }
	}

	const engine = database as RedisEngine
	if (typeof engine.getNamespaces !== 'function') {
		return { error: 'Namespaces are only supported on Redis' }
	}

	try {
		return { namespaces: await engine.getNamespaces() }
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
	}
}

async function getTables(): Promise<string[] | undefined> {
	const tables = await database?.getTables()

	if (tables) {

		logToOutput(`Tables available: ${tables.length}`, `Comm - ${database?.getType()}- ${await database?.getVersion()}`)

		workspaceTables = [...tables]
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

	const isSqlite = database.getType() === 'sqlite';
	// Engines without a knex/sqlite connection (DuckDB, Redis, ClickHouse) manage their own
	// writes and do not use a transaction object; they apply changes directly in commitChange.
	const usesTransaction = isSqlite || database.getConnection() !== null;

	const transaction = isSqlite
		? await (database as SqliteEngine).transaction()
		: (usesTransaction ? await (database.getConnection())?.transaction() : undefined);

	if (usesTransaction && !transaction) {
		response.outcome = 'error';
		response.errorMessage = 'Could not start transaction';
		return response
	}

	try {
		await Promise.all(serializedMutations.map(async (serializedMutation) => {
			if (!database) return;
			return database.commitChange(serializedMutation, transaction as any);
		}));

		if (transaction) {
			await transaction.commit();
		}
	} catch (error) {
		response.outcome = 'error';
		response.errorMessage = String(error);
		if (transaction) {
			await transaction.rollback();
		}
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


async function getRemoteConnectionFormData(connectionId: string) {
	const stored = await remoteConnectionStorageService.getById(connectionId)
	if (!stored) return null

	return connectionToFormData(stored)
}

async function saveRemoteConnection(formData: RemoteConnectionFormData) {
	const { connection, update } = await remoteConnectionStorageService.prepareFromForm(formData)

	await remoteConnectionStorageService.save(connection, update)

	return await remoteConnectionStorageService.getListItems()
}

async function connectToRemoteConnection(remoteConnectionId: string) {
	const thisConnectionId = ++connectionId
	const connection = await remoteConnectionStorageService.getById(remoteConnectionId)
	if (!connection) {
		return { connected: false, error: 'Connection not found' }
	}

	const secrets = await remoteConnectionStorageService.getSecrets(connection)
	// getSecrets() falls back to the redacted display copy when the secret is gone.
	if (secrets.connectionString?.includes(':****@')) {
		return { connected: false, error: `The saved password for "${connection.name}" was not found. Edit the connection and enter the connection string again.` }
	}

	try {
		const result = await createRemoteEngine(connection, secrets)
		if (!result.engine) {
			return { connected: false, error: result.error }
		}

		if (thisConnectionId !== connectionId) {
			try { await result.engine.disconnect() } catch { }
			return { connected: false, error: 'Connection superseded by a newer request' }
		}

		database = result.engine
		await remoteConnectionStorageService.updateLastConnected(remoteConnectionId)
		return { connected: true }
	} catch (error) {
		return { connected: false, error: errorMessage(error) }
	}
}

async function pgvectorSimilaritySearch(payload: {
	table: string,
	column: string,
	reference?: number[] | string | number,
	queryText?: string,
	embedConfigId?: string,
	metric?: 'cosine' | 'l2' | 'ip' | 'l1',
	limit?: number,
	where?: string,
	efSearch?: number,
}): Promise<Record<string, any>> {
	if (!database) {
		return { rows: [], error: 'No database selected' }
	}

	const engine = database as PostgresEngine
	if (typeof engine.vectorSimilaritySearch !== 'function') {
		return { rows: [], error: 'Vector similarity search is only supported on PostgreSQL (pgvector)' }
	}

	const requestedLimit = payload.limit ?? 10

	try {
		let rawVector: number[] | undefined
		let embedding: { provider?: string, model?: string } | undefined

		if (payload.queryText && payload.queryText.trim().length > 0) {
			if (!payload.embedConfigId) {
				return { rows: [], requestedLimit, error: 'Choose an embedding endpoint to search by text' }
			}

			const embedded = await embeddingService.embedWithConfigId(payload.embedConfigId, payload.queryText.trim())
			rawVector = embedded.vector
			embedding = { provider: embedded.provider, model: embedded.model }
		}

		const columns = await engine.getColumns(payload.table)
		const { schemaName, tableName } = splitSchemaAndTable(payload.table)
		const dimensions = await engine.getVectorColumnDimensions(schemaName, tableName)
		const dimension = dimensions[payload.column.toLowerCase()]

		const result = await engine.vectorSimilaritySearch({
			table: payload.table,
			column: payload.column,
			reference: payload.reference,
			rawVector,
			metric: payload.metric,
			limit: requestedLimit,
			where: payload.where,
			efSearch: payload.efSearch,
		})

		if (!result) {
			return { rows: [], requestedLimit, error: 'Vector similarity search failed' }
		}

		const indexes = await engine.getVectorIndexes(payload.table, payload.column)
		const warnings = [...(result.warnings ?? [])]
		if (result.rows.length > 0 && result.rows.length < requestedLimit) {
			warnings.push(`Only ${result.rows.length} of ${requestedLimit} requested rows returned — a metadata filter may be too selective.`)
		}

		return {
			rows: result.rows,
			columns,
			metric: result.metric,
			operator: result.operator,
			scoreLabel: result.scoreLabel,
			limit: result.rows.length,
			requestedLimit,
			sql: result.sql,
			where: payload.where,
			dimension,
			queryDimension: result.queryDimension,
			scan: result.scan,
			indexes,
			warnings,
			embedding,
		}
	} catch (error) {
		return { rows: [], requestedLimit, error: error instanceof Error ? error.message : String(error) }
	}
}

function splitSchemaAndTable(table: string): { schemaName: string, tableName: string } {
	if (table.includes('.')) {
		const [schemaName, tableName] = table.split('.')
		return { schemaName, tableName }
	}

	return { schemaName: 'public', tableName: table }
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