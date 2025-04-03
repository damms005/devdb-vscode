import knexlib from "knex";
import { Column, DatabaseEngine, KnexClient, QueryResponse, SerializedMutation } from '../types';
import { SqlService } from '../services/sql';

export type MssqlConnectionDetails = { host: string, port: number, username: string, password: string, database: string }

export class MssqlEngine implements DatabaseEngine {

	public connection: knexlib.Knex | null = null;

	constructor(connector: knexlib.Knex) {
		this.connection = connector;
	}

	getType(): KnexClient {
		return 'mssql';
	}

	getConnection(): knexlib.Knex | null {
		return this.connection
	}

	async isOkay(): Promise<boolean> {
		if (!this.connection) return false;


		try {
			await this.connection.raw('SELECT @@VERSION');
			return true;
		} catch (error) {
			return false;
		}
	}

	async disconnect() {
		if (this.connection) this.connection.destroy(() => null);
	}

	async getTableCreationSql(table: string): Promise<string> {
		if (!this.connection) return '';

		interface CreationSqlResult {
			'Create Table': string;
		}

		const creationSql = (await this.connection.raw<CreationSqlResult>(`exec sp_columns '${table}'`));

		return JSON.stringify(creationSql, null, 2);

	}

	async getTables(): Promise<string[]> {
		if (!this.connection) return [];

		const tables = await this.connection.raw(`
			SELECT TABLE_NAME
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_TYPE = 'BASE TABLE'
			AND TABLE_NAME NOT IN ('MSreplication_options', 'spt_fallback_db', 'spt_fallback_dev', 'spt_fallback_usg', 'spt_monitor');
		`);

		return tables.map((table: any) => table['TABLE_NAME']).sort();
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.connection) return [];

		type TableColumn = { "Field": string, "Type": string, "Null": "NO" | "YES", "Key": number }

		const editableColumnTypeNamesLowercase = this.getEditableColumnTypeNamesLowercase()

		const columns: TableColumn[] = await this.connection.raw(`SELECT COLUMN_NAME AS Field, DATA_TYPE AS Type, IS_NULLABLE AS [Null], COLUMNPROPERTY(object_id(TABLE_NAME), COLUMN_NAME, 'IsIdentity') AS [Key] FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${table}';`) as any[];

		const computedColumns: Column[] = []

		for (const column of columns) {
			const foreignKey = await getForeignKeyFor(table, column.Field, this.connection)

			computedColumns.push({
				name: column.Field,
				type: column.Type,
				isPrimaryKey: column.Key === 1,
				isNumeric: this.getNumericColumnTypeNamesLowercase().includes(column.Type.toLowerCase()),
				isPlainTextType: this.getPlainStringTypes().includes(column.Type.toLowerCase()),
				isEditable: editableColumnTypeNamesLowercase.includes(column.Type.toLowerCase()) || editableColumnTypeNamesLowercase.some(edtiableColumn => column.Type.toLowerCase().startsWith(edtiableColumn)),
				isNullable: column.Null === 'YES',
				foreignKey
			})
		}

		return computedColumns
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'real'];
	}

	getEditableColumnTypeNamesLowercase(): string[] {
		const numericTypes = this.getNumericColumnTypeNamesLowercase();
		const stringTypes = this.getPlainStringTypes();
		return [...numericTypes, ...stringTypes];
	}

	getPlainStringTypes(): string[] {
		return ['char', 'varchar', 'text', 'nchar', 'nvarchar', 'ntext'];
	}

	async getTotalRows(table: string, whereClause?: Record<string, any>): Promise<number> {
		if (!this.connection) return 0;

		const result = await this.connection(table).where(whereClause ?? {}).count('* as count');

		return (result[0])?.count as number;
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!this.connection) return undefined;

		const where = whereClause ? `WHERE ${Object.keys(whereClause).map(key => `?? = ?`).join(' AND ')}` : '';

		const sql = `SELECT * FROM ?? ${where} ORDER BY id OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`

		const replacements = whereClause
			? [table, ...Object.keys(whereClause).flatMap(key => [key, whereClause[key]])]
			: [table];

		const rows = await this.connection.raw(sql, replacements)

		return { rows };
	}

	async getVersion(): Promise<string | undefined> {
		return undefined
	}

	async commitChange(serializedMutation: SerializedMutation, transaction: knexlib.Knex.Transaction): Promise<void> {
		await SqlService.commitChange(this.connection, serializedMutation, transaction, '[');
	}

	async rawQuery(code: string): Promise<string | undefined> {
		if (!this.connection) throw new Error('Connection not initialized');

		return (await this.connection.raw(code)).toString();
	}
}

async function getForeignKeyFor(table: string, column: string, connection: knexlib.Knex): Promise<{ table: string, column: string } | undefined> {
	const foreignKeys = await connection.raw(`
		SELECT
			OBJECT_NAME(f.referenced_object_id) AS [table],
			COL_NAME(fc.referenced_object_id, fc.referenced_column_id) AS [column]
		FROM
			sys.foreign_keys AS f
		INNER JOIN
			sys.foreign_key_columns AS fc
			ON f.OBJECT_ID = fc.constraint_object_id
		WHERE
			f.parent_object_id = OBJECT_ID(N'${table}')
			AND COL_NAME(fc.parent_object_id, fc.parent_column_id) = N'${column}'
	`);

	if (foreignKeys.length === 0) return;

	return foreignKeys[0] as any as { table: string, column: string };
}
