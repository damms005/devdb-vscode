import {
	AttributeValue,
	DeleteItemCommand,
	DescribeTableCommand,
	DynamoDBClient,
	DynamoDBClientConfig,
	ExecuteStatementCommand,
	ListTablesCommand,
	QueryCommand,
	QueryCommandInput,
	ScanCommand,
	ScanCommandInput,
	TableDescription,
	UpdateItemCommand,
} from '@aws-sdk/client-dynamodb'
import knexlib from 'knex'
import { Column, DatabaseEngine, DynamodbConfig, KnexClient, QueryResponse, RawQueryOptions, SerializedCellUpdateMutation, SerializedMutation, SerializedRowDeletionMutation } from '../types'
import { SQLiteTransaction } from './sqlite-engine'

type Item = Record<string, AttributeValue>

/** DynamoDB attribute type descriptors. */
export type DynamodbAttributeType = 'S' | 'N' | 'B' | 'BOOL' | 'NULL' | 'M' | 'L' | 'SS' | 'NS' | 'BS'

const ATTRIBUTE_TYPES: DynamodbAttributeType[] = ['S', 'N', 'B', 'BOOL', 'NULL', 'M', 'L', 'SS', 'NS', 'BS']

/** Types a cell edit can write. Sets and binary are shown but not editable. */
const EDITABLE_TYPES: DynamodbAttributeType[] = ['S', 'N', 'BOOL', 'NULL', 'M', 'L']

type KeyAttribute = { name: string, type: 'S' | 'N' | 'B' }

type KeySchema = { partition: KeyAttribute, sort?: KeyAttribute }

type TableInfo = { description: TableDescription, key: KeySchema }

/** Dummy access key ID for custom endpoints without credentials (DynamoDB Local, LocalStack). */
export const DYNAMODB_LOCAL_ACCESS_KEY_ID = 'devdblocal'

/** Synthetic primary key column for tables with a partition and a sort key. */
export const DYNAMODB_COMPOSITE_KEY_COLUMN = '_key'

/** Items read to discover the attribute columns of a schemaless table. */
const COLUMN_SAMPLE_SIZE = 200

/** Items read per request while skipping forward to a far page. */
const SKIP_BATCH_SIZE = 1000

/** Tables up to this size get an exact COUNT scan; larger tables use the approximate DescribeTable ItemCount. */
const EXACT_COUNT_MAX_TABLE_BYTES = 10 * 1024 * 1024

/** Pages (each up to 1 MB read) a filtered COUNT walks before it stops and reports a lower bound. */
const FILTERED_COUNT_MAX_PAGES = 25

/** Items a raw PartiQL statement returns at most. */
const RAW_QUERY_MAX_ROWS = 1000

const CONNECT_TIMEOUT_MS = 10_000

const END_OF_TABLE = null

type PageCursors = Map<number, Item | typeof END_OF_TABLE>

type CountInfo = { count: number, approximate: boolean }

export interface DynamodbEngineOptions {
	/** Tables up to this size (DescribeTable TableSizeBytes) get an exact COUNT scan. Defaults to 10 MB. */
	exactCountMaxTableBytes?: number
}

type ReadPlan =
	| { kind: 'query', input: Omit<QueryCommandInput, 'Limit' | 'ExclusiveStartKey'> }
	| { kind: 'scan', input: Omit<ScanCommandInput, 'Limit' | 'ExclusiveStartKey'> }

/**
 * Amazon DynamoDB (and DynamoDB Local / LocalStack) engine on the AWS SDK v3.
 *
 * - Tables come from ListTables. Columns are the key schema (partition key first, then sort key)
 *   plus the attributes seen in a sample of items, because DynamoDB is schemaless.
 * - Rows come from Scan (or Query when the partition key is filtered). DynamoDB pages with
 *   `LastEvaluatedKey`, not offsets, so the engine keeps the key at each page boundary it has seen.
 *   A far page scans forward from the nearest known boundary.
 * - Tables with a sort key get a synthetic `_key` column (JSON of the full primary key) that
 *   edits and deletes use.
 * - Numbers outside the safe integer range stay strings so they keep all digits.
 */
export class DynamodbEngine implements DatabaseEngine {
	private client: DynamoDBClient | null = null
	private readonly tableInfo = new Map<string, TableInfo>()
	private readonly columnCache = new Map<string, Column[]>()
	private readonly cursorCache = new Map<string, PageCursors>()
	private readonly countCache = new Map<string, CountInfo>()

