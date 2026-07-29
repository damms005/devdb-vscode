import { createClient, RedisClientType } from 'redis'
import knexlib from 'knex'
import { Column, DatabaseEngine, KnexClient, QueryResponse, RedisConfig, SerializedMutation, SerializedCellUpdateMutation, SerializedRowDeletionMutation } from '../types'
import { SQLiteTransaction } from './sqlite-engine'

type RedisDataType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream'

/**
 * Redis and Valkey both speak the RESP protocol, so a single node-redis client serves both.
 * Redis has no tabular schema, so we model each Redis data type as a "table" and expand each
 * key's value into rows:
 *   string -> 1 row (value)         hash   -> field/value rows
 *   list   -> index/value rows      set    -> member rows
 *   zset   -> member/score rows     stream -> entry rows
 */
export class RedisEngine implements DatabaseEngine {
	private client: RedisClientType | null = null
	private config: RedisConfig

	private static readonly ID_SEPARATOR = '\u0000'
	private static readonly DATA_TYPES: RedisDataType[] = ['string', 'hash', 'list', 'set', 'zset', 'stream']

	constructor(config: RedisConfig) {
		this.config = config
	}

	async connect(): Promise<boolean> {
		try {
			if (this.config.connectionString) {
				this.client = createClient({ url: this.config.connectionString }) as RedisClientType
			} else {
				const socket: Record<string, any> = {
					host: this.config.host ?? 'localhost',
					port: this.config.port ?? 6379,
				}
				if (this.config.tls === true) {
					socket.tls = true
				}
				this.client = createClient({
					socket,
					username: this.config.username,
					password: this.config.password,
					database: this.config.database ?? 0,
				}) as RedisClientType
			}

			this.client.on('error', () => { })
			await this.client.connect()
			await this.client.ping()
			return true
		} catch {
			this.client = null
			return false
		}
	}

	getType(): KnexClient {
		return 'redis'
	}

	getConnection(): knexlib.Knex | null {
		return null
	}

	async isOkay(): Promise<boolean> {
		if (!this.client) {
			return false
		}
		try {
			const pong = await this.client.ping()
			return pong === 'PONG'
		} catch {
			return false
		}
	}

	async getTables(): Promise<string[]> {
		if (!this.client) {
			return []
		}

		const presentTypes = new Set<string>()
		for await (const key of this.scanKeys()) {
			const type = await this.client.type(key)
			if (RedisEngine.DATA_TYPES.includes(type as RedisDataType)) {
				presentTypes.add(type)
			}
			if (presentTypes.size === RedisEngine.DATA_TYPES.length) {
				break
			}
		}

		return [...presentTypes].sort()
	}

	async getColumns(table: string): Promise<Column[]> {
		const idColumn: Column = { name: '_id', type: 'id', isPrimaryKey: true, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false }
		const keyColumn: Column = { name: 'key', type: 'key', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false }

		switch (table as RedisDataType) {
			case 'string':
				return [
					{ ...idColumn, type: 'key' },
					{ name: 'value', type: 'string', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: true, isEditable: true },
				]
			case 'hash':
				return [
					idColumn,
					keyColumn,
					{ name: 'field', type: 'field', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false },
					{ name: 'value', type: 'string', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: true, isEditable: true },
				]
			case 'list':
				return [
					idColumn,
					keyColumn,
					{ name: 'index', type: 'index', isPrimaryKey: false, isNumeric: true, isPlainTextType: false, isNullable: false, isEditable: false },
					{ name: 'value', type: 'string', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: true, isEditable: false },
				]
			case 'set':
				return [
					idColumn,
					keyColumn,
					{ name: 'member', type: 'string', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false },
				]
			case 'zset':
				return [
					idColumn,
					keyColumn,
					{ name: 'member', type: 'string', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false },
					{ name: 'score', type: 'score', isPrimaryKey: false, isNumeric: true, isPlainTextType: false, isNullable: false, isEditable: false },
				]
			case 'stream':
				return [
					idColumn,
					keyColumn,
					{ name: 'id', type: 'id', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false },
					{ name: 'entry', type: 'json', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: true, isEditable: false },
				]
			default:
				return []
		}
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['index', 'score', 'number']
	}

	async getTableCreationSql(table: string): Promise<string> {
		return `Redis "${table}" keys modeled as rows. This is a synthetic view; Redis has no schema definition.`
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		if (!this.client) {
			return 0
		}

		if (whereClause && Object.keys(whereClause).length > 0) {
			const rows = await this.materializeRows(table as RedisDataType)
			return this.applyFilter(rows, whereClause).length
		}

		const keys = await this.collectKeys(table as RedisDataType)
		if (table === 'string') {
			return keys.length
		}

		let total = 0
		for (const key of keys) {
			total += await this.cardinalityOf(table as RedisDataType, key)
		}
		return total
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!this.client) {
			return undefined
		}

		let rows = await this.materializeRows(table as RedisDataType)
		if (whereClause && Object.keys(whereClause).length > 0) {
			rows = this.applyFilter(rows, whereClause)
		}

