import { format } from 'sql-formatter';
import { QueryTypes, Sequelize } from 'sequelize';
import { Column, DatabaseEngine, QueryResponse } from '../types';
import { SqlService } from '../services/sql';

export type MysqlConnectionDetails = { host: string, port: number, username: string, password: string, database: string }

export class MysqlEngine implements DatabaseEngine {

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

	async disconnect() {
		if (this.sequelize) await this.sequelize.close();
	}

	async getTableCreationSql(table: string): Promise<string> {
		if (!this.sequelize) return '';

		const creationSql = await this.sequelize.query(`SHOW CREATE TABLE \`${table}\`;`, {
			type: QueryTypes.SELECT,
			raw: true,
			logging: false
		});

		const sql = (creationSql[0] as any)['Create Table'];

		return format(sql, { language: 'sql' })

	}

	async getTables(): Promise<string[]> {
		if (!this.sequelize) return [];

		const tables = await this.sequelize.query('SHOW TABLES;', {
			type: QueryTypes.SELECT,
			raw: true,
			logging: false
		});

		return tables.map((table: any) => table[`Tables_in_${this.sequelize?.getDatabaseName()}`]).sort();
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.sequelize) return [];

		const columns = await this.sequelize.query(`SHOW COLUMNS FROM \`${table}\`;`, {
			type: QueryTypes.SELECT,
			raw: true,
			logging: false
		}) as any[];

		const computedColumns: Column[] = []

		for (const column of columns) {
			const foreignKey = await getForeignKeyFor(table, column.Field, this.sequelize as Sequelize)

			computedColumns.push({
				name: column.Field,
				type: column.Type,
				isPrimaryKey: column.Key === 'PRI',
				isOptional: column.Null === 'YES',
				foreignKey
			})
		}

		return computedColumns
	}

	async getTotalRows(table: string, whereClause?: Record<string, any>): Promise<number | undefined> {
		return SqlService.getTotalRows('mysql', this.sequelize, table, whereClause);
	}

	async getRows(table: string, limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqlService.getRows('mysql', this.sequelize, table, limit, offset, whereClause);
	}
}

async function getForeignKeyFor(table: string, column: string, sequelize: Sequelize): Promise<{ table: string, column: string } | undefined> {
	const foreignKeys = await sequelize.query(`
		SELECT
			REFERENCED_TABLE_NAME AS \`table\`,
			REFERENCED_COLUMN_NAME AS \`column\`
		FROM
			INFORMATION_SCHEMA.KEY_COLUMN_USAGE
		WHERE
			TABLE_NAME = '${table}'
			AND COLUMN_NAME = '${column}'
			AND REFERENCED_TABLE_NAME IS NOT NULL
	`, {
		type: QueryTypes.SELECT,
		raw: true,
		logging: false
	});

	if (foreignKeys.length === 0) return;

	return foreignKeys[0] as any as { table: string, column: string };
}