	private readonly exactCountMaxTableBytes: number

	constructor(private readonly config: DynamodbConfig, options: DynamodbEngineOptions = {}) {
		this.exactCountMaxTableBytes = options.exactCountMaxTableBytes ?? EXACT_COUNT_MAX_TABLE_BYTES
	}

	/**
	 * Creates the client and runs one ListTables call, so bad credentials, an expired SSO
	 * session or an unreachable endpoint fail here with a clear message.
	 */
	async connect(): Promise<boolean> {
		this.client = new DynamoDBClient(dynamodbClientConfig(this.config))

		try {
			await this.client.send(new ListTablesCommand({ Limit: 1 }))
			return true
		} catch (error) {
			this.client.destroy()
			this.client = null
			throw new Error(describeDynamodbError(error, this.config))
		}
	}

	getType(): KnexClient {
		return 'dynamodb'
	}

	getConnection(): knexlib.Knex | null {
		return null
	}

	async isOkay(): Promise<boolean> {
		if (!this.client) return false
		try {
			await this.client.send(new ListTablesCommand({ Limit: 1 }))
			return true
		} catch {
			return false
		}
	}

	async getTables(): Promise<string[]> {
		const client = this.requireClient()
		const tables: string[] = []
		let start: string | undefined
		do {
			const response = await client.send(new ListTablesCommand({ ExclusiveStartTableName: start }))
			tables.push(...(response.TableNames ?? []))
			start = response.LastEvaluatedTableName
		} while (start)

		return tables.sort()
	}

	async getTableCreationSql(table: string): Promise<string> {
		const { description } = await this.getTableInfo(table)
		const summary = {
			TableName: description.TableName,
			KeySchema: description.KeySchema,
			AttributeDefinitions: description.AttributeDefinitions,
			BillingMode: description.BillingModeSummary?.BillingMode ?? (description.ProvisionedThroughput ? 'PROVISIONED' : undefined),
			GlobalSecondaryIndexes: description.GlobalSecondaryIndexes?.map(index => ({ IndexName: index.IndexName, KeySchema: index.KeySchema, Projection: index.Projection })),
			LocalSecondaryIndexes: description.LocalSecondaryIndexes?.map(index => ({ IndexName: index.IndexName, KeySchema: index.KeySchema, Projection: index.Projection })),
			StreamSpecification: description.StreamSpecification,
			ItemCount: description.ItemCount,
			TableSizeBytes: description.TableSizeBytes,
		}

		return `-- DynamoDB table description (DescribeTable). ItemCount and TableSizeBytes are approximate and updated about every 6 hours.\n${JSON.stringify(summary, null, 2)}`
	}

	/**
	 * Key columns first (`_key` for composite keys, then the partition key and the sort key), then
	 * every other attribute seen in a sample of {@link COLUMN_SAMPLE_SIZE} items, sorted by name.
	 * Type labels are DynamoDB descriptors (S, N, B, BOOL, M, L, SS, NS, BS, NULL); key columns add
	 * "PK" or "SK". An attribute with mixed types gets its most frequent type.
	 */
	async getColumns(table: string): Promise<Column[]> {
		const cached = this.columnCache.get(table)
		if (cached) return cached

		const { key } = await this.getTableInfo(table)
		const response = await this.requireClient().send(new ScanCommand({ TableName: table, Limit: COLUMN_SAMPLE_SIZE }))

		const typeCounts = new Map<string, Map<DynamodbAttributeType, number>>()
		for (const item of response.Items ?? []) {
			for (const [name, value] of Object.entries(item)) {
				const type = attributeTypeOf(value)
				if (!type) continue
				const counts = typeCounts.get(name) ?? new Map<DynamodbAttributeType, number>()
				counts.set(type, (counts.get(type) ?? 0) + 1)
				typeCounts.set(name, counts)
			}
		}

		const columns: Column[] = []
		if (key.sort) {
			columns.push({ name: DYNAMODB_COMPOSITE_KEY_COLUMN, type: 'key', isPrimaryKey: true, isNumeric: false, isPlainTextType: false, isNullable: false, isEditable: false })
		}

		columns.push(keyColumn(key.partition, 'PK', !key.sort))
		if (key.sort) {
			columns.push(keyColumn(key.sort, 'SK', false))
		}

		const keyNames = new Set([key.partition.name, key.sort?.name])
		const attributeNames = [...typeCounts.keys()].filter(name => !keyNames.has(name) && name !== DYNAMODB_COMPOSITE_KEY_COLUMN).sort((a, b) => a.localeCompare(b))
		for (const name of attributeNames) {
			const counts = [...typeCounts.get(name)!.entries()].sort((a, b) => b[1] - a[1])
			columns.push(attributeColumn(name, counts[0][0]))
		}

		this.columnCache.set(table, columns)
		return columns
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['n', 'n pk', 'n sk']
	}

