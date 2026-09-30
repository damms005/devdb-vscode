import { randomUUID } from 'crypto'
import { createClient, ClickHouseClient, ClickHouseSettings, ResponseJSON } from '@clickhouse/client'
import knexlib from 'knex'
import { Column, ClickhouseConfig, DatabaseEngine, KnexClient, QueryResponse, QueryStats, RawQueryOptions, SerializedMutation, SerializedCellUpdateMutation, SerializedRowDeletionMutation } from '../types'
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

/** Default wall-clock ceiling (seconds) on table browsing queries (getRows/getTotalRows). */
const DEFAULT_MAX_EXECUTION_TIME = 60

/** Default per-query server memory ceiling (2 GiB) so one query cannot OOM the server. */
const DEFAULT_MAX_MEMORY_USAGE = 2 * 1024 * 1024 * 1024

/** Well-known ClickHouse TLS ports (HTTPS interface and native secure). */
const TLS_PORTS = [8443, 9440]

export interface ClickhouseEngineOptions {
	/** Wall-clock ceiling (seconds) for getRows/getTotalRows. Defaults to 60. */
	maxExecutionTimeSeconds?: number
	/** Per-query server memory ceiling in bytes. Defaults to 2 GiB. */
	maxMemoryUsageBytes?: number
}

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
	private readonly maxExecutionTime: number
	private readonly maxMemoryUsage: number

	/**
	 * True when the connection uses plain HTTP to a non-loopback host, so
	 * credentials and data travel unencrypted. {@link connect} logs a warning.
	 */
	public readonly usesInsecureTransport: boolean

	constructor(config: ClickhouseConfig, options: ClickhouseEngineOptions = {}) {
		this.config = config
		this.maxExecutionTime = options.maxExecutionTimeSeconds ?? DEFAULT_MAX_EXECUTION_TIME
		this.maxMemoryUsage = options.maxMemoryUsageBytes ?? DEFAULT_MAX_MEMORY_USAGE

		const host = config.host ?? 'localhost'
		this.usesInsecureTransport = resolveProtocol(host, config.port ?? 8123, config.protocol) === 'http' && !isLoopbackHost(host)
	}

	async connect(): Promise<boolean> {
		try {
			const host = this.config.host ?? 'localhost'
			const port = this.config.port ?? 8123
			const protocol = resolveProtocol(host, port, this.config.protocol)

			if (this.usesInsecureTransport) {
				reportError(`ClickHouse warning: connecting to ${host}:${port} over plain HTTP. Credentials and data are not encrypted. Set "protocol": "https" in the connection config.`)
			}

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
					/**
					 * Return Decimal values as JSON strings too. As numbers they are
					 * parsed into doubles and lose digits, e.g. 99999999999999.9999.
					 */
					output_format_json_quote_decimals: 1,
					/**
					 * Stop read-only queries on the server when the HTTP client goes
					 * away (e.g. the user cancels), instead of letting them run on.
					 */
					cancel_http_readonly_queries_on_client_close: 1,
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
			/**
			 * `ping()` hits `/ping`, which does not check credentials. A real query
			 * makes a wrong password fail here instead of on the first table load.
			 */
			await this.client.query({ query: 'SELECT 1', format: 'JSONEachRow' })
			return true
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
			{ settings: this.browseSettings(), signal },
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

			const response = await this.runJson<Record<string, any>>(sql, params, { settings: this.browseSettings(), signal })
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

		const table = serializedMutation.table
		const safeTable = sanitizeIdentifier(table)
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
			 *
			 * The type comes from `system.columns`, never from the webview
			 * payload: it is interpolated into the SQL, so a crafted payload type
			 * would be an injection vector.
			 */
			const castType = unwrapNullableAndLowCardinality(await this.getServerColumnType(table, mutation.column.name))

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

	/**
	 * Runs arbitrary SQL under row/byte/time/memory ceilings. With
	 * `options.readOnly` the server enforces `readonly = 1`: writes, DDL,
	 * `SYSTEM`, `KILL`, writing table functions and setting changes all fail.
	 */
	async rawQuery(code: string, options?: RawQueryOptions): Promise<any> {
		if (!this.client) {
			throw new Error('Connection not initialized')
		}

		const settings: ClickHouseSettings = {
			...RAW_QUERY_PROTECTIVE_SETTINGS,
			max_memory_usage: String(this.maxMemoryUsage),
		}
		if (options?.readOnly) {
			/**
			 * `readonly = 1` still lets a user KILL their own queries, so KILL
			 * is refused here before it reaches the server.
			 */
			if (firstKeyword(code) === 'KILL') {
				throw new Error('KILL is not allowed in read-only mode')
			}
			settings.readonly = '1'
		}

		const response = await this.runJson<Record<string, any>>(code, undefined, {
			settings,
			signal: options?.signal,
		})

		const rows = response.data
		const cappedRows = rows.length > RAW_QUERY_MAX_ROWS ? rows.slice(0, RAW_QUERY_MAX_ROWS) : rows

		return JSON.stringify(cappedRows)
	}

	private currentDatabase(): string {
		return this.config.database ?? 'default'
	}

	private browseSettings(): ClickHouseSettings {
		return {
			max_execution_time: this.maxExecutionTime,
			max_memory_usage: String(this.maxMemoryUsage),
		}
	}

	private async getServerColumnType(table: string, column: string): Promise<string> {
		const rows = await this.queryJson<{ type: string }>(
			'SELECT type FROM system.columns WHERE database = {database:String} AND table = {table:String} AND name = {column:String}',
			{ database: this.currentDatabase(), table, column },
		)

		if (!rows[0]?.type) {
			throw new Error(`Unknown column ${column} on table ${table}`)
		}

		return rows[0].type
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
	 *
	 * Each query gets its own `query_id`. Aborting the signal closes the HTTP
	 * request and also sends `KILL QUERY` for that id on a separate request,
	 * because closing the socket alone does not stop every query on the server.
	 */
	private async runJson<T>(query: string, params?: Record<string, any>, options?: { settings?: ClickHouseSettings, signal?: AbortSignal }): Promise<ResponseJSON<T>> {
		const queryId = randomUUID()
		const signal = options?.signal
		const killOnAbort = () => this.killQuery(queryId)

		signal?.addEventListener('abort', killOnAbort, { once: true })

		try {
			const resultSet = await this.client!.query({
				query,
				format: 'JSON',
				query_id: queryId,
				query_params: params,
				clickhouse_settings: options?.settings,
				abort_signal: signal,
			})

			/**
			 * Statements that return no rows (DDL, INSERT, KILL, …) produce an
			 * empty body even with `FORMAT JSON`, which `resultSet.json()` would
			 * reject after the statement already ran.
			 */
			const text = await resultSet.text()
			return text.trim() ? JSON.parse(text) : { data: [], meta: [], rows: 0 } as unknown as ResponseJSON<T>
		} finally {
			signal?.removeEventListener('abort', killOnAbort)
		}
	}

	private killQuery(queryId: string): void {
		this.client?.command({
			query: 'KILL QUERY WHERE query_id = {queryId:String} ASYNC',
			query_params: { queryId },
		}).catch(error => reportError(`ClickHouse KILL QUERY error: ${error}`))
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
 * Quotes one ClickHouse identifier (a column name) in backticks. ClickHouse
 * reads a backslash in a quoted identifier as an escape, so backslashes are
 * escaped first, then backticks; else a name ending in `\` escapes the closing
 * backtick. The name is quoted whole: a dot is part of the name (e.g. Nested
 * `a.b`), not a separator. Used for table names too: the client
 * re-escapes backslashes in `{name:Identifier}` parameters, which breaks such names.
 */
export function sanitizeIdentifier(identifier: string): string {
	return `\`${identifier.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``
}

/** Upper-cased first keyword of a statement, skipping comments, whitespace and `(`. */
function firstKeyword(sql: string): string {
	const stripped = sql
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/(--|#)[^\n]*/g, ' ')
		.replace(/^[\s(]+/, '')
	return (stripped.match(/^[A-Za-z_]+/)?.[0] ?? '').toUpperCase()
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
	return normalized === 'localhost'
		|| normalized.endsWith('.localhost')
		|| normalized === '::1'
		|| /^127\.\d+\.\d+\.\d+$/.test(normalized)
}

/**
 * Picks the transport when the config does not set one: HTTPS for the
 * well-known TLS ports (8443, 9440) and for any non-loopback host, HTTP only
 * for loopback hosts.
 */
export function resolveProtocol(host: string, port: number, configured?: 'http' | 'https'): 'http' | 'https' {
	if (configured) {
		return configured
	}

	if (TLS_PORTS.includes(Number(port))) {
		return 'https'
	}

	return isLoopbackHost(host) ? 'http' : 'https'
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
