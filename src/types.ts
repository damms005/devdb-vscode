import { MysqlEngine } from "./database-engines/mysql-engine"
import { PaginationData } from "./services/pagination"
import knexlib from "knex";
import { MssqlEngine } from "./database-engines/mssql-engine";
import { SQLiteEngineProvider, SQLiteTransaction } from "./database-engines/sqlite-engine-provider";
import { SqliteEngine } from "./database-engines/sqlite-engine";

export type ConnectionType = 'laravel-sail' | 'laravel-local-sqlite'

export interface Column {
	name: string,
	type: string,
	isPrimaryKey: boolean,
	isNumeric?: boolean,
	isPlainTextType?: boolean,
	isNullable?: boolean,
	isEditable?: boolean,
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
	type: ConfigFileConnectionTypes,
	engine: MysqlEngine | MssqlEngine | SqliteEngine,
}

/**
 * Important to use mysql2 instead of mysql
 *
 * @see https://github.com/knex/knex/issues/3233#issuecomment-988579036
 */
export type KnexClient = 'mysql2' | 'postgres' | 'mssql' | 'sqlite'

export type DatabaseEngineProvider = {
	name: string
	type: 'sqlite' | 'mysql' | 'postgres' | 'mssql'
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

	resolveConfiguration?: (config: SqliteConfig | MysqlConfig | PostgresConfig | MssqlConfig) => Promise<boolean>

	/**
	 * The handler provided by this provider
	 */
	getDatabaseEngine(option?: EngineProviderOption): Promise<DatabaseEngine | undefined>
}

export interface DatabaseEngine {
	getType(): KnexClient

	getConnection(): knexlib.Knex | SQLiteEngineProvider | null

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

	getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number>

	getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined>

	commitChange(serializedMutation: SerializedMutation, transaction?: knexlib.Knex.Transaction | SQLiteTransaction): Promise<void>

	getVersion(): Promise<string | undefined>

	rawQuery(code: string): Promise<any>
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

// As used in snippets/devdbrc.json
export type ConfigFileConnectionTypes = 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'mssql'

export type SqlConfig = {
	name: string
	type: ConfigFileConnectionTypes
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

export type KnexClientType = 'mysql2' | 'postgres' | 'mssql'

export type WhereEntry = {
	column: string
	operator: string
	value: any
	useRawCast?: boolean
}
