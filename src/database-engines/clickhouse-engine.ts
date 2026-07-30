import { createClient, ClickHouseClient, ClickHouseSettings, ResponseJSON } from '@clickhouse/client'
import knexlib from 'knex'
import { Column, ClickhouseConfig, DatabaseEngine, KnexClient, QueryResponse, QueryStats, SerializedMutation, SerializedCellUpdateMutation, SerializedRowDeletionMutation } from '../types'
import { SQLiteTransaction } from './sqlite-engine'
import { reportError } from '../services/initialization-error-service'

/**
 * Hard cap on the number of rows {@link ClickhouseEngine.rawQuery} will buffer
 * and return. Arbitrary user SQL has no inherent `LIMIT`, so without a cap a
 * `SELECT * FROM huge_table` would buffer every row into host memory.
 */
const RAW_QUERY_MAX_ROWS = 10_000

/** Byte ceiling on a raw-query result set (64 MiB) to bound host memory. */
const RAW_QUERY_MAX_RESULT_BYTES = 64 * 1024 * 1024

/** Wall-clock ceiling (seconds) on a single raw query. */
const RAW_QUERY_MAX_EXECUTION_TIME = 30

/**
 * Protective per-query settings applied to {@link ClickhouseEngine.rawQuery}.
 * `result_overflow_mode: 'break'` makes the server stop and return a partial
 * result once a ceiling is hit instead of throwing, and `max_block_size` bounds
 * how far past {@link RAW_QUERY_MAX_ROWS} a single block can overshoot before the
 * code-side hard cap trims it.
 */
const RAW_QUERY_PROTECTIVE_SETTINGS: ClickHouseSettings = {
	max_result_rows: String(RAW_QUERY_MAX_ROWS),
	max_result_bytes: String(RAW_QUERY_MAX_RESULT_BYTES),
	max_block_size: String(RAW_QUERY_MAX_ROWS),
	result_overflow_mode: 'break',
	max_execution_time: RAW_QUERY_MAX_EXECUTION_TIME,
}

/**
 * ClickHouse engine.
 *
 * ClickHouse speaks SQL over HTTP (default port 8123) so no native/socket driver
 * is needed; the official `@clickhouse/client` handles the HTTP transport.
 *
 * It does not fit the knex-based `SqlService` flow used by the relational
 * engines, so (like {@link import('./mongodb-engine').MongodbEngine}) it
 * implements the {@link DatabaseEngine} contract directly and returns `null`
 * from {@link getConnection}.
 *
 * Editing note: ClickHouse is append-oriented. Row-level updates/deletes are
 * expressed as asynchronous "mutations" (`ALTER TABLE ... UPDATE/DELETE`). We
 * implement {@link commitChange} using those mutations. They are eventually
 * consistent (not transactional), so the transaction argument is ignored.
 */
export class ClickhouseEngine implements DatabaseEngine {
	private client: ClickHouseClient | null = null
	private config: ClickhouseConfig

	constructor(config: ClickhouseConfig) {
		this.config = config
	}

	async connect(): Promise<boolean> {
		try {
			const host = this.config.host ?? 'localhost'
			const port = this.config.port ?? 8123
			const protocol = this.config.protocol ?? 'http'

			this.client = createClient({
				url: `${protocol}://${host}:${port}`,
				username: this.config.username ?? 'default',
				password: this.config.password ?? '',
				database: this.config.database ?? 'default',
				clickhouse_settings: {
					/**
					 * Return 64-bit integers (Int64/UInt64/Int128/…/Int256) as JSON
					 * strings, not numbers. JS numbers are IEEE-754 doubles and silently
					 * corrupt any integer above 2^53 (snowflake / UInt64 IDs). Keeping
					 * them as strings preserves the exact value end-to-end.
					 */
					output_format_json_quote_64bit_integers: 1,
				},
			})

			return await this.isOkay()
		} catch (error) {
			reportError(`ClickHouse connect error: ${error}`)
			this.client = null
			return false
		}
	}

	getType(): KnexClient {
		return 'clickhouse'
	}

	getConnection(): knexlib.Knex | null {
		return null
	}

	async isOkay(): Promise<boolean> {
		if (!this.client) {
			return false
		}

		try {
			const result = await this.client.ping()
			return result.success === true
		} catch (error) {
			reportError(`ClickHouse OK-check error: ${error}`)
			return false
		}
	}

	async disconnect(): Promise<void> {
		if (this.client) {
			await this.client.close()
			this.client = null
		}
	}