	/**
	 * Unfiltered: an exact COUNT scan for tables up to {@link EXACT_COUNT_MAX_TABLE_BYTES}, else the
	 * DescribeTable ItemCount (approximate, updated about every 6 hours). Filtered: a COUNT scan or
	 * query, which stops after {@link FILTERED_COUNT_MAX_PAGES} pages and then reports a lower bound.
	 */
	async getTotalRows(table: string, _columns: Column[], whereClause?: Record<string, any>, signal?: AbortSignal): Promise<number> {
		return (await this.countInfo(table, whereClause, signal)).count
	}

	async getRows(table: string, _columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>, signal?: AbortSignal): Promise<QueryResponse | undefined> {
		const info = await this.getTableInfo(table)
		const columns = await this.getColumns(table)
		const plan = this.buildReadPlan(table, info.key, columns, whereClause)
		const cursors = this.cursorsFor(table, whereClause)

		let [position, cursor] = nearestCursor(cursors, offset)
		let scanned = 0

		// Skip forward to the requested offset, reading only the key attributes.
		while (position < offset && cursor !== END_OF_TABLE) {
			const response = await this.read(plan, Math.min(offset - position, SKIP_BATCH_SIZE), cursor, signal, info.key)
			position += response.items.length
			scanned += response.scanned
			cursor = response.lastKey ?? END_OF_TABLE
			cursors.set(position, cursor)
		}

		const items: Item[] = []
		while (position >= offset && items.length < limit && cursor !== END_OF_TABLE) {
			const response = await this.read(plan, limit - items.length, cursor, signal)
			items.push(...response.items)
			scanned += response.scanned
			cursor = response.lastKey ?? END_OF_TABLE
			cursors.set(offset + items.length, cursor)
		}

		const count = await this.countInfo(table, whereClause, signal)

		return {
			rows: items.map(item => this.toRow(item, info.key)),
			sql: describePlan(plan, limit, offset),
			stats: { rowsRead: scanned, totalRowsApproximate: count.approximate },
		}
	}

	async commitChange(serializedMutation: SerializedMutation, _transaction?: knexlib.Knex.Transaction | SQLiteTransaction): Promise<void> {
		const client = this.requireClient()
		const { key } = await this.getTableInfo(serializedMutation.table)
		const itemKey = parsePrimaryKey(key, serializedMutation.primaryKey)

		this.forgetReads(serializedMutation.table)

		if (serializedMutation.type === 'cell-update') {
			const mutation = serializedMutation as SerializedCellUpdateMutation
			const attribute = mutation.column.name
			if (attribute === key.partition.name || attribute === key.sort?.name || attribute === DYNAMODB_COMPOSITE_KEY_COLUMN) {
				throw new Error('DynamoDB key attributes cannot be changed. Delete the item and create it again with the new key.')
			}

			const type = baseTypeOf(mutation.column.type)
			await client.send(new UpdateItemCommand({
				TableName: mutation.table,
				Key: itemKey,
				UpdateExpression: 'SET #attribute = :value',
				ConditionExpression: 'attribute_exists(#pk)',
				ExpressionAttributeNames: { '#attribute': attribute, '#pk': key.partition.name },
				ExpressionAttributeValues: { ':value': cellValueToAttribute(type, mutation.newValue) },
			}))
			return
		}

		const mutation = serializedMutation as SerializedRowDeletionMutation
		await client.send(new DeleteItemCommand({
			TableName: mutation.table,
			Key: itemKey,
			ConditionExpression: 'attribute_exists(#pk)',
			ExpressionAttributeNames: { '#pk': key.partition.name },
		}))
	}

	async getVersion(): Promise<string | undefined> {
		return this.config.endpoint ? `DynamoDB (${this.config.endpoint})` : `DynamoDB (${this.config.region ?? 'default region'})`
	}

	async disconnect(): Promise<void> {
		this.client?.destroy()
		this.client = null
		this.tableInfo.clear()
		this.columnCache.clear()
		this.cursorCache.clear()
		this.countCache.clear()
	}

