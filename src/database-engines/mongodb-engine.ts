import { MongoClient, Db, ObjectId } from 'mongodb'
import { Column, DatabaseEngine, KnexClient, MongodbConfig, QueryResponse, SerializedMutation, SerializedCellUpdateMutation, SerializedRowDeletionMutation } from '../types'
import knexlib from 'knex'
import { SQLiteTransaction } from './sqlite-engine'

export class MongodbEngine implements DatabaseEngine {
	private client: MongoClient | null = null
	private db: Db | null = null
	private config: MongodbConfig

	constructor(config: MongodbConfig) {
		this.config = config
	}

	async connect(): Promise<boolean> {
		try {
			let uri: string

			if (this.config.connectionString) {
				uri = this.config.connectionString
			} else {
				const host = this.config.host ?? 'localhost'
				const port = this.config.port ?? 27017
				const authSource = this.config.authSource ?? 'admin'

				if (this.config.username && this.config.password) {
					uri = `mongodb://${encodeURIComponent(this.config.username)}:${encodeURIComponent(this.config.password)}@${host}:${port}/${this.config.database}?authSource=${authSource}`
				} else {
					uri = `mongodb://${host}:${port}/${this.config.database}`
				}
			}

			this.client = new MongoClient(uri)
			await this.client.connect()
			this.db = this.client.db(this.config.database)
			await this.db.command({ ping: 1 })
			return true
		} catch {
			this.client = null
			this.db = null
			return false
		}
	}

	getType(): KnexClient {
		return 'mongodb'
	}

	getConnection(): knexlib.Knex | null {
		return null
	}

	async isOkay(): Promise<boolean> {
		if (!this.db) return false
		try {
			await this.db.command({ ping: 1 })
			return true
		} catch {
			return false
		}
	}

	async getTables(): Promise<string[]> {
		if (!this.db) return []
		const collections = await this.db.listCollections().toArray()
		return collections.map(c => c.name).sort()
	}

	async getColumns(collection: string): Promise<Column[]> {
		if (!this.db) return []

		const sampleSize = this.config.schemaSampleSize ?? 100
		const docs = await this.db.collection(collection).find().limit(sampleSize).toArray()

		if (docs.length === 0) return []

		const fieldTypes = new Map<string, Set<string>>()

		for (const doc of docs) {
			this.extractFields(doc, '', fieldTypes)
		}

		const columns: Column[] = []
		for (const [fieldName, types] of fieldTypes) {
			const typeStr = [...types].join(' | ')
			columns.push({
				name: fieldName,
				type: typeStr,
				isPrimaryKey: fieldName === '_id',
				isNumeric: types.has('number'),
				isPlainTextType: types.has('string'),
				isNullable: true,
				isEditable: types.has('string') || types.has('number') || types.has('boolean'),
			})
		}

		const idIndex = columns.findIndex(c => c.name === '_id')
		if (idIndex > 0) {
			const [idCol] = columns.splice(idIndex, 1)
			columns.unshift(idCol)
		}

		return columns
	}

	private extractFields(obj: Record<string, any>, prefix: string, fieldTypes: Map<string, Set<string>>) {
		for (const [key, value] of Object.entries(obj)) {
			const fieldName = prefix ? `${prefix}.${key}` : key
			const typeName = this.getMongoType(value)

			if (!fieldTypes.has(fieldName)) {
				fieldTypes.set(fieldName, new Set())
			}
			fieldTypes.get(fieldName)!.add(typeName)
		}
	}

	private getMongoType(value: any): string {
		if (value === null || value === undefined) return 'null'
		if (value instanceof ObjectId) return 'ObjectId'
		if (value instanceof Date) return 'Date'
		if (Array.isArray(value)) return 'Array'
		return typeof value
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['number', 'int', 'long', 'double', 'decimal']
	}

	async getTableCreationSql(collection: string): Promise<string> {
		if (!this.db) return ''
		const indexes = await this.db.collection(collection).indexes()
		return JSON.stringify(indexes, null, 2)
	}

	async getTotalRows(collection: string, _columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		if (!this.db) return 0
		const filter = this.buildMongoFilter(whereClause)
		return this.db.collection(collection).countDocuments(filter)
	}

	async getRows(collection: string, _columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!this.db) return undefined
		const filter = this.buildMongoFilter(whereClause)
		const rows = await this.db.collection(collection).find(filter).skip(offset).limit(limit).toArray()

		const serializedRows = rows.map(row => {
			const serialized: Record<string, any> = {}
			for (const [key, value] of Object.entries(row)) {
				if (value instanceof ObjectId) {
					serialized[key] = value.toHexString()
				} else if (value instanceof Date) {
					serialized[key] = value.toISOString()
				} else if (typeof value === 'object' && value !== null) {
					serialized[key] = JSON.stringify(value)
				} else {
					serialized[key] = value
				}
			}
			return serialized
		})

		return { rows: serializedRows }
	}

	async commitChange(serializedMutation: SerializedMutation, _transaction: knexlib.Knex.Transaction | SQLiteTransaction): Promise<void> {
		if (!this.db) throw new Error('Not connected')

		if (serializedMutation.type === 'cell-update') {
			const mutation = serializedMutation as SerializedCellUpdateMutation
			let objectId: ObjectId
			try {
				objectId = new ObjectId(String(mutation.primaryKey))
			} catch {
				throw new Error(`Invalid ObjectId: ${mutation.primaryKey}`)
			}

			await this.db.collection(mutation.table).updateOne(
				{ _id: objectId },
				{ $set: { [mutation.column.name]: mutation.newValue } }
			)
		}

		if (serializedMutation.type === 'row-delete') {
			const mutation = serializedMutation as SerializedRowDeletionMutation
			let objectId: ObjectId
			try {
				objectId = new ObjectId(String(mutation.primaryKey))
			} catch {
				throw new Error(`Invalid ObjectId: ${mutation.primaryKey}`)
			}

			await this.db.collection(mutation.table).deleteOne({ _id: objectId })
		}
	}

	async getVersion(): Promise<string | undefined> {
		if (!this.db) return undefined
		try {
			const info = await this.db.command({ buildInfo: 1 })
			return info.version
		} catch {
			return undefined
		}
	}

	async rawQuery(code: string): Promise<any> {
		if (!this.db) throw new Error('Not connected')

		const parsed = JSON.parse(code)
		const { collection, operation, query } = parsed
		const coll = this.db.collection(collection)

		switch (operation) {
			case 'find':
				return coll.find(query?.filter ?? {}).limit(query?.limit ?? 100).toArray()
			case 'aggregate':
				return coll.aggregate(query?.pipeline ?? []).toArray()
			case 'count':
				return coll.countDocuments(query?.filter ?? {})
			default:
				throw new Error(`Unsupported operation: ${operation}`)
		}
	}

	async disconnect(): Promise<void> {
		if (this.client) {
			await this.client.close()
			this.client = null
			this.db = null
		}
	}

	private buildMongoFilter(whereClause?: Record<string, any>): Record<string, any> {
		if (!whereClause || Object.keys(whereClause).length === 0) return {}

		const filter: Record<string, any> = {}
		for (const [key, value] of Object.entries(whereClause)) {
			if (typeof value === 'string') {
				filter[key] = { $regex: value, $options: 'i' }
			} else {
				filter[key] = value
			}
		}
		return filter
	}
}