	async getTables(): Promise<string[]> {
		if (!this.client) {
			return []
		}

		const rows = await this.queryJson<{ name: string }>(
			'SELECT name FROM system.tables WHERE database = {database:String} ORDER BY name',
			{ database: this.currentDatabase() },
		)

		return rows.map(row => row.name)
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.client) {
			return []
		}

		type SystemColumn = { name: string, type: string, position: string | number, is_in_primary_key: number }

		const rows = await this.queryJson<SystemColumn>(
			`SELECT name, type, position, is_in_primary_key
			 FROM system.columns
			 WHERE database = {database:String} AND table = {table:String}
			 ORDER BY position`,
			{ database: this.currentDatabase(), table },
		)

		return rows.map(row => {
			const baseType = stripTypeWrappers(row.type)
			const baseTypeLower = baseType.toLowerCase()
			const isEditable = this.getEditableColumnTypeNamesLowercase().includes(baseTypeLower)

			return {
				name: row.name,
				type: row.type,
				isPrimaryKey: Number(row.is_in_primary_key) === 1,
				isNumeric: this.getNumericColumnTypeNamesLowercase().includes(baseTypeLower),
				isPlainTextType: this.getPlainStringTypes().includes(baseTypeLower),
				isNullable: isNullableType(row.type),
				isEditable,
				foreignKey: undefined,
			}
		})
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		const widths = ['8', '16', '32', '64', '128', '256']
		const ints = widths.flatMap(width => [`int${width}`, `uint${width}`])
		return [...ints, 'float32', 'float64', 'decimal', 'decimal32', 'decimal64', 'decimal128', 'decimal256']
	}

	getPlainStringTypes(): string[] {
		return ['string', 'fixedstring', 'uuid']
	}

	getEditableColumnTypeNamesLowercase(): string[] {
		return [...this.getNumericColumnTypeNamesLowercase(), ...this.getPlainStringTypes(), 'date', 'date32', 'datetime', 'datetime64']
	}

	async getTableCreationSql(table: string): Promise<string> {
		if (!this.client) {
			return ''
		}

		try {
			const rows = await this.queryJson<{ statement: string }>(
				`SHOW CREATE TABLE ${sanitizeIdentifier(this.currentDatabase())}.${sanitizeIdentifier(table)}`,
			)
			return rows[0]?.statement ?? ''
		} catch (error) {
			reportError(`ClickHouse SHOW CREATE TABLE error: ${error}`)
			return ''
		}
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>, signal?: AbortSignal): Promise<number> {
		if (!this.client) {
			return 0
		}

		const { clause, params } = this.buildWhereClause(columns, whereClause)
		const rows = await this.queryJson<{ count: string | number }>(
			`SELECT count() AS count FROM ${sanitizeIdentifier(table)}${clause}`,
			params,
			{ signal },
		)

		return Number(rows[0]?.count ?? 0)
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>, signal?: AbortSignal): Promise<QueryResponse | undefined> {
		if (!this.client) {
			return undefined
		}

		try {
			const { clause, params } = this.buildWhereClause(columns, whereClause)
			const sql = `SELECT * FROM ${sanitizeIdentifier(table)}${clause} LIMIT ${Number(limit) || 0} OFFSET ${Number(offset) || 0}`

			const response = await this.runJson<Record<string, any>>(sql, params, { signal })
			const serializedRows = response.data.map(serializeRow)
			const stats = extractStats(response)

			return stats ? { rows: serializedRows, sql, stats } : { rows: serializedRows, sql }
		} catch (error) {
			reportError(`ClickHouse getRows error: ${error}`)
			return undefined
		}
	}

	async commitChange(serializedMutation: SerializedMutation, _transaction: knexlib.Knex.Transaction | SQLiteTransaction, signal?: AbortSignal): Promise<void> {
		if (!this.client) {
			throw new Error('Not connected')
		}

		const safeTable = sanitizeIdentifier(serializedMutation.table)
		const safePkColumn = sanitizeIdentifier(serializedMutation.primaryKeyColumn)

		/**
		 * Match the primary key via `toString(pk)` so a String-bound parameter
		 * compares cleanly regardless of the key's real type (UInt64, Decimal,
		 * UUID, …). Comparing a numeric column directly against a String literal
		 * otherwise raises an illegal-types error in ClickHouse.
		 */
		const whereClause = `WHERE toString(${safePkColumn}) = {primaryKey:String}`

		if (serializedMutation.type === 'cell-update') {
			const mutation = serializedMutation as SerializedCellUpdateMutation
			const safeColumn = sanitizeIdentifier(mutation.column.name)

			const setValueIsNull = mutation.newValue === null || mutation.newValue === undefined

			if (setValueIsNull) {
				if (!mutation.column.isNullable) {
					throw new Error(`Cannot set NULL on non-nullable column: ${mutation.column.name}`)
				}

				await this.client.command({
					query: `ALTER TABLE ${safeTable} UPDATE ${safeColumn} = NULL ${whereClause} SETTINGS mutations_sync = 1`,
					query_params: { primaryKey: String(mutation.primaryKey) },
					abort_signal: signal,
				})
				return
			}

			/**
			 * Cast the incoming string to the column's real ClickHouse type so
			 * Decimal/DateTime64/UInt64/Enum values round-trip losslessly. Binding
			 * a bare `{newValue:String}` (the previous behaviour) corrupts anything
			 * that is not a plain String column. The Nullable/LowCardinality
			 * wrappers are peeled off the cast target because the value is non-null
			 * here and a bare cast covers both cases.
			 */
			const castType = unwrapNullableAndLowCardinality(mutation.column.type)

			await this.client.command({
				query: `ALTER TABLE ${safeTable} UPDATE ${safeColumn} = CAST({newValue:String} AS ${castType}) ${whereClause} SETTINGS mutations_sync = 1`,
				query_params: { newValue: String(mutation.newValue), primaryKey: String(mutation.primaryKey) },
				abort_signal: signal,
			})
			return
		}

		if (serializedMutation.type === 'row-delete') {
			const mutation = serializedMutation as SerializedRowDeletionMutation

			await this.client.command({
				query: `ALTER TABLE ${safeTable} DELETE ${whereClause} SETTINGS mutations_sync = 1`,
				query_params: { primaryKey: String(mutation.primaryKey) },
				abort_signal: signal,
			})
		}
	}

	async getVersion(): Promise<string | undefined> {
		if (!this.client) {
			return undefined
		}

		try {
			const rows = await this.queryJson<{ version: string }>('SELECT version() AS version')
			return rows[0]?.version
		} catch (error) {
			reportError(`ClickHouse getVersion error: ${error}`)
			return undefined
		}
	}

	async rawQuery(code: string, signal?: AbortSignal): Promise<any> {
		if (!this.client) {
			throw new Error('Connection not initialized')
		}

		const response = await this.runJson<Record<string, any>>(code, undefined, {
			settings: RAW_QUERY_PROTECTIVE_SETTINGS,
			signal,
		})

		const rows = response.data
		const cappedRows = rows.length > RAW_QUERY_MAX_ROWS ? rows.slice(0, RAW_QUERY_MAX_ROWS) : rows

		return JSON.stringify(cappedRows)
	}

	private currentDatabase(): string {
		return this.config.database ?? 'default'
	}

	private async queryJson<T>(query: string, params?: Record<string, any>, options?: { settings?: ClickHouseSettings, signal?: AbortSignal }): Promise<T[]> {
		const response = await this.runJson<T>(query, params, options)
		return response.data
	}

	/**
	 * Runs a query in `JSON` format and returns the full parsed envelope,
	 * including the `statistics` / `rows_before_limit_at_least` metadata that the
	 * plain {@link queryJson} discards. Threads an optional `AbortSignal` and
	 * per-query `clickhouse_settings` through to the client.
	 */
	private async runJson<T>(query: string, params?: Record<string, any>, options?: { settings?: ClickHouseSettings, signal?: AbortSignal }): Promise<ResponseJSON<T>> {
		const resultSet = await this.client!.query({
			query,
			format: 'JSON',
			query_params: params,
			clickhouse_settings: options?.settings,
			abort_signal: options?.signal,
		})

		return await resultSet.json<T>()
	}

	/**
	 * Builds a parameterized `WHERE` clause. Numeric columns match on exact
	 * string form; other columns use a case-sensitive substring `LIKE`. All
	 * values are bound as query parameters to avoid injection.
	 */
	private buildWhereClause(columns: Column[], whereClause?: Record<string, any>): { clause: string, params: Record<string, any> } {
		if (!whereClause || Object.keys(whereClause).length === 0) {
			return { clause: '', params: {} }
		}

		const conditions: string[] = []
		const params: Record<string, any> = {}
		let index = 0

		for (const [columnName, rawValue] of Object.entries(whereClause)) {
			if (rawValue === '') {
				continue
			}

			const targetColumn = columns.find(column => column.name === columnName)
			if (!targetColumn) {
				throw new Error(`Invalid column name: ${columnName}`)
			}

			const paramName = `p${index++}`
			const safeColumn = sanitizeIdentifier(columnName)
			const isNumeric = this.getNumericColumnTypeNamesLowercase().includes(stripTypeWrappers(targetColumn.type).toLowerCase())

			if (isNumeric) {
				conditions.push(`toString(${safeColumn}) = {${paramName}:String}`)
				params[paramName] = String(rawValue)
			} else {
				conditions.push(`toString(${safeColumn}) LIKE {${paramName}:String}`)
				params[paramName] = `%${rawValue}%`
			}
		}

		if (conditions.length === 0) {
			return { clause: '', params: {} }
		}

		return { clause: ` WHERE ${conditions.join(' AND ')}`, params }
	}
}

