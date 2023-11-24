import { format } from 'sql-formatter';
import { QueryTypes, Sequelize } from 'sequelize';
import { Column, DatabaseEngine, QueryResponse } from '../types';
import { PaginationData } from '../services/pagination';
import { SqliteService } from '../services/sql';

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
		});

		return columns.map((column: any) => ({
			name: column.Field,
			type: column.Type,
			isPrimaryKey: column.Key === 'PRI',
			isOptional: column.Null === 'YES',
		}));
	}

	async getTotalRows(table: string, whereClause?: Record<string, any>): Promise<number | null> {
		return SqliteService.getTotalRows(this.sequelize, table, whereClause);
	}

	async getRows(table: string, limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqliteService.getRows(this.sequelize, table, limit, offset, whereClause);
	}
}