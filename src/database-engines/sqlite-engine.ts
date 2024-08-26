import { format } from 'sql-formatter';
import { QueryTypes, Sequelize } from 'sequelize';
import { Column, DatabaseEngine, ForeignKey, QueryResponse } from '../types';
import { SqlService } from '../services/sql';
import { reportError } from '../services/initialization-error-service';

export class SqliteEngine implements DatabaseEngine {

	public sequelize: Sequelize | null = null;

	constructor(sqliteFilePath?: string) {
		try {
			this.sequelize = new Sequelize({ dialect: 'sqlite', storage: sqliteFilePath, logging: false });
		} catch (error) {
			reportError(String(error));
		}
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

		const columns = await this.sequelize.query(`PRAGMA table_info(\`${table}\`)`, { type: QueryTypes.SELECT }) as any[];

		const computedColumns = []

		for (const column of columns) {
			const foreignKey = await getForeignKeyFor(table, column.name, this.sequelize as Sequelize)

			computedColumns.push({
				name: column.name,
				type: column.type,
				isPrimaryKey: column.pk === 1,
				isOptional: column.notnull === 0,
				foreignKey
			})
		}

		return computedColumns
	}

	async getTotalRows(table: string, whereClause?: Record<string, any>): Promise<number | undefined> {
		return SqlService.getTotalRows('sqlite', this.sequelize, table, whereClause);
	}

	async getRows(table: string, limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqlService.getRows('sqlite', this.sequelize, table, limit, offset, whereClause);
	}

	async convertToSqlInsertStatement(table: string, records: Record<string, any>[]): Promise<string | undefined> {
		if (!records.length) return undefined;

		const columns = Object.keys(records[0]);
		const values = records.map(record => 
			`(${columns.map(column => `'${record[column]}'`).join(', ')})`
		).join(',\n');

		const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${values};`;

		return format(sql, { language: 'sql' });
	}
}

async function getForeignKeyFor(table: string, column: string, sequelize: Sequelize): Promise<ForeignKey | undefined> {
	const query = `PRAGMA foreign_key_list(${table});`;

	const foreignKeys = await sequelize.query(query, {
		type: QueryTypes.RAW,
	});

	if (!foreignKeys || !foreignKeys.length) return;

	const foreignKey = foreignKeys[0] as any as { table: string, from: string, to: string };

	return {
		table: foreignKey.table,
		column: foreignKey.to,
	};
}
