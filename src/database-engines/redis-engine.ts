import { createClient, RedisClientType } from 'redis'
import knexlib from 'knex'
import { Column, DatabaseEngine, KnexClient, QueryResponse, RedisConfig, SerializedMutation, SerializedCellUpdateMutation, SerializedRowDeletionMutation } from '../types'
import { SQLiteTransaction } from './sqlite-engine'

type RedisDataType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream'

type KeyMeta = { key: string; card: number }

/**
 * Summary of a top-level `:`-delimited key namespace derived from a bounded key scan.
 * `prefix` is the first segment before the first `:` (keys without a `:` are grouped
 * under `(root)`); `keyCount` is how many scanned keys fell under that prefix.
 */
export type RedisNamespace = { prefix: string; keyCount: number }

/**
 * Resume point for sequential row-level pagination of a single Redis data type.
 * Lets the next page continue from the last SCAN cursor without re-walking the
 * keyspace, as long as the incoming offset matches where the previous page ended.
 */
type PageCursorState = {
	endOffset: number
	cursor: string
	scanDone: boolean
	buffer: KeyMeta[]
	bufferSkip: number
}

type ExpandedKey = { rows: Record<string, any>[]; truncated: boolean }

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

	/**
	 * Maximum number of elements read from a single key. A collection larger than this is
	 * shown truncated (rows carry `_truncated: true`) instead of running an O(N) command that
	 * would block single-threaded Redis.
	 */
	private static readonly ELEMENT_CAP = 100

	/**
	 * Upper bound on keys scanned when approximating `getTotalRows`. Exact when the keyspace
	 * is smaller than this; otherwise the returned count is a "scanned so far" estimate.
	 */
	private static readonly TOTAL_KEY_SCAN_LIMIT = 50_000

	/**
	 * Upper bound on keys scanned when materializing rows for a filtered query.
	 */
	private static readonly FILTER_KEY_SCAN_LIMIT = 10_000

	private readonly pageCache = new Map<string, PageCursorState>()

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

	/**
	 * Groups keys by their top-level `:` namespace over a bounded key scan, returning each
	 * prefix with the number of scanned keys under it. Reuses the same bounded SCAN as the
	 * rest of the engine ({@link RedisEngine.TOTAL_KEY_SCAN_LIMIT}) so it never walks the whole
	 * keyspace eagerly; the counts are exact when the keyspace is smaller than the scan limit
	 * and a "scanned so far" estimate otherwise. Keys with no `:` are grouped under `(root)`.
	 */
	async getNamespaces(): Promise<RedisNamespace[]> {
		if (!this.client) {
			return []
		}

		const counts = new Map<string, number>()
		let scanned = 0
		for await (const key of this.scanKeys()) {
			const separatorIndex = key.indexOf(':')
			const prefix = separatorIndex === -1 ? '(root)' : key.slice(0, separatorIndex)
			counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
			scanned++
			if (scanned >= RedisEngine.TOTAL_KEY_SCAN_LIMIT) {
				break
			}
		}

		return [...counts.entries()]
			.map(([prefix, keyCount]) => ({ prefix, keyCount }))
			.sort((a, b) => this.naturalCompare(a.prefix, b.prefix))
	}

	async getColumns(table: string): Promise<Column[]> {
		const idColumn: Column = { name: '_id', type: 'id', isPrimaryKey: true, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false }
		const keyColumn: Column = { name: 'key', type: 'key', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false }
		const ttlColumn: Column = { name: 'ttl', type: 'number', isPrimaryKey: false, isNumeric: true, isPlainTextType: false, isNullable: true, isEditable: false }

		switch (table as RedisDataType) {
			case 'string':
				return [
					{ ...idColumn, type: 'key' },
					{ name: 'value', type: 'string', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: true, isEditable: true },
					ttlColumn,
				]
			case 'hash':
				return [
					idColumn,
					keyColumn,
					{ name: 'field', type: 'field', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false },
					{ name: 'value', type: 'string', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: true, isEditable: true },
					ttlColumn,
				]
			case 'list':
				return [
					idColumn,
					keyColumn,
					{ name: 'index', type: 'index', isPrimaryKey: false, isNumeric: true, isPlainTextType: false, isNullable: false, isEditable: false },
					{ name: 'value', type: 'string', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: true, isEditable: false },
					ttlColumn,
				]
			case 'set':
				return [
					idColumn,
					keyColumn,
					{ name: 'member', type: 'string', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false },
					ttlColumn,
				]
			case 'zset':
				return [
					idColumn,
					keyColumn,
					{ name: 'member', type: 'string', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false },
					{ name: 'score', type: 'score', isPrimaryKey: false, isNumeric: true, isPlainTextType: false, isNullable: false, isEditable: false },
					ttlColumn,
				]
			case 'stream':
				return [
					idColumn,
					keyColumn,
					{ name: 'id', type: 'id', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: false, isEditable: false },
					{ name: 'entry', type: 'json', isPrimaryKey: false, isNumeric: false, isPlainTextType: true, isNullable: true, isEditable: false },
					ttlColumn,
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

	/**
	 * Returns an approximate row count without walking the whole keyspace. Non-filtered counts
	 * sum per-key row cardinality (capped at {@link RedisEngine.ELEMENT_CAP}) over a bounded key
	 * scan; the result is exact when the keyspace is smaller than the scan limit and a
	 * "scanned so far" estimate otherwise. Filtered counts materialize a bounded window of rows.
	 */
	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		if (!this.client) {
			return 0
		}

		const type = table as RedisDataType

		if (whereClause && Object.keys(whereClause).length > 0) {
			const rows = await this.boundedMaterialize(type)
			return this.applyFilter(rows, whereClause).length
		}

		return this.approximateTotalRows(type)
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!this.client) {
			return undefined
		}

		const type = table as RedisDataType

		if (whereClause && Object.keys(whereClause).length > 0) {
			const rows = this.applyFilter(await this.boundedMaterialize(type), whereClause)
			return { rows: rows.slice(offset, offset + limit) }
		}

		return { rows: await this.collectPage(type, offset, limit) }
	}

	async commitChange(serializedMutation: SerializedMutation, _transaction: knexlib.Knex.Transaction | SQLiteTransaction): Promise<void> {
		if (!this.client) {
			throw new Error('Not connected')
		}

		this.pageCache.clear()

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
				await this.client.unlink(String(mutation.primaryKey))
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

	/**
	 * Natural (numeric-aware) key comparison so keys sort 1, 2, 11 rather than 1, 11, 2.
	 */
	private naturalCompare(a: string, b: string): number {
		return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
	}

	/**
	 * Number of rows a single key contributes to its type's synthetic table, capped so a huge
	 * collection never inflates pagination arithmetic beyond what we are willing to read.
	 */
	private async rowCardOf(type: RedisDataType, key: string): Promise<number> {
		return Math.min(await this.cardinalityOf(type, key), RedisEngine.ELEMENT_CAP)
	}

	/**
	 * SCANs a single batch of keys of the given type (server-side TYPE filter), returning them
	 * naturally sorted with their capped row cardinality plus the advanced cursor.
	 */
	private async scanTypeBatch(type: RedisDataType, cursor: string): Promise<{ metas: KeyMeta[]; cursor: string }> {
		if (!this.client) {
			return { metas: [], cursor: '0' }
		}

		const match = this.config.keyPrefix ? `${this.config.keyPrefix}*` : '*'
		const count = this.config.scanCount ?? 500

		const reply = await this.client.scan(cursor, { MATCH: match, COUNT: count, TYPE: type })
		const nextCursor = String(reply.cursor)

		const keys = [...reply.keys].sort((a, b) => this.naturalCompare(a, b))
		const metas: KeyMeta[] = []
		for (const key of keys) {
			metas.push({ key, card: await this.rowCardOf(type, key) })
		}

		return { metas, cursor: nextCursor }
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

	/**
	 * Expands a single key into its synthetic rows, reading at most
	 * {@link RedisEngine.ELEMENT_CAP} elements (HSCAN/SSCAN/ZSCAN and windowed LRANGE/XRANGE)
	 * so one large collection can never trigger an O(N) blocking command. When the collection
	 * exceeds the cap every returned row carries `_truncated: true`. The key's TTL is fetched
	 * once (PTTL) and stamped onto each row.
	 */
	private async expandKey(type: RedisDataType, key: string): Promise<ExpandedKey> {
		if (!this.client) {
			return { rows: [], truncated: false }
		}

		const cap = RedisEngine.ELEMENT_CAP
		const rows: Record<string, any>[] = []
		let truncated = false

		switch (type) {
			case 'string': {
				const value = await this.client.get(key)
				rows.push({ _id: key, value })
				break
			}
			case 'hash': {
				let cursor = '0'
				const entries: { field: string; value: string }[] = []
				do {
					const reply = await this.client.hScan(key, cursor, { COUNT: cap })
					cursor = String(reply.cursor)
					entries.push(...reply.entries)
				} while (cursor !== '0' && entries.length < cap)
				truncated = cursor !== '0' || entries.length > cap
				for (const { field, value } of entries.slice(0, cap)) {
					rows.push({ _id: this.buildCompositeId(key, field), key, field, value })
				}
				break
			}
			case 'list': {
				const values = await this.client.lRange(key, 0, cap)
				truncated = values.length > cap
				values.slice(0, cap).forEach((value, index) => {
					rows.push({ _id: this.buildCompositeId(key, String(index)), key, index, value })
				})
				break
			}
			case 'set': {
				let cursor = '0'
				const members: string[] = []
				do {
					const reply = await this.client.sScan(key, cursor, { COUNT: cap })
					cursor = String(reply.cursor)
					members.push(...reply.members)
				} while (cursor !== '0' && members.length < cap)
				truncated = cursor !== '0' || members.length > cap
				for (const member of members.slice(0, cap)) {
					rows.push({ _id: this.buildCompositeId(key, member), key, member })
				}
				break
			}
			case 'zset': {
				let cursor = '0'
				const members: { value: string; score: number }[] = []
				do {
					const reply = await this.client.zScan(key, cursor, { COUNT: cap })
					cursor = String(reply.cursor)
					members.push(...reply.members)
				} while (cursor !== '0' && members.length < cap)
				truncated = cursor !== '0' || members.length > cap
				for (const { value, score } of members.slice(0, cap)) {
					rows.push({ _id: this.buildCompositeId(key, value), key, member: value, score })
				}
				break
			}
			case 'stream': {
				const entries = await this.client.xRange(key, '-', '+', { COUNT: cap + 1 })
				truncated = entries.length > cap
				for (const { id, message } of entries.slice(0, cap)) {
					rows.push({ _id: this.buildCompositeId(key, id), key, id, entry: JSON.stringify(message) })
				}
				break
			}
		}

		const ttl = await this.client.pTTL(key)
		for (const row of rows) {
			row.ttl = ttl
			if (truncated) {
				row._truncated = true
			}
		}

		return { rows, truncated }
	}

	/**
	 * Collects one page of rows for a data type without materializing the keyspace. Keys are
	 * paged via SCAN; keys entirely before the offset window are skipped using O(1) cardinality
	 * commands (no element reads), and only keys overlapping [offset, offset + limit) are
	 * expanded. Sequential paging is cheap because the SCAN cursor and any unconsumed keys are
	 * cached per type keyed by the offset the previous page ended at; a non-matching offset
	 * re-scans from cursor 0.
	 */
	private async collectPage(type: RedisDataType, offset: number, limit: number): Promise<Record<string, any>[]> {
		if (!this.client || limit <= 0) {
			return []
		}

		const cached = this.pageCache.get(type)
		let cursor: string
		let scanDone: boolean
		let buffer: KeyMeta[]
		let skipInFirst: number
		let rowPos: number

		if (cached && cached.endOffset === offset) {
			cursor = cached.cursor
			scanDone = cached.scanDone
			buffer = [...cached.buffer]
			skipInFirst = cached.bufferSkip
			rowPos = offset
		} else {
			cursor = '0'
			scanDone = false
			buffer = []
			skipInFirst = 0
			rowPos = 0
		}

		const refill = async (): Promise<boolean> => {
			while (buffer.length === 0 && !scanDone) {
				const batch = await this.scanTypeBatch(type, cursor)
				cursor = batch.cursor
				if (cursor === '0') {
					scanDone = true
				}
				buffer.push(...batch.metas)
			}
			return buffer.length > 0
		}

		while (rowPos < offset) {
			if (!(await refill())) {
				break
			}
			const meta = buffer[0]
			const available = meta.card - skipInFirst
			if (rowPos + available <= offset) {
				rowPos += available
				buffer.shift()
				skipInFirst = 0
			} else {
				skipInFirst += offset - rowPos
				rowPos = offset
			}
		}

		const rows: Record<string, any>[] = []
		while (rows.length < limit) {
			if (!(await refill())) {
				break
			}
			const meta = buffer[0]
			const expanded = await this.expandKey(type, meta.key)
			const slice = expanded.rows.slice(skipInFirst, skipInFirst + (limit - rows.length))

			if (slice.length === 0) {
				buffer.shift()
				skipInFirst = 0
				continue
			}

			rows.push(...slice)
			rowPos += slice.length
			if (skipInFirst + slice.length >= expanded.rows.length) {
				buffer.shift()
				skipInFirst = 0
			} else {
				skipInFirst += slice.length
			}
		}

		this.pageCache.set(type, { endOffset: offset + rows.length, cursor, scanDone, buffer, bufferSkip: skipInFirst })

		return rows
	}

	/**
	 * Approximates total rows for a type by summing capped per-key row cardinality over a
	 * bounded key scan. Exact when the keyspace is smaller than
	 * {@link RedisEngine.TOTAL_KEY_SCAN_LIMIT}; a "scanned so far" estimate otherwise.
	 */
	private async approximateTotalRows(type: RedisDataType): Promise<number> {
		if (!this.client) {
			return 0
		}

		let cursor = '0'
		let total = 0
		let scanned = 0
		do {
			const batch = await this.scanTypeBatch(type, cursor)
			cursor = batch.cursor
			for (const meta of batch.metas) {
				total += meta.card
				scanned++
				if (scanned >= RedisEngine.TOTAL_KEY_SCAN_LIMIT) {
					return total
				}
			}
		} while (cursor !== '0')

		return total
	}

	/**
	 * Materializes rows over a bounded key window for filtered queries. Each key is expanded
	 * with the same per-key element cap as pagination so filtering never reads an unbounded
	 * collection or the whole keyspace.
	 */
	private async boundedMaterialize(type: RedisDataType): Promise<Record<string, any>[]> {
		if (!this.client) {
			return []
		}

		let cursor = '0'
		let scanned = 0
		const rows: Record<string, any>[] = []
		do {
			const batch = await this.scanTypeBatch(type, cursor)
			cursor = batch.cursor
			for (const meta of batch.metas) {
				const expanded = await this.expandKey(type, meta.key)
				rows.push(...expanded.rows)
				scanned++
				if (scanned >= RedisEngine.FILTER_KEY_SCAN_LIMIT) {
					return rows
				}
			}
		} while (cursor !== '0')

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