	/**
	 * Runs one PartiQL statement with ExecuteStatement and returns up to {@link RAW_QUERY_MAX_ROWS}
	 * items (the array has `truncated: true` when more exist). With `readOnly` only SELECT runs.
	 */
	async rawQuery(code: string, options?: RawQueryOptions): Promise<any> {
		const client = this.requireClient()
		const statement = String(code ?? '').trim().replace(/;\s*$/, '')
		if (!statement) {
			throw new Error('Empty statement')
		}

		if (options?.readOnly) {
			assertReadOnlyPartiql(statement)
		}

		const rows: Record<string, any>[] & { truncated?: boolean } = []
		let nextToken: string | undefined
		do {
			const response = await client.send(
				new ExecuteStatementCommand({ Statement: statement, NextToken: nextToken }),
				{ abortSignal: options?.signal as any },
			)
			for (const item of response.Items ?? []) {
				if (rows.length >= RAW_QUERY_MAX_ROWS) {
					rows.truncated = true
					return rows
				}
				rows.push(itemToRow(item))
			}
			nextToken = response.NextToken
		} while (nextToken)

		return rows
	}

	private requireClient(): DynamoDBClient {
		if (!this.client) {
			throw new Error('Not connected to DynamoDB')
		}
		return this.client
	}

	private async getTableInfo(table: string): Promise<TableInfo> {
		const cached = this.tableInfo.get(table)
		if (cached) return cached

		const response = await this.requireClient().send(new DescribeTableCommand({ TableName: table }))
		const description = response.Table
		if (!description) {
			throw new Error(`DynamoDB table "${table}" not found`)
		}

		const info = { description, key: keySchemaOf(description) }
		this.tableInfo.set(table, info)
		return info
	}

	private cacheKey(table: string, whereClause?: Record<string, any>): string {
		return `${table}\u0000${JSON.stringify(activeFilters(whereClause))}`
	}

	private cursorsFor(table: string, whereClause?: Record<string, any>): PageCursors {
		const key = this.cacheKey(table, whereClause)
		let cursors = this.cursorCache.get(key)
		if (!cursors) {
			cursors = new Map([[0, undefined as unknown as Item]])
			this.cursorCache.set(key, cursors)
		}
		return cursors
	}

	private forgetReads(table: string): void {
		for (const cache of [this.cursorCache, this.countCache]) {
			for (const key of [...cache.keys()]) {
				if (key.startsWith(`${table}\u0000`)) cache.delete(key)
			}
		}
		this.columnCache.delete(table)
	}

	private async countInfo(table: string, whereClause: Record<string, any> | undefined, signal?: AbortSignal): Promise<CountInfo> {
		const cacheKey = this.cacheKey(table, whereClause)
		const cached = this.countCache.get(cacheKey)
		if (cached) return cached

		const info = await this.getTableInfo(table)
		const filtered = Object.keys(activeFilters(whereClause)).length > 0
		const tableBytes = info.description.TableSizeBytes ?? 0

		let result: CountInfo
		if (!filtered && tableBytes > this.exactCountMaxTableBytes) {
			result = { count: info.description.ItemCount ?? 0, approximate: true }
		} else {
			const plan = this.buildReadPlan(table, info.key, await this.getColumns(table), whereClause)
			result = await this.countWithPlan(plan, filtered ? FILTERED_COUNT_MAX_PAGES : Number.POSITIVE_INFINITY, signal)
		}

		this.countCache.set(cacheKey, result)
		return result
	}

	private async countWithPlan(plan: ReadPlan, maxPages: number, signal?: AbortSignal): Promise<CountInfo> {
		const client = this.requireClient()
		let count = 0
		let pages = 0
		let start: Item | undefined
		do {
			const response = plan.kind === 'query'
				? await client.send(new QueryCommand({ ...plan.input, Select: 'COUNT', ExclusiveStartKey: start }), { abortSignal: signal as any })
				: await client.send(new ScanCommand({ ...plan.input, Select: 'COUNT', ExclusiveStartKey: start }), { abortSignal: signal as any })
			count += response.Count ?? 0
			start = response.LastEvaluatedKey
			pages++
		} while (start && pages < maxPages)

		return { count, approximate: Boolean(start) }
	}

