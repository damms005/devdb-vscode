import { stat } from 'fs/promises';
import { Column, DatabaseEngine, ForeignKey, KnexClient, QueryResponse, SerializedMutation } from '../types';
import { reportError } from '../services/initialization-error-service';
import { SQLiteEngineProvider } from './sqlite-engine-provider';

export class SqliteEngine implements DatabaseEngine {

	private provider: SQLiteEngineProvider | null = null;

	constructor(sqliteFilePath?: string) {
		try {
			this.provider = new SQLiteEngineProvider(sqliteFilePath ?? ':memory:');
		} catch (error) {
			reportError(String(error));
		}
	}

	getType(): KnexClient {
		return 'sqlite';
	}

	getConnection(): SQLiteEngineProvider {
		if (!this.provider) throw new Error('No SQLite database available. Ensure you are connected?')

		return this.provider;
	}

	async isOkay(): Promise<boolean> {
		if (!this.provider) return false;

		const file = this.provider.dbPath;
		const isInMemory = file === ':memory:';

		if (isInMemory) return true;

		const stats = await stat(file);
		const fileSizeGB = Math.round((stats.size / (1024 * 1024 * 1024) + Number.EPSILON) * 100) / 100; // Convert to GB and round to 2 decimal places
		const size = 5;

		if (fileSizeGB > size) {
			reportError(`Warning: SQLite database file size too big for database integrity check: ${fileSizeGB}GB. Maximum size is ${size}GB. Hence, database integrity not checked. File: ${file}`);
			return true;
		}

		const result = await this.rawQuery('PRAGMA integrity_check;');
		const parsedResult = result ? JSON.parse(result) : null;
		return parsedResult && parsedResult[0] && parsedResult[0]['integrity_check'] === 'ok';
	}

	async disconnect() {
		if (this.provider) await this.provider.disconnect();
	}

	async getTableCreationSql(table: string): Promise<string> {
		if (!this.provider) return '';

		const creationSql = await this.rawQuery(`SELECT sql FROM sqlite_master WHERE name = '${table}'`);
		const parsedCreationSql = creationSql ? JSON.parse(creationSql) : null;

		if (!parsedCreationSql || !parsedCreationSql[0]) return '';

		const sql = parsedCreationSql[0].sql;

		return (await import('sql-formatter')).format(sql, { language: 'sql' });
	}

	async getTables(): Promise<string[]> {
		if (!this.provider) return [];

		const tablesResult = await this.rawQuery("SELECT name FROM sqlite_master WHERE type='table'");
		const tables = tablesResult ? JSON.parse(tablesResult) : null;

		if (!tables) return [];

		return tables.map((table: any) => table.name).sort();
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.provider) return [];

		const columnsResult = await this.rawQuery(`PRAGMA table_info(${table})`);
		const columns = columnsResult ? JSON.parse(columnsResult) : null;

		if (!columns) return [];

		const computedColumns: Column[] = [];

		for (const column of columns) {
			const foreignKey = await this.getForeignKeyFor(table, column.name);

			computedColumns.push({
				name: column.name,
				type: column.type,
				isPrimaryKey: column.pk === 1,
				isNumeric: this.getNumericColumnTypeNamesLowercase().includes(column.type.toLowerCase()),
				isNullable: column.notnull === 0,
				foreignKey
			});
		}

		return computedColumns;
	}

	private async getForeignKeyFor(table: string, column: string): Promise<ForeignKey | undefined> {
		if (!this.provider) return undefined;

		const foreignKeysResult = await this.rawQuery(`PRAGMA foreign_key_list(${table});`);
		const foreignKeys = foreignKeysResult ? JSON.parse(foreignKeysResult) : null;

		if (!foreignKeys || !foreignKeys.length) return undefined;

		const foreignKey = foreignKeys.find((fk: any) => fk.from === column);

		if (!foreignKey) return undefined;

		return {
			table: foreignKey.table,
			column: foreignKey.to,
		};
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['integer', 'real', 'numeric'];
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		if (!this.provider) return 0;

		return this.provider.getTotalRows(table, columns, whereClause);
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!this.provider) return undefined;

		return this.provider.getRows(table, columns, limit, offset, whereClause);
	}

	async getVersion(): Promise<string | undefined> {
		return undefined;
	}

	async commitChange(serializedMutation: SerializedMutation, transaction?: any): Promise<void> {
		if (!this.provider) return;

		await this.provider.commitChange(serializedMutation, transaction);
	}

	async rawQuery(code: string): Promise<string | undefined> {
		if (!this.provider) throw new Error('Connection not initialized');

		const result = await this.provider.rawQuery(code);

		return result ? JSON.stringify(result) : undefined;
	}
}
