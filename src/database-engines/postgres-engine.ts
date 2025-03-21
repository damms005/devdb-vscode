import knexlib from "knex";
import { Column, DatabaseEngine, KnexClient, QueryResponse, SerializedMutation } from '../types';
import { SqlService } from '../services/sql';

export class PostgresEngine implements DatabaseEngine {
	public connection: knexlib.Knex | null = null;

	constructor(connector: knexlib.Knex) {
		this.connection = connector;
	}

	getType(): KnexClient {
		return 'postgres';
	}

	getConnection(): knexlib.Knex | null {
		return this.connection
	}

	async isOkay(): Promise<boolean> {
		if (!this.connection) return false;

		try {
			await this.connection.raw('SELECT VERSION()');
			return true;
		} catch (error) {
			return false;
		}
	}

	async disconnect(): Promise<void> {
		if (this.connection) this.connection.destroy(() => null);
	}

	async getTableCreationSql(table: string): Promise<string> {
		if (!this.connection) {
			throw new Error('Not connected to the database');
		}

		const tableCreationSql = await this.connection.raw(`
        SELECT
            'CREATE TABLE ' || quote_ident(table_name) || ' (' ||
            string_agg(column_name || ' ' ||
                       CASE
                           WHEN data_type = 'character varying' THEN
                               'character varying(' || character_maximum_length || ')'
                           ELSE
                               data_type
                       END, ', ' ORDER BY ordinal_position) ||
            ');' AS create_sql
        FROM
            information_schema.columns
        WHERE
            table_name = '${table}'
        GROUP BY
            table_name
    `) as any;

		return tableCreationSql.rows[0]?.create_sql || '';
	}

	async getTables(): Promise<string[]> {
		if (!this.connection) {
			throw new Error('Not connected to the database');
		}

		const tables = await this.connection('pg_catalog.pg_tables')
			.whereNotIn('schemaname', ['pg_catalog', 'information_schema'])
			.select(`tablename`);

		return tables.map((table: any) => table.tablename);
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.connection) {
			throw new Error('Not connected to the database');
		}

		const columns = await this.connection('information_schema.columns')
			.whereRaw("LOWER(table_name) = LOWER(?)", [table])
			.select(['column_name AS name', 'data_type AS type', 'ordinal_position']) as any[];

		const computedColumns: Column[] = [];

		for (const column of columns) {
			const foreignKey = await getForeignKeyFor(table, column.name, this.connection);

			computedColumns.push({
				...{
					name: column.name,
					type: column.type,
					isPrimaryKey: false, // <- TODO: implement and update https://github.com/damms005/devdb-vscode/blob/5f0ead1b0e466c613af7d9d39a9d4ef4470e9ebf/README.md#L127
					isNumeric: this.getNumericColumnTypeNamesLowercase().includes(column.type.toLowerCase()),
					isNullable: false, // <- TODO: implement and update https://github.com/damms005/devdb-vscode/blob/5f0ead1b0e466c613af7d9d39a9d4ef4470e9ebf/README.md#L127
					foreignKey
				},
				// add a temporary property for sorting via type assertion
				ordinal_position: column.ordinal_position
			} as Column & { ordinal_position: number });
		}

		// Sort columns by their ordinal position in the table
		computedColumns.sort((a: any, b: any) => a.ordinal_position - b.ordinal_position);

		// Remove the temporary ordinal_position property
		for (const column of computedColumns) {
			delete (column as any).ordinal_position;
		}

		return computedColumns;
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision'];
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		return SqlService.getTotalRows(this, 'postgres', this.connection, table, columns, whereClause);
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqlService.getRows(this, 'postgres', this.connection, table, columns, limit, offset, whereClause);
	}

	async getVersion(): Promise<string | undefined> {
		return undefined
	}

	async commitChange(serializedMutation: SerializedMutation, transaction?: knexlib.Knex.Transaction): Promise<void> {
		await SqlService.commitChange(this.connection, serializedMutation, transaction, '"');
	}

	async rawQuery(code: string): Promise<string | undefined> {
		if (!this.connection) throw new Error('Connection not initialized');

		return (await this.connection.raw(code)).toString();
	}
}

async function getForeignKeyFor(table: string, column: string, connection: knexlib.Knex): Promise<{ table: string, column: string } | undefined> {

	type Fk = {
		referenced_table: string,
		referenced_column: string,
	}

	const result = await connection.raw(`
			SELECT
					ccu.table_name AS referenced_table,
				ccu.column_name AS referenced_column
			FROM
					information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu
					ON tc.constraint_name = kcu.constraint_name
			JOIN information_schema.constraint_column_usage ccu
					ON ccu.constraint_name = tc.constraint_name
			WHERE
					tc.constraint_type = 'FOREIGN KEY'
					AND kcu.table_name = LOWER('${table}')
					AND kcu.column_name = LOWER('${column}')
				`);

	const foreignKeys: Fk[] = result.rows;
	if (foreignKeys.length === 0) return undefined;

	return {
		table: foreignKeys[0].referenced_table as string,
		column: foreignKeys[0].referenced_column as string
	};
}