	private async read(plan: ReadPlan, limit: number, start: Item | undefined, signal?: AbortSignal, keysOnly?: KeySchema): Promise<{ items: Item[], lastKey?: Item, scanned: number }> {
		const client = this.requireClient()
		const projection = keysOnly ? keyProjection(keysOnly, plan.input.ExpressionAttributeNames) : {}
		const response = plan.kind === 'query'
			? await client.send(new QueryCommand({ ...plan.input, ...projection, Limit: limit, ExclusiveStartKey: start }), { abortSignal: signal as any })
			: await client.send(new ScanCommand({ ...plan.input, ...projection, Limit: limit, ExclusiveStartKey: start }), { abortSignal: signal as any })

		return { items: response.Items ?? [], lastKey: response.LastEvaluatedKey, scanned: response.ScannedCount ?? 0 }
	}

	/**
	 * Column filters become a Query when the partition key is filtered (equality; the sort key then
	 * uses begins_with for strings and = otherwise). Else a Scan with a FilterExpression: contains()
	 * for strings, begins_with() for string keys, = for numbers and booleans. Values always go in
	 * ExpressionAttributeValues and names in ExpressionAttributeNames.
	 */
	private buildReadPlan(table: string, key: KeySchema, columns: Column[], whereClause?: Record<string, any>): ReadPlan {
		const filters = activeFilters(whereClause)
		const names: Record<string, string> = {}
		const values: Item = {}
		const keyConditions: string[] = []
		const filterConditions: string[] = []
		let index = 0

		const partitionValue = filters[key.partition.name]
		const useQuery = partitionValue !== undefined

		for (const [column, raw] of Object.entries(filters)) {
			if (column === DYNAMODB_COMPOSITE_KEY_COLUMN) continue

			const name = `#f${index}`
			const value = `:f${index}`
			index++
			names[name] = column

			if (column === key.partition.name) {
				values[value] = keyValueToAttribute(key.partition.type, raw)
				if (useQuery) keyConditions.push(`${name} = ${value}`)
				continue
			}

			if (column === key.sort?.name) {
				const sortKey = key.sort
				values[value] = keyValueToAttribute(sortKey.type, raw)
				const condition = sortKey.type === 'S' ? `begins_with(${name}, ${value})` : `${name} = ${value}`
				if (useQuery) keyConditions.push(condition)
				else filterConditions.push(condition)
				continue
			}

			const type = baseTypeOf(columns.find(candidate => candidate.name === column)?.type ?? 'S')
			const text = String(raw)
			if (type === 'N' && isNumericText(text)) {
				values[value] = { N: text.trim() }
				filterConditions.push(`${name} = ${value}`)
			} else if (type === 'BOOL' && /^(true|false)$/i.test(text.trim())) {
				values[value] = { BOOL: text.trim().toLowerCase() === 'true' }
				filterConditions.push(`${name} = ${value}`)
			} else {
				values[value] = { S: text }
				filterConditions.push(`contains(${name}, ${value})`)
			}
		}

		const common = {
			TableName: table,
			...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
			...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
			...(filterConditions.length ? { FilterExpression: filterConditions.join(' AND ') } : {}),
		}

		if (useQuery) {
			return { kind: 'query', input: { ...common, KeyConditionExpression: keyConditions.join(' AND ') } }
		}

		return { kind: 'scan', input: common }
	}

	private toRow(item: Item, key: KeySchema): Record<string, any> {
		const row = itemToRow(item)
		if (key.sort) {
			row[DYNAMODB_COMPOSITE_KEY_COLUMN] = JSON.stringify({
				[key.partition.name]: row[key.partition.name],
				[key.sort.name]: row[key.sort.name],
			})
		}
		return row
	}
}

/**
 * SDK client options. A profile uses the default provider chain for that profile (static keys,
 * SSO, process, assume-role). A custom endpoint without credentials (DynamoDB Local, LocalStack)
 * gets dummy keys, because those servers accept any.
 */
export function dynamodbClientConfig(config: DynamodbConfig): DynamoDBClientConfig {
	const clientConfig: DynamoDBClientConfig = {
		region: config.region || (config.endpoint ? 'us-east-1' : undefined),
		maxAttempts: 3,
		requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: 60_000 } as any,
	}

	if (config.endpoint) {
		clientConfig.endpoint = config.endpoint
	}

	if (config.authMethod === 'keys' && config.accessKeyId && config.secretAccessKey) {
		clientConfig.credentials = {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
		}
	} else if (config.authMethod !== 'keys' && config.profile) {
		clientConfig.profile = config.profile
	} else if (config.endpoint) {
		// DynamoDB Local 2.x accepts only letters and digits in the access key ID.
		clientConfig.credentials = { accessKeyId: DYNAMODB_LOCAL_ACCESS_KEY_ID, secretAccessKey: DYNAMODB_LOCAL_ACCESS_KEY_ID }
	}

	return clientConfig
}

