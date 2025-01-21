import { format } from 'sql-formatter';
import { Dialect, QueryTypes, Sequelize, Transaction } from 'sequelize';
import { Column, DatabaseEngine, ForeignKey, QueryResponse, SerializedMutation } from '../types';
import { SqlService } from '../services/sql';
import { reportError } from '../services/initialization-error-service';
import { stat } from 'fs/promises';

export class SqliteEngine implements DatabaseEngine {

	public sequelize: Sequelize | null = null;

	constructor(sqliteFilePath?: string) {
		try {
			this.sequelize = new Sequelize({ dialect: 'sqlite', storage: sqliteFilePath, logging: false });
		} catch (error) {
			reportError(String(error));
		}
	}

	getType(): Dialect {
		return 'sqlite';
	}

	getSequelizeInstance(): Sequelize | null {
		return this.sequelize
	}

	async isOkay(): Promise<boolean> {
		if (!this.sequelize) return false;

		const file = (this.sequelize as any).options.storage;
		const stats = await stat(file);
		const fileSizeGB = Math.round((stats.size / (1024 * 1024 * 1024) + Number.EPSILON) * 100) / 100; // Convert to GB and round to 2 decimal places
		const size = 5

		if (fileSizeGB > size) {
			reportError(`Warning: SQLite database file size too big for database integrity check: ${fileSizeGB}GB. Maximum size is ${size}GB. Hence, database integrity not checked. File: ${file}`)

			return true
		}

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

		const computedColumns: Column[] = []

		for (const column of columns) {
			const foreignKey = await getForeignKeyFor(table, column.name, this.sequelize as Sequelize)

			computedColumns.push({
				name: column.name,
				type: column.type,
				isPrimaryKey: column.pk === 1,
				isNumeric: this.getNumericColumnTypeNamesLowercase().includes(column.type.toLowerCase()),
				isNullable: column.notnull === 0,
				foreignKey
			})
		}

		return computedColumns
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['integer', 'real', 'numeric'];
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number | undefined> {
		return SqlService.getTotalRows(this, 'sqlite', this.sequelize, table, columns, whereClause);
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqlService.getRows(this, 'sqlite', this.sequelize, table, columns, limit, offset, whereClause);
	}

	async getVersion(): Promise<string | undefined> {
		return undefined
	}

	async commitChange(serializedMutation: SerializedMutation, transaction?: Transaction): Promise<void> {
		await SqlService.commitChange(this.sequelize, serializedMutation, transaction);
	}

	async runArbitraryQueryAndGetOutput(code: string): Promise<string | undefined> {
		if (!this.sequelize) throw new Error('Sequelize instance not initialized');

		return (await this.sequelize.query(code, { type: QueryTypes.SELECT, logging: false })).toString();
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
