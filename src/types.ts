import { Dialect, Sequelize, Transaction } from "sequelize"
import { MysqlEngine } from "./database-engines/mysql-engine"
import { PaginationData } from "./services/pagination"

export type ConnectionType = 'laravel-sail' | 'laravel-local-sqlite'

export interface Column {
	name: string,
	type: string,
	isPrimaryKey: boolean,
	isNumeric?: boolean,
	isNullable?: boolean,
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
	ddev?: boolean
	description: string
	engine?: DatabaseEngine
	cache?: EngineProviderCache[]

	boot?: () => Promise<void>

	reconnect: () => Promise<boolean>

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

	getSequelizeInstance(): Sequelize | null

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

	commitChange(serializedMutation: SerializedMutation, transaction?: Transaction): Promise<void>

	getVersion(): Promise<string | undefined>

	runArbitraryQueryAndGetOutput(code: string): Promise<any>
}

export type QueryResponse = {
	rows: any[]
	sql?: string
}

export interface PaginatedTableQueryResponse {
	id: string
	table: string
	rows: Record<string, any>[]
	totalRows: number
	lastQuery?: string,
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

export type BaseSerializedMutation = {
	type: 'cell-update' | 'row-delete'
	id: string
	table: string
	tabId: string
}

export interface SerializedCellUpdateMutation extends BaseSerializedMutation {
	type: 'cell-update'
	column: Column
	newValue: any
	primaryKeyColumn: string
	primaryKey: string | number
}

export interface CellUpdateMutation extends SerializedCellUpdateMutation {
	row: Record<string, any>
	rowIndex: number
	originalValue: any
}

export interface SerializedRowDeletionMutation extends BaseSerializedMutation {
	type: 'row-delete'
	primaryKey: string | number
	primaryKeyColumn: string
}

export interface RowDeletionMutation extends SerializedRowDeletionMutation {
	rowIndex: number
}

export type SerializedMutation = SerializedCellUpdateMutation | SerializedRowDeletionMutation

export type Mutation = CellUpdateMutation | RowDeletionMutation

export type ModelMap = {
	[model: string]: {
		/** Full path to the model file */
		filePath: string,
		table: string
	}
}
