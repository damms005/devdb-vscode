import { Dialect } from "sequelize"
import { MysqlEngine } from "./database-engines/mysql-engine"
import { PaginationData } from "./services/pagination"

export type ConnectionType = 'laravel-sail' | 'laravel-local-sqlite'

export interface Column {
	name: string,
	type: string,
	isPrimaryKey: boolean,
	isNumeric?: boolean,
	isOptional: boolean,
	foreignKey?: ForeignKey
}

export interface ForeignKey {
	table: string,
	column: string,
}

export type EngineProviderOption = {
	provider: string,
	option: { id: string, description: string }
}

export type EngineProviderCache = {
	id: string,
	details?: string,
	description: string,
	engine: MysqlEngine,
}

export type DatabaseEngineProvider = {
	name: string
	type: 'sqlite' | 'mysql' | 'postgres'
	id: string
	description: string
	engine?: DatabaseEngine
	cache?: EngineProviderCache[]

	boot?: () => Promise<void>

	/**
	 * Returns true if this provider can be used in the current VS Code workspace
	 */
	canBeUsedInCurrentWorkspace(): Promise<boolean>

	/**
	 * The handler provided by this provider
	 */
	getDatabaseEngine(option?: EngineProviderOption): Promise<DatabaseEngine | undefined>
}

export interface DatabaseEngine {
	getType(): Dialect

	/**
	 * Returns true if the connection is okay
	 */
	isOkay(): Promise<boolean>

	/**
 * Gets the tables in the database
 */
	getTables(): Promise<string[]>

	getTableCreationSql(table: string): Promise<string>

	getColumns(table: string): Promise<Column[]>

	/**
	 * Returns a list of column type names that are numeric
	 */
	getNumericColumnTypeNamesLowercase(): string[]

	getTotalRows(table: string, whereClause?: Record<string, any>): Promise<number | undefined>

	getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined>

	getVersion(): Promise<string | undefined>

	runArbitraryQueryAndGetOutput(code: string): Promise<any>
}

export type QueryResponse = {
	rows: any[]
	sql?: string
}

export interface PaginatedTableQueryResponse {
	rows: Record<string, any>[]
	totalRows: number
	lastQuery?: string,
	table: string
	pagination: PaginationData
	columns?: Column[]
}

export interface TableQueryResponse extends PaginatedTableQueryResponse {
	tableCreationSql: string,
}

export interface TableFilterPayload {
	table: string,
	itemsPerPage: number,
	filters: Record<string, any>,
}

export type FileExportType = 'sql' | 'json';

export interface TableFilterExportPayload extends TableFilterPayload {
	exportTo: 'file' | 'clipboard'
	exportType?: FileExportType
}

export interface TableFilterResponse extends Omit<TableFilterPayload, 'itemsPerPage'>, TableQueryResponse { }

export type SqliteConfig = {
	type: 'sqlite'
	path: string
}

export type SqlConfig = {
	name: string
	type: Dialect
	host: string
	port: number
	username: string
	password: string
	database: string
}

export interface MysqlConfig extends SqlConfig {
	type: 'mysql' | 'mariadb'
}

export interface PostgresConfig extends SqlConfig {
	type: 'postgres'
}

export interface MssqlConfig extends SqlConfig {
	type: 'mssql'
}

export type LaravelConnection = 'pgsql' | 'mysql'

export type Mutation = {
	row: Record<string, any>
	rowIndex: number
	column: Column
	originalValue: any
	newValue: any
}
