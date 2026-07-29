import { createClient, ClickHouseClient } from '@clickhouse/client'
import knexlib from 'knex'
import { Column, ClickhouseConfig, DatabaseEngine, KnexClient, QueryResponse, SerializedMutation, SerializedCellUpdateMutation, SerializedRowDeletionMutation } from '../types'
import { SQLiteTransaction } from './sqlite-engine'
import { reportError } from '../services/initialization-error-service'

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
					/** Return 64-bit integers as JSON numbers instead of strings. */
					output_format_json_quote_64bit_integers: 0,
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

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		if (!this.client) {
			return 0
		}

		const { clause, params } = this.buildWhereClause(columns, whereClause)
		const rows = await this.queryJson<{ count: string | number }>(
			`SELECT count() AS count FROM ${sanitizeIdentifier(table)}${clause}`,
			params,
		)

		return Number(rows[0]?.count ?? 0)
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!this.client) {
			return undefined
		}

		try {
			const { clause, params } = this.buildWhereClause(columns, whereClause)
			const sql = `SELECT * FROM ${sanitizeIdentifier(table)}${clause} LIMIT ${Number(limit) || 0} OFFSET ${Number(offset) || 0}`

			const rows = await this.queryJson<Record<string, any>>(sql, params)
			const serializedRows = rows.map(serializeRow)

			return { rows: serializedRows, sql }
		} catch (error) {
			reportError(`ClickHouse getRows error: ${error}`)
			return undefined
		}
	}

	async commitChange(serializedMutation: SerializedMutation, _transaction: knexlib.Knex.Transaction | SQLiteTransaction): Promise<void> {
		if (!this.client) {
			throw new Error('Not connected')
		}

		const safeTable = sanitizeIdentifier(serializedMutation.table)
		const safePkColumn = sanitizeIdentifier(serializedMutation.primaryKeyColumn)

		if (serializedMutation.type === 'cell-update') {
			const mutation = serializedMutation as SerializedCellUpdateMutation
			const safeColumn = sanitizeIdentifier(mutation.column.name)

			await this.client.command({
				query: `ALTER TABLE ${safeTable} UPDATE ${safeColumn} = {newValue:String} WHERE ${safePkColumn} = {primaryKey:String} SETTINGS mutations_sync = 1`,
				query_params: { newValue: String(mutation.newValue), primaryKey: String(mutation.primaryKey) },
			})
			return
		}

		if (serializedMutation.type === 'row-delete') {
			const mutation = serializedMutation as SerializedRowDeletionMutation

			await this.client.command({
				query: `ALTER TABLE ${safeTable} DELETE WHERE ${safePkColumn} = {primaryKey:String} SETTINGS mutations_sync = 1`,
				query_params: { primaryKey: String(mutation.primaryKey) },
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

	async rawQuery(code: string): Promise<any> {
		if (!this.client) {
			throw new Error('Connection not initialized')
		}

		const rows = await this.queryJson<Record<string, any>>(code)
		return JSON.stringify(rows)
	}

	private currentDatabase(): string {
		return this.config.database ?? 'default'
	}

	private async queryJson<T>(query: string, params?: Record<string, any>): Promise<T[]> {
		const resultSet = await this.client!.query({
			query,
			format: 'JSON',
			query_params: params,
		})

		const parsed = await resultSet.json<T>()
		return (parsed as unknown as { data: T[] }).data
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