/**
 * Turns SDK errors into short messages. An expired or missing SSO session tells the user which
 * `aws sso login` command to run. Credentials never appear in the message.
 */
export function describeDynamodbError(error: unknown, config: Pick<DynamodbConfig, 'profile' | 'accessKeyId' | 'secretAccessKey' | 'sessionToken'>): string {
	const name = (error as any)?.name ?? ''
	let message = error instanceof Error ? error.message : String(error)

	for (const secret of [config.secretAccessKey, config.sessionToken, config.accessKeyId]) {
		if (secret) message = message.split(secret).join('****')
	}

	if (/sso/i.test(`${name} ${message}`) && /expired|refresh|invalid|login|token/i.test(message)) {
		const profile = config.profile || 'default'
		return `The AWS SSO session for profile "${profile}" has expired or is missing. Run \`aws sso login --profile ${profile}\` and connect again.`
	}

	if (name === 'CredentialsProviderError' || /Could not load credentials/i.test(message)) {
		return `No AWS credentials found${config.profile ? ` for profile "${config.profile}"` : ''}. Check ~/.aws/config and ~/.aws/credentials, or use an access key.`
	}

	if (name === 'UnrecognizedClientException' || name === 'InvalidSignatureException') {
		return `AWS rejected the credentials: ${message.split('\n')[0]}`
	}

	const code = (error as any)?.code
	if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(message)) {
		return `Could not reach the DynamoDB endpoint (connection refused). Is DynamoDB Local running?`
	}

	return message.split('\n')[0].trim() || name || 'Unknown DynamoDB error'
}

/**
 * Allows only a single PartiQL SELECT. INSERT, UPDATE, DELETE and anything else is refused.
 */
export function assertReadOnlyPartiql(statement: string): void {
	const code = stripPartiqlCommentsAndStrings(statement).trim().replace(/;\s*$/, '')
	if (code.includes(';')) {
		throw new Error('Read-only mode allows one PartiQL statement only')
	}

	const keyword = (code.match(/^\s*([A-Za-z]+)/)?.[1] ?? '').toUpperCase()
	if (keyword !== 'SELECT') {
		throw new Error(`Read-only mode allows only PartiQL SELECT statements, not ${keyword || 'this statement'}`)
	}
}

/**
 * Removes `--` and block comments and blanks string literals, so keyword checks only see code.
 * PartiQL strings use single quotes; double quotes are identifiers.
 */
export function stripPartiqlCommentsAndStrings(statement: string): string {
	let out = ''
	let i = 0
	while (i < statement.length) {
		const ch = statement[i]
		const next = statement[i + 1]
		if (ch === '\'') {
			let end = i + 1
			while (end < statement.length) {
				if (statement[end] === '\'' && statement[end + 1] === '\'') { end += 2; continue }
				if (statement[end] === '\'') break
				end++
			}
			out += '\'\''
			i = end + 1
		} else if (ch === '-' && next === '-') {
			const close = statement.indexOf('\n', i)
			i = close === -1 ? statement.length : close + 1
			out += ' '
		} else if (ch === '/' && next === '*') {
			const close = statement.indexOf('*/', i + 2)
			i = close === -1 ? statement.length : close + 2
			out += ' '
		} else {
			out += ch
			i++
		}
	}
	return out
}

export function attributeTypeOf(value: AttributeValue | undefined): DynamodbAttributeType | undefined {
	if (!value) return undefined
	return ATTRIBUTE_TYPES.find(type => (value as any)[type] !== undefined)
}

/**
 * Renders one item as a table row: strings, booleans and null as they are; numbers as JS numbers
 * when exact, else as strings; binary as base64; maps, lists and sets as JSON text.
 */
export function itemToRow(item: Item): Record<string, any> {
	const row: Record<string, any> = {}
	for (const [name, value] of Object.entries(item)) {
		row[name] = renderAttribute(value)
	}
	return row
}