/**
 * Strips ClickHouse scalar type wrappers so the inner scalar type can be
 * classified, e.g. `LowCardinality(Nullable(String))` -> `String`,
 * `Decimal(10, 2)` -> `Decimal`. Collection wrappers such as `Array` are left
 * intact (reduced to `Array`) so collection columns are not treated as their
 * editable scalar element type.
 */
function stripTypeWrappers(type: string): string {
	let current = type.trim()
	const wrappers = ['Nullable', 'LowCardinality']

	let changed = true
	while (changed) {
		changed = false
		for (const wrapper of wrappers) {
			const prefix = `${wrapper}(`
			if (current.startsWith(prefix) && current.endsWith(')')) {
				current = current.slice(prefix.length, -1).trim()
				changed = true
			}
		}
	}

	const parenIndex = current.indexOf('(')
	if (parenIndex !== -1) {
		current = current.slice(0, parenIndex)
	}

	return current.trim()
}

function isNullableType(type: string): boolean {
	return /\bNullable\(/.test(type)
}

/**
 * Peels the outer `Nullable(...)` / `LowCardinality(...)` wrappers off a
 * ClickHouse type, preserving the inner type's parameters. Unlike
 * {@link stripTypeWrappers}, this keeps precision/scale so the result is a valid
 * `CAST` target, e.g. `Nullable(Decimal(10, 2))` -> `Decimal(10, 2)`,
 * `LowCardinality(String)` -> `String`.
 */
function unwrapNullableAndLowCardinality(type: string): string {
	let current = type.trim()
	const wrappers = ['Nullable', 'LowCardinality']

	let changed = true
	while (changed) {
		changed = false
		for (const wrapper of wrappers) {
			const prefix = `${wrapper}(`
			if (current.startsWith(prefix) && current.endsWith(')')) {
				current = current.slice(prefix.length, -1).trim()
				changed = true
			}
		}
	}

	return current
}

/**
 * Maps a ClickHouse `JSON`-format response envelope's server-side execution
 * metadata onto the engine-agnostic {@link QueryStats} shape. Returns `undefined`
 * when the server reported no statistics at all.
 */
function extractStats(response: ResponseJSON<unknown>): QueryStats | undefined {
	const statistics = response.statistics
	const rowsBeforeLimitAtLeast = response.rows_before_limit_at_least

	if (!statistics && rowsBeforeLimitAtLeast === undefined) {
		return undefined
	}

	return {
		rowsRead: statistics?.rows_read,
		bytesRead: statistics?.bytes_read,
		elapsedSeconds: statistics?.elapsed,
		rowsBeforeLimitAtLeast,
	}
}

/**
 * ClickHouse identifiers are wrapped in backticks; embedded backticks are
 * doubled. Dotted identifiers (`db.table`) are quoted segment-wise.
 */
function sanitizeIdentifier(identifier: string): string {
	return identifier
		.split('.')
		.map(segment => `\`${segment.replace(/`/g, '``')}\``)
		.join('.')
}

/**
 * Non-scalar cell values (Array, Tuple, Map, Nested) arrive as JS
 * arrays/objects; stringify them so the webview can render a single cell.
 */
function serializeRow(row: Record<string, any>): Record<string, any> {
	const serialized: Record<string, any> = {}

	for (const [key, value] of Object.entries(row)) {
		if (value !== null && typeof value === 'object') {
			serialized[key] = JSON.stringify(value)
		} else {
			serialized[key] = value
		}
	}

	return serialized
}
