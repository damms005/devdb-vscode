import knexlib from "knex";
import { Column, DatabaseEngine, KnexClient, QueryResponse, SerializedMutation } from '../types';
import { SqlService } from '../services/sql';
import { reportError } from "../services/initialization-error-service";

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
			reportError(`PostgreSQL OK-check error: ${error}`);
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

		const { schemaName, tableName } = getTableSchema(table);

		const tableCreationSql = await this.connection.raw(`
        SELECT
            'CREATE TABLE ' || quote_ident(table_schema) || '.' || quote_ident(table_name) || ' (' ||
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
            table_name = '${tableName}' AND table_schema = '${schemaName}'
        GROUP BY
            table_name, table_schema
    `) as any;

		const sql = tableCreationSql.rows[0]?.create_sql || '';

		try {
			const { format } = await import('sql-formatter')

			const formattedSql = format(sql, {
				language: 'sqlite',
				tabWidth: 2,
				keywordCase: 'upper',
			});

			return formattedSql
		} catch (formatErr) {
			reportError(`PostgreSQL formatting error: ${formatErr}`);

			return sql
		}
	}

	async getTables(): Promise<string[]> {
		if (!this.connection) {
			throw new Error('Not connected to the database');
		}

		const tables = await this.connection('pg_catalog.pg_tables')
			.whereNotIn('schemaname', ['pg_catalog', 'information_schema'])
			.select([`tablename`, `schemaname`]);

		return tables.map(getTableName);
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.connection) {
			throw new Error('Not connected to the database');
		}

		const { schemaName, tableName } = getTableSchema(table);

		type TableColumn = { "type": string, name: string, ordinal_position: number, is_nullable: string }

		const columns: TableColumn[] = await this.connection('information_schema.columns')
			.whereRaw("LOWER(table_name) = LOWER(?)", [tableName])
			.whereRaw("LOWER(table_schema) = LOWER(?)", [schemaName])
			.select(['column_name AS name', 'data_type AS type', 'ordinal_position', 'is_nullable']) as any[];

		const editableColumnTypeNamesLowercase = this.getEditableColumnTypeNamesLowercase()

		const primaryKeyResult = await this.connection('information_schema.table_constraints as tc')
			.join('information_schema.key_column_usage as kcu', 'tc.constraint_name', 'kcu.constraint_name')
			.where('tc.constraint_type', 'PRIMARY KEY')
			.andWhereRaw('LOWER(tc.table_name) = LOWER(?)', [tableName])
			.andWhereRaw('LOWER(tc.table_schema) = LOWER(?)', [schemaName])
			.select('kcu.column_name');
		const primaryKeySet = new Set(primaryKeyResult.map(row => row.column_name.toLowerCase()));

		const computedColumns: Column[] = [];

		for (const column of columns) {
			const foreignKey = await getForeignKeyFor(table, column.name, this.connection);

			computedColumns.push({
				...{
					name: column.name,
					type: column.type,
					isPrimaryKey: primaryKeySet.has(column.name.toLowerCase()),
					isNumeric: this.getNumericColumnTypeNamesLowercase().includes(column.type.toLowerCase()),
					isPlainTextType: this.getPlainStringTypes().includes(column.type.toLowerCase()),
					isNullable: column.is_nullable === 'YES',
					isEditable: editableColumnTypeNamesLowercase.includes(column.type.toLowerCase()) || editableColumnTypeNamesLowercase.some(edtiableColumn => column.type.toLowerCase().startsWith(edtiableColumn)),
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

	getEditableColumnTypeNamesLowercase(): string[] {
		const numericTypes = this.getNumericColumnTypeNamesLowercase();
		const stringTypes = this.getPlainStringTypes();
		return [...numericTypes, ...stringTypes];
	}

	getPlainStringTypes(): string[] {
		return ['character', 'character varying', 'text', 'json', 'jsonb'];
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

	async commitChange(serializedMutation: SerializedMutation, transaction: knexlib.Knex.Transaction): Promise<void> {
		await SqlService.commitChange(this.connection, serializedMutation, transaction, '"');
	}

	async rawQuery(code: string): Promise<string | undefined> {
		if (!this.connection) throw new Error('Connection not initialized');

		return (await this.connection.raw(code)).toString();
	}
}

function getTableName(table: { schemaname: string, tablename: string }) {
	return table.schemaname === 'public' 
			? table.tablename 
			: `${table.schemaname}.${table.tablename}`;
}

function getTableSchema(table: string): { schemaName: string, tableName: string } {
	let schemaName = 'public';
	let tableName = table;

	if (tableName.includes('.')) {
		const parts = tableName.split('.');
		schemaName = parts[0];
		tableName = parts[1];
	}

	return { schemaName, tableName };
}

async function getForeignKeyFor(table: string, column: string, connection: knexlib.Knex): Promise<{ table: string, column: string } | undefined> {
	const { schemaName, tableName } = getTableSchema(table);

	type Fk = {
		referenced_table: string,
		referenced_column: string,
		referenced_schema: string,
	}

	const result = await connection.raw(`
			SELECT
					ccu.table_name AS referenced_table,
					ccu.column_name AS referenced_column,
					ccu.table_schema AS referenced_schema
			FROM
					information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu
					ON tc.constraint_name = kcu.constraint_name
					AND tc.table_schema = kcu.table_schema
			JOIN information_schema.constraint_column_usage ccu
					ON ccu.constraint_name = tc.constraint_name
			WHERE
					tc.constraint_type = 'FOREIGN KEY'
					AND kcu.table_name = LOWER('${tableName}')
					AND kcu.table_schema = LOWER('${schemaName}')
					AND kcu.column_name = LOWER('${column}')
				`);

	const foreignKeys: Fk[] = result.rows;
	if (foreignKeys.length === 0) return undefined;

	return {
		table: getTableName({ schemaname: foreignKeys[0].referenced_schema, tablename: foreignKeys[0].referenced_table }),
		column: foreignKeys[0].referenced_column as string
	};
}
