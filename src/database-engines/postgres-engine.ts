import { Sequelize, QueryTypes, Dialect } from 'sequelize';
import { Column, DatabaseEngine, QueryResponse } from '../types';
import { SqlService } from '../services/sql';

export class PostgresEngine implements DatabaseEngine {
	public sequelize: Sequelize | null = null;

	constructor(sequelizeInstance: Sequelize) {
		this.sequelize = sequelizeInstance;
	}

	getType(): Dialect {
		return 'postgres';
	}

	async isOkay(): Promise<boolean> {
		if (!this.sequelize) return false;

		try {
			await this.sequelize.authenticate();
			return true;
		} catch (error) {
			return false;
		}
	}

	async disconnect(): Promise<void> {
		if (this.sequelize) await this.sequelize.close();
	}

	async getTableCreationSql(table: string): Promise<string> {
		if (!this.sequelize) {
			throw new Error('Not connected to the database');
		}

		const tableCreationSql = await this.sequelize.query(`
        SELECT
            'CREATE TABLE ' || quote_ident(table_name) || ' (' ||
            string_agg(column_name || ' ' ||
                       CASE
                           WHEN data_type = 'character varying' THEN
                               'character varying(' || character_maximum_length || ')'
                           ELSE
                               data_type
                       END, ', ') ||
            ');' AS create_sql
        FROM
            information_schema.columns
        WHERE
            table_name = '${table}'
        GROUP BY
            table_name
    `, { type: QueryTypes.SELECT }) as any[];

		return tableCreationSql[0]?.create_sql || '';
	}

	async getTables(): Promise<string[]> {
		if (!this.sequelize) {
			throw new Error('Not connected to the database');
		}

		const tables = await this.sequelize.query(`
        SELECT
            tablename
        FROM
            pg_catalog.pg_tables
        WHERE
            schemaname != 'pg_catalog' AND
            schemaname != 'information_schema'
    `, { type: QueryTypes.SELECT });

		return tables.map((table: any) => table.tablename);
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.sequelize) {
			throw new Error('Not connected to the database');
		}

		const columns = await this.sequelize.query(`
			SELECT
				column_name AS name,
				data_type AS type
			FROM
				information_schema.columns
			WHERE
				LOWER(table_name) = LOWER('${table}')
		`, { type: QueryTypes.SELECT }) as any[];

		const computedColumns:Column[] = [];

		for (const column of columns) {
			const foreignKey = await getForeignKeyFor(table, column.name, this.sequelize as Sequelize);

			computedColumns.push({
				name: column.name,
				type: column.type,
				isPrimaryKey: false, // <- TODO: implement and update https://github.com/damms005/devdb-vscode/blob/5f0ead1b0e466c613af7d9d39a9d4ef4470e9ebf/README.md#L127
				isNumeric: this.getNumericColumnTypeNamesLowercase().includes(column.Type.toLowerCase()),
				isOptional: false, // <- TODO: implement and update https://github.com/damms005/devdb-vscode/blob/5f0ead1b0e466c613af7d9d39a9d4ef4470e9ebf/README.md#L127
				foreignKey
			});
		}

		return computedColumns;
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision'];
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number | undefined> {
		return SqlService.getTotalRows(this, 'postgres', this.sequelize, table, columns, whereClause);
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqlService.getRows(this, 'postgres', this.sequelize, table, columns, limit, offset, whereClause);
	}

	async getVersion(): Promise<string | undefined> {
		return undefined
	}

	async runArbitraryQueryAndGetOutput(code: string): Promise<string|undefined> {
		if (!this.sequelize) throw new Error('Sequelize instance not initialized');

		return (await this.sequelize.query(code, { type: QueryTypes.SELECT, logging: false })).toString();
	}
}

async function getForeignKeyFor(table: string, column: string, sequelize: Sequelize): Promise<{ table: string, column: string } | undefined> {

	type Fk = {
		referenced_table: string,
		referenced_column: string,
	}

	const foreignKeys: Fk[] = await sequelize.query(`
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
	`, { type: QueryTypes.SELECT });

	if (foreignKeys.length === 0) return undefined;

	return {
		table: foreignKeys[0].referenced_table as string,
		column: foreignKeys[0].referenced_column as string
	};
}
