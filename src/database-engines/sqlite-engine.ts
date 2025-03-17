import knexlib from "knex";
import { stat } from 'fs/promises';
import { Column, DatabaseEngine, ForeignKey, KnexClient, QueryResponse, SerializedMutation } from '../types';
import { SqlService } from '../services/sql';
import { reportError } from '../services/initialization-error-service';

export class SqliteEngine implements DatabaseEngine {

	public connection: knexlib.Knex | null = null;

	constructor(sqliteFilePath?: string) {
		try {
			this.connection = knexlib.knex({
				client: 'better-sqlite3',
				useNullAsDefault: true,
				connection: {
					filename: sqliteFilePath ?? ':memory:',
				},
			});
		} catch (error) {
			reportError(String(error));
		}
	}

	getType(): KnexClient {
		return 'better-sqlite3';
	}

	getConnection(): knexlib.Knex | null {
		return this.connection
	}

	async isOkay(): Promise<boolean> {
		if (!this.connection) return false;

		const file = (this.connection).client.config.connection.filename;
		const isInMemory = file === undefined

		if (isInMemory) return true;

		const stats = await stat(file);
		const fileSizeGB = Math.round((stats.size / (1024 * 1024 * 1024) + Number.EPSILON) * 100) / 100; // Convert to GB and round to 2 decimal places
		const size = 5

		if (fileSizeGB > size) {
			reportError(`Warning: SQLite database file size too big for database integrity check: ${fileSizeGB}GB. Maximum size is ${size}GB. Hence, database integrity not checked. File: ${file}`)

			return true
		}

		const result: { integrity_check: 'ok' | string }[] = (await this.connection.raw('PRAGMA integrity_check;'))[0];
		return result[0]['integrity_check'] === 'ok';
	}

	async disconnect() {
		if (this.connection) this.connection.destroy(() => null);
	}

	async getTableCreationSql(table: string): Promise<string> {
		if (!this.connection) return '';

		const creationSql = (await this.connection.raw(`SELECT sql FROM sqlite_master WHERE name = ?`, [table]))[0];

		const sql = (creationSql as any).sql;

		return (await import('sql-formatter')).format(sql, { language: 'sql' })
	}

	async getTables(): Promise<string[]> {
		if (!this.connection) return [];

		const tables = await this.connection.raw("SELECT name FROM sqlite_master WHERE type='table'");

		return tables.map((table: any) => table.name).sort();
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.connection) return [];

		const columns = (await this.connection.raw(`PRAGMA table_info(??)`, [table])) as any[];

		const computedColumns: Column[] = []

		for (const column of columns) {
			const foreignKey = await getForeignKeyFor(table, column.name, this.connection)

			computedColumns.push({
				name: column.name,
				type: column.type,
				isPrimaryKey: column.pk === 1,
				isNumeric: this.getNumericColumnTypeNamesLowercase().includes(column.type.toLowerCase()),
				isNullable: column.notnull === 0,
				foreignKey
			})
		}

		return computedColumns
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['integer', 'real', 'numeric'];
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number | undefined> {
		return SqlService.getTotalRows(this, 'better-sqlite3', this.connection, table, columns, whereClause);
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqlService.getRows(this, 'better-sqlite3', this.connection, table, columns, limit, offset, whereClause);
	}

	async getVersion(): Promise<string | undefined> {
		return undefined
	}

	async commitChange(serializedMutation: SerializedMutation, transaction?: knexlib.Knex.Transaction): Promise<void> {
		await SqlService.commitChange(this.connection, serializedMutation, transaction);
	}

	async runArbitraryQueryAndGetOutput(code: string): Promise<string | undefined> {
		if (!this.connection) throw new Error('Connection not initialized');

		return ((await this.connection.raw(code))[0])
	}
}

async function getForeignKeyFor(table: string, column: string, connection: knexlib.Knex): Promise<ForeignKey | undefined> {
	const foreignKeys = await connection.raw(`PRAGMA foreign_key_list(??);`, [table]);

	if (!foreignKeys || !foreignKeys.length) return;

	const foreignKey = foreignKeys[0] as any as { table: string, from: string, to: string };

	return {
		table: foreignKey.table,
		column: foreignKey.to,
	};
}