export function renderAttribute(value: AttributeValue): any {
	const type = attributeTypeOf(value)
	switch (type) {
		case 'M':
		case 'L':
		case 'SS':
		case 'NS':
		case 'BS':
			return JSON.stringify(attributeToPlain(value))
		default:
			return attributeToPlain(value)
	}
}

/**
 * Converts an AttributeValue to a plain JS value. Numbers that a double cannot hold exactly stay
 * strings.
 */
export function attributeToPlain(value: AttributeValue): any {
	const v = value as any
	switch (attributeTypeOf(value)) {
		case 'S': return v.S
		case 'N': return numberFromText(v.N)
		case 'B': return Buffer.from(v.B).toString('base64')
		case 'BOOL': return v.BOOL
		case 'NULL': return null
		case 'M': return Object.fromEntries(Object.entries(v.M as Item).map(([name, inner]) => [name, attributeToPlain(inner)]))
		case 'L': return (v.L as AttributeValue[]).map(attributeToPlain)
		case 'SS': return [...v.SS]
		case 'NS': return (v.NS as string[]).map(numberFromText)
		case 'BS': return (v.BS as Uint8Array[]).map(bytes => Buffer.from(bytes).toString('base64'))
		default: return null
	}
}

/**
 * Returns a JS number when it round-trips to the same digits (safe integers, plain decimals);
 * otherwise the original string, e.g. 12345678901234567890.
 */
export function numberFromText(text: string): number | string {
	const trimmed = text.trim()
	const number = Number(trimmed)
	if (!Number.isFinite(number)) return trimmed
	if (/^-?\d+$/.test(trimmed)) {
		return Number.isSafeInteger(number) ? number : trimmed
	}
	return String(number) === trimmed ? number : trimmed
}

/**
 * Converts a JSON value (from a cell edit of a map or list) to an AttributeValue.
 */
export function jsonToAttribute(value: unknown): AttributeValue {
	if (value === null || value === undefined) return { NULL: true }
	if (typeof value === 'string') return { S: value }
	if (typeof value === 'number') return { N: String(value) }
	if (typeof value === 'boolean') return { BOOL: value }
	if (Array.isArray(value)) return { L: value.map(jsonToAttribute) }
	if (typeof value === 'object') {
		return { M: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, inner]) => [name, jsonToAttribute(inner)])) }
	}
	return { S: String(value) }
}