		return { rows: rows.slice(offset, offset + limit) }
	}

	async commitChange(serializedMutation: SerializedMutation, _transaction: knexlib.Knex.Transaction | SQLiteTransaction): Promise<void> {
		if (!this.client) {
			throw new Error('Not connected')
		}

		if (serializedMutation.type === 'cell-update') {
			const mutation = serializedMutation as SerializedCellUpdateMutation

			if (mutation.table === 'string' && mutation.column.name === 'value') {
				await this.client.set(String(mutation.primaryKey), String(mutation.newValue))
				return
			}

			if (mutation.table === 'hash' && mutation.column.name === 'value') {
				const [key, field] = this.parseCompositeId(String(mutation.primaryKey))
				await this.client.hSet(key, field, String(mutation.newValue))
				return
			}

			throw new Error(`Editing "${mutation.column.name}" on Redis "${mutation.table}" is not supported`)
		}

		if (serializedMutation.type === 'row-delete') {
			const mutation = serializedMutation as SerializedRowDeletionMutation

			if (mutation.table === 'string') {
				await this.client.del(String(mutation.primaryKey))
				return
			}

			if (mutation.table === 'hash') {
				const [key, field] = this.parseCompositeId(String(mutation.primaryKey))
				await this.client.hDel(key, field)
				return
			}

			throw new Error(`Deleting rows on Redis "${mutation.table}" is not supported`)
		}
	}

	async getVersion(): Promise<string | undefined> {
		if (!this.client) {
			return undefined
		}
		try {
			const info = await this.client.info('server')
			const match = info.match(/redis_version:([^\r\n]+)/)
			return match ? match[1].trim() : undefined
		} catch {
			return undefined
		}
	}

	/**
	 * Executes a raw Redis command. Accepts a JSON array of arguments (e.g. `["GET", "foo"]`)
	 * or a plain command string (e.g. `GET foo`).
	 */
	async rawQuery(code: string | string[]): Promise<any> {
		if (!this.client) {
			throw new Error('Not connected')
		}

		const args = this.parseCommandArguments(code)
		if (args.length === 0) {
			throw new Error('Empty command')
		}

		return this.client.sendCommand(args)
	}

	async disconnect(): Promise<void> {
		if (this.client) {
			try {
				await this.client.quit()
			} catch {
				this.client = null
			}
			this.client = null
		}
	}

	private parseCommandArguments(code: string | string[]): string[] {
		if (Array.isArray(code)) {
			return code.map(argument => String(argument))
		}

		const trimmed = code.trim()
		try {
			const parsed = JSON.parse(trimmed)
			if (Array.isArray(parsed)) {
				return parsed.map(argument => String(argument))
			}
		} catch {
			// not JSON, fall through to whitespace tokenisation
		}

		const tokens = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
		return tokens.map(token => token.replace(/^["']|["']$/g, ''))
	}

	private async *scanKeys(): AsyncGenerator<string> {
		if (!this.client) {
			return
		}

		const match = this.config.keyPrefix ? `${this.config.keyPrefix}*` : '*'
		const count = this.config.scanCount ?? 500

		let cursor = '0'
		do {
			const reply = await this.client.scan(cursor, { MATCH: match, COUNT: count })
			cursor = String(reply.cursor)
			for (const key of reply.keys) {
				yield key
			}
		} while (cursor !== '0')
	}

	private async collectKeys(type: RedisDataType): Promise<string[]> {
		if (!this.client) {
			return []
		}

		const keys: string[] = []
		for await (const key of this.scanKeys()) {
			if (await this.client.type(key) === type) {
				keys.push(key)
			}
		}
		return keys.sort()
	}

	private async cardinalityOf(type: RedisDataType, key: string): Promise<number> {
		if (!this.client) {
			return 0
		}

		switch (type) {
			case 'hash':
				return this.client.hLen(key)
			case 'list':
				return this.client.lLen(key)
			case 'set':
				return this.client.sCard(key)
			case 'zset':
				return this.client.zCard(key)
			case 'stream':
				return this.client.xLen(key)
			default:
				return 1
		}
	}

	private async materializeRows(type: RedisDataType): Promise<Record<string, any>[]> {
		if (!this.client) {
			return []
		}

		const keys = await this.collectKeys(type)
		const rows: Record<string, any>[] = []

		for (const key of keys) {
			switch (type) {
				case 'string': {
					const value = await this.client.get(key)
					rows.push({ _id: key, value })
					break
				}
				case 'hash': {
					const entries = await this.client.hGetAll(key)
					for (const [field, value] of Object.entries(entries)) {
						rows.push({ _id: this.buildCompositeId(key, field), key, field, value })
					}
					break
				}
				case 'list': {
					const values = await this.client.lRange(key, 0, -1)
					values.forEach((value, index) => {
						rows.push({ _id: this.buildCompositeId(key, String(index)), key, index, value })
					})
					break
				}
				case 'set': {
					const members = await this.client.sMembers(key)
					for (const member of members) {
						rows.push({ _id: this.buildCompositeId(key, member), key, member })
					}
					break
				}
				case 'zset': {
					const members = await this.client.zRangeWithScores(key, 0, -1)
					for (const { value, score } of members) {
						rows.push({ _id: this.buildCompositeId(key, value), key, member: value, score })
					}
					break
				}
				case 'stream': {
					const entries = await this.client.xRange(key, '-', '+')
					for (const { id, message } of entries) {
						rows.push({ _id: this.buildCompositeId(key, id), key, id, entry: JSON.stringify(message) })
					}
					break
				}
			}
		}

		return rows
	}

	private applyFilter(rows: Record<string, any>[], whereClause: Record<string, any>): Record<string, any>[] {
		const entries = Object.entries(whereClause)
		return rows.filter(row =>
			entries.every(([column, needle]) => {
				const cell = row[column]
				if (cell === null || cell === undefined) {
					return false
				}
				return String(cell).toLowerCase().includes(String(needle).toLowerCase())
			})
		)
	}

	private buildCompositeId(key: string, discriminator: string): string {
		return `${key}${RedisEngine.ID_SEPARATOR}${discriminator}`
	}

	private parseCompositeId(id: string): [string, string] {
		const separatorIndex = id.indexOf(RedisEngine.ID_SEPARATOR)
		if (separatorIndex === -1) {
			return [id, '']
		}
		return [id.slice(0, separatorIndex), id.slice(separatorIndex + RedisEngine.ID_SEPARATOR.length)]
	}
}
