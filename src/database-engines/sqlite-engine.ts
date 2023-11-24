import { format } from 'sql-formatter';
import { QueryTypes, Sequelize } from 'sequelize';
import { Column, DatabaseEngine, QueryResponse } from '../types';
import { PaginationData } from '../services/pagination';
import { SqliteService } from '../services/sql';

export class SqliteEngine implements DatabaseEngine {

	public sequelize: Sequelize | null = null;

	constructor(sqliteFilePath: string) {
		this.sequelize = new Sequelize({ dialect: 'sqlite', storage: sqliteFilePath });
	}

	async isOkay(): Promise<boolean> {
		if (!this.sequelize) return false;

		const result: { integrity_check: 'ok' | string }[] = await this.sequelize.query('PRAGMA integrity_check;', { type: QueryTypes.SELECT });
		return result[0]['integrity_check'] === 'ok';
	}

	async disconnect() {
		if (this.sequelize) await this.sequelize.close();
	}

	async getTableCreationSql(table: string): Promise<string> {
		if (!this.sequelize) return '';

		const creationSql = await this.sequelize.query(`SELECT sql FROM sqlite_master WHERE name = '${table}'`, {
			type: QueryTypes.SELECT,
			raw: true,
			logging: false
		});

		const sql = (creationSql[0] as any).sql;

		return format(sql, { language: 'sql' })
	}

	async getTables(): Promise<string[]> {
		if (!this.sequelize) return [];

		const tables = await this.sequelize.query("SELECT name FROM sqlite_master WHERE type='table'", {
			type: QueryTypes.SELECT,
			logging: false
		});

		return tables.map((table: any) => table.name).sort();
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.sequelize) return [];

		const columns = await this.sequelize.query(`PRAGMA table_info(\`${table}\`)`, { type: QueryTypes.SELECT });

		return columns.map((column: any) => ({
			name: column.name,
			type: column.type,
			isPrimaryKey: column.pk === 1,
			isOptional: column.notnull === 0,
		}));
	}

	async getTotalRows(table: string, whereClause?: Record<string, any>): Promise<number | null> {
		return SqliteService.getTotalRows(this.sequelize, table, whereClause);
	}

	async getRows(table: string, limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqliteService.getRows(this.sequelize, table, limit, offset, whereClause);
	}
}