export function cellValueToAttribute(type: DynamodbAttributeType, newValue: unknown): AttributeValue {
	if (newValue === null || newValue === undefined) {
		return { NULL: true }
	}

	const text = String(newValue)
	switch (type) {
		case 'N':
			if (!isNumericText(text)) throw new Error(`"${text}" is not a number`)
			return { N: text.trim() }
		case 'BOOL':
			if (typeof newValue === 'boolean') return { BOOL: newValue }
			if (!/^(true|false|1|0)$/i.test(text.trim())) throw new Error(`"${text}" is not true or false`)
			return { BOOL: /^(true|1)$/i.test(text.trim()) }
		case 'M':
		case 'L': {
			let parsed: unknown
			try {
				parsed = typeof newValue === 'string' ? JSON.parse(newValue) : newValue
			} catch {
				throw new Error(`Enter valid JSON for a DynamoDB ${type === 'M' ? 'map' : 'list'}`)
			}
			if (type === 'M' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Enter a JSON object for a DynamoDB map')
			if (type === 'L' && !Array.isArray(parsed)) throw new Error('Enter a JSON array for a DynamoDB list')
			return jsonToAttribute(parsed)
		}
		case 'S':
		case 'NULL':
			return { S: text }
		default:
			throw new Error(`Editing DynamoDB ${type} attributes is not supported`)
	}
}

/**
 * Parses the value of the primary key column back into a DynamoDB key: the partition key value
 * for simple keys, or the JSON `_key` value for composite keys.
 */
export function parsePrimaryKey(key: KeySchema, primaryKey: unknown): Item {
	if (!key.sort) {
		return { [key.partition.name]: keyValueToAttribute(key.partition.type, primaryKey) }
	}

	let parsed: Record<string, unknown>
	try {
		parsed = typeof primaryKey === 'string' ? JSON.parse(primaryKey) : primaryKey as Record<string, unknown>
	} catch {
		throw new Error('Invalid DynamoDB composite key')
	}

	if (!parsed || parsed[key.partition.name] === undefined || parsed[key.sort.name] === undefined) {
		throw new Error('Invalid DynamoDB composite key')
	}

	return {
		[key.partition.name]: keyValueToAttribute(key.partition.type, parsed[key.partition.name]),
		[key.sort.name]: keyValueToAttribute(key.sort.type, parsed[key.sort.name]),
	}
}

export function keyValueToAttribute(type: 'S' | 'N' | 'B', value: unknown): AttributeValue {
	const text = String(value)
	if (type === 'N') {
		if (!isNumericText(text)) throw new Error(`"${text}" is not a number`)
		return { N: text.trim() }
	}
	if (type === 'B') return { B: Buffer.from(text, 'base64') }
	return { S: text }
}

export function keySchemaOf(description: TableDescription): KeySchema {
	const definitions = new Map((description.AttributeDefinitions ?? []).map(definition => [definition.AttributeName!, definition.AttributeType as 'S' | 'N' | 'B']))
	const hash = description.KeySchema?.find(element => element.KeyType === 'HASH')
	const range = description.KeySchema?.find(element => element.KeyType === 'RANGE')
	if (!hash?.AttributeName) {
		throw new Error(`DynamoDB table "${description.TableName}" has no partition key`)
	}

	return {
		partition: { name: hash.AttributeName, type: definitions.get(hash.AttributeName) ?? 'S' },
		sort: range?.AttributeName ? { name: range.AttributeName, type: definitions.get(range.AttributeName) ?? 'S' } : undefined,
	}
}

function keyColumn(attribute: KeyAttribute, role: 'PK' | 'SK', isPrimaryKey: boolean): Column {
	return {
		name: attribute.name,
		type: `${attribute.type} ${role}`,
		isPrimaryKey,
		isNumeric: attribute.type === 'N',
		isPlainTextType: attribute.type === 'S',
		isNullable: false,
		isEditable: false,
	}
}

function attributeColumn(name: string, type: DynamodbAttributeType): Column {
	return {
		name,
		type: type === 'BOOL' ? 'boolean' : type,
		isPrimaryKey: false,
		isNumeric: type === 'N',
		isPlainTextType: type === 'S',
		isNullable: true,
		isEditable: EDITABLE_TYPES.includes(type),
	}
}

/**
 * Maps a column type label ("S", "N PK", "boolean", ...) back to a DynamoDB type descriptor.
 */
export function baseTypeOf(columnType: string): DynamodbAttributeType {
	const head = columnType.trim().split(/\s+/)[0].toUpperCase()
	if (head === 'BOOLEAN') return 'BOOL'
	return (ATTRIBUTE_TYPES as string[]).includes(head) ? head as DynamodbAttributeType : 'S'
}

function isNumericText(text: string): boolean {
	return /^\s*-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(text)
}

function activeFilters(whereClause?: Record<string, any>): Record<string, any> {
	const filters: Record<string, any> = {}
	for (const [column, value] of Object.entries(whereClause ?? {})) {
		if (value === undefined || value === null || String(value) === '') continue
		filters[column] = value
	}
	return filters
}

function nearestCursor(cursors: PageCursors, offset: number): [number, Item | undefined | typeof END_OF_TABLE] {
	let best = 0
	for (const position of cursors.keys()) {
		if (position <= offset && position > best) best = position
	}
	return [best, cursors.get(best)]
}

function keyProjection(key: KeySchema, existingNames?: Record<string, string>): Pick<ScanCommandInput, 'ProjectionExpression' | 'ExpressionAttributeNames'> {
	const names: Record<string, string> = { ...(existingNames ?? {}), '#kp': key.partition.name }
	const projection = ['#kp']
	if (key.sort) {
		names['#ks'] = key.sort.name
		projection.push('#ks')
	}
	return { ProjectionExpression: projection.join(', '), ExpressionAttributeNames: names }
}

function describePlan(plan: ReadPlan, limit: number, offset: number): string {
	const input = plan.input as Record<string, any>
	const parts = [`${plan.kind === 'query' ? 'Query' : 'Scan'} ${input.TableName}`]
	if (input.KeyConditionExpression) parts.push(`KeyConditionExpression: ${input.KeyConditionExpression}`)
	if (input.FilterExpression) parts.push(`FilterExpression: ${input.FilterExpression}`)
	if (input.ExpressionAttributeNames) parts.push(`ExpressionAttributeNames: ${JSON.stringify(input.ExpressionAttributeNames)}`)
	parts.push(`Limit: ${limit}`, `Offset: ${offset}`)
	return parts.join(' | ')
}
