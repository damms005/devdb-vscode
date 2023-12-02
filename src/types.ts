import { MysqlEngine } from "./database-engines/mysql-engine"
import { PaginationData } from "./services/pagination"

export type ConnectionType = 'laravel-sail' | 'laravel-local-sqlite'

export interface Column {
	name: string,
	type: string,
	isPrimaryKey: boolean,
	isOptional: boolean,
}

export type EngineProviderOption = {
	provider: string,
	option: { id: string, description: string }
}

export type EngineProviderCache = {
	id: string,
	description: string,
	details?: string,
	engine: MysqlEngine,
}

export type DatabaseEngineProvider = {
	name: string
	type: 'sqlite' | 'mysql'
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

	getTotalRows(table: string, whereClause?: Record<string, any>): Promise<number | null>

	/**
	 * Gets the rows in a table
	 */
	getRows(table: string, limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined>
}

export type QueryResponse = {
	rows: any[]
	sql?: string
}

export interface PaginatedTableQueryResponse {
	rows: any[]
	totalRows: number
	lastQuery?: string,
	table: string
	pagination: PaginationData
	columns?: Column[]
}

export interface FreshTableQueryResponse extends PaginatedTableQueryResponse {
	tableCreationSql: string,
}

export type SqliteConfig = {
	type: 'sqlite'
	path: string
}

export type MysqlConfig = {
	type: 'mysql'
	host: string
	port: number
	username: string
	password: string
	database: string
}

export interface MysqlConfigFileEntry extends MysqlConfig {
	name: string
}
