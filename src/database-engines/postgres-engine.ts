import { Sequelize, QueryTypes } from 'sequelize';
import { Column, DatabaseEngine, QueryResponse } from '../types';
import { SqlService } from '../services/sql';
import { format } from 'sql-formatter';

export class PostgresEngine implements DatabaseEngine {
	public sequelize: Sequelize | null = null;

	constructor(sequelizeInstance: Sequelize) {
		this.sequelize = sequelizeInstance;
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
            pg_get_viewdef(pg_class.oid) AS create_sql
        FROM
            pg_class
        JOIN
            pg_namespace ON pg_namespace.oid = pg_class.relnamespace
        WHERE
            pg_class.relkind = 'r' AND
            pg_namespace.nspname = 'public' AND
            pg_class.relname = '${table}'
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
						table_name = '${table}'
		`, { type: QueryTypes.SELECT }) as any[];

		const computedColumns = []

		for (const column of columns) {

			const foreignKey = await getForeignKeyFor(table, column.Field, this.sequelize as Sequelize)

			computedColumns.push({
				name: column.name,
				type: column.type,
				isPrimaryKey: false, // <- TODO: implement and update https://github.com/damms005/devdb-vscode/blob/5f0ead1b0e466c613af7d9d39a9d4ef4470e9ebf/README.md#L127
				isOptional: false, // <- TODO: implement and update https://github.com/damms005/devdb-vscode/blob/5f0ead1b0e466c613af7d9d39a9d4ef4470e9ebf/README.md#L127
				foreignKey
			})
		}

		return computedColumns
	}

	async getTotalRows(table: string, whereClause?: Record<string, any>): Promise<number | undefined> {
		return SqlService.getTotalRows('postgres', this.sequelize, table, whereClause);
	}

	async getRows(table: string, limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqlService.getRows('postgres',this.sequelize, table, limit, offset, whereClause);
	}
}

async function getForeignKeyFor(table: string, column: string, sequelize: Sequelize): Promise<{ table: string, column: string } | undefined> {
	const foreignKeys = await sequelize.query(`
            SELECT
                conrelid::regclass AS table,
                a.attname AS column
            FROM
                pg_attribute a
            JOIN
                pg_constraint c ON a.attnum = ANY(c.conkey)
            WHERE
                confrelid = '${table}'::regclass AND a.attname = '${column}'
        `, { type: QueryTypes.SELECT });

	if (foreignKeys.length === 0) return;

	return foreignKeys[0] as any as { table: string, column: string };
}
