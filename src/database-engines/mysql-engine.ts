import { Column, DatabaseEngine, KnexClient, QueryResponse, SerializedMutation } from '../types';
import { SqlService } from '../services/sql';
import knexlib from "knex";

export type MysqlConnectionDetails = { host: string, port: number, username: string, password: string, database: string }

export class MysqlEngine implements DatabaseEngine {

	public connection: knexlib.Knex | null = null;

	constructor(connector: knexlib.Knex) {
		this.connection = connector;
	}

	getType(): KnexClient {
		return 'mysql2';
	}

	getConnection(): knexlib.Knex | null {
		return this.connection
	}

	async isOkay(): Promise<boolean> {
		if (!this.connection) return false;

		await this.connection.raw('SELECT VERSION()');

		return true;
	}

	async disconnect() {
		if (this.connection) this.connection.destroy(() => null);
	}

	async getTableCreationSql(table: string): Promise<string> {
		if (!this.connection) return '';

		const creationSql = (await this.connection.raw(`SHOW CREATE TABLE ??`, [table]))[0];

		const sql = (creationSql[0] as any)['Create Table'];

		/**
		 * Comes formatted, and any attempt to use format(...)
		 * from the sql-formatter package causes an issue whereby
		 * newline is added between "CHARACTER SET", which is still
		 * readable but largely odd.
		 */
		return sql
	}

	async getTables(): Promise<string[]> {
		if (!this.connection) return [];

		const tables = ((await this.connection.raw('SHOW TABLES'))[0]).map((entry: Record<string, string>) => Object.values(entry)[0]);

		return tables;
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.connection) return [];

		type TableColumn = { "Type": string, "Field": string, "Key": string, Null: string }

		const columns: TableColumn[] = (await this.connection.raw(`SHOW COLUMNS FROM ??`, [table]) as any[])[0];

		const computedColumns: Column[] = []

		const editableColumnTypeNamesLowercase = this.getEditableColumnTypeNamesLowercase()

		for (const column of columns) {
			const foreignKey = await getForeignKeyFor(table, column.Field, this.connection)

			computedColumns.push({
				name: column.Field,
				type: column.Type,
				isPrimaryKey: column.Key === 'PRI',
				isNumeric: this.getNumericColumnTypeNamesLowercase().includes(column.Type.toLowerCase()),
				isPlainTextType: this.getPlainStringTypes().includes(column.Type.toLowerCase()),
				isNullable: column.Null === 'YES',
				isEditable: editableColumnTypeNamesLowercase.includes(column.Type.toLowerCase()) || editableColumnTypeNamesLowercase.some(edtiableColumn => column.Type.toLowerCase().startsWith(edtiableColumn)),
				foreignKey
			})
		}

		return computedColumns
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['tinyint', 'smallint', 'integer', 'mediumint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'double'];
	}

	getEditableColumnTypeNamesLowercase(): string[] {
		const numericTypes = this.getNumericColumnTypeNamesLowercase();
		const stringTypes = this.getPlainStringTypes();
		return [...numericTypes, ...stringTypes];
	}

	getPlainStringTypes(): string[] {
		return ['char', 'varchar', 'text', 'tinytext', 'mediumtext', 'longtext', 'json'];
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		return SqlService.getTotalRows(this, 'mysql2', this.connection, table, columns, whereClause);
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqlService.getRows(this, 'mysql2', this.connection, table, columns, limit, offset, whereClause);
	}

	async getVersion(): Promise<string | undefined> {
		if (!this.connection) return undefined;

		const version = (await this.connection.raw('SELECT VERSION();'))[0];

		if (!version[0]) {
			return undefined
		}

		return (version[0] as any)['VERSION()'];
	}

	async commitChange(serializedMutation: SerializedMutation, transaction: knexlib.Knex.Transaction): Promise<void> {
		await SqlService.commitChange(this.connection, serializedMutation, transaction);
	}

	async rawQuery(code: string): Promise<any> {
		if (!this.connection) throw new Error('Connection not initialized');

		return (await this.connection.raw(code))[0];
	}
}

async function getForeignKeyFor(table: string, column: string, connection: knexlib.Knex): Promise<{ table: string, column: string } | undefined> {

	const foreignKeys = (await (connection).raw(`
		SELECT
			REFERENCED_TABLE_NAME AS \`table\`,
			REFERENCED_COLUMN_NAME AS \`column\`
		FROM
			INFORMATION_SCHEMA.KEY_COLUMN_USAGE
		WHERE
			TABLE_NAME = ?
			AND COLUMN_NAME = ?
			AND REFERENCED_TABLE_NAME IS NOT NULL
	`, [table, column]))[0];

	if (foreignKeys.length === 0) return;

	return foreignKeys[0] as any as { table: string, column: string };
}
