import { Dialect, QueryTypes, Sequelize } from 'sequelize';
import { Column, DatabaseEngine, QueryResponse, SerializedMutation } from '../types';
import { SqlService } from '../services/sql';

export type MysqlConnectionDetails = { host: string, port: number, username: string, password: string, database: string }

export class MysqlEngine implements DatabaseEngine {

	public sequelize: Sequelize | null = null;

	constructor(sequelizeInstance: Sequelize) {
		this.sequelize = sequelizeInstance;
	}

	getType(): Dialect {
		return 'mysql';
	}

	getSequelizeInstance(): Sequelize | null {
		return this.sequelize
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

		/**
		 * Comes formatted, and any attempt to use format(...)
		 * from the sql-formatter package causes an issue whereby
		 * newline is added between "CHARACTER SET", which is still
		 * readable but largely odd.
		 */
		return sql
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
				isNumeric: this.getNumericColumnTypeNamesLowercase().includes(column.Type.toLowerCase()),
				isNullable: column.Null === 'YES',
				foreignKey
			})
		}

		return computedColumns
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'double'];
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number | undefined> {
		return SqlService.getTotalRows(this, 'mysql', this.sequelize, table, columns, whereClause);
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqlService.getRows(this, 'mysql', this.sequelize, table, columns, limit, offset, whereClause);
	}

	async getVersion(): Promise<string | undefined> {
		if (!this.sequelize) return undefined;

		const version = await this.sequelize.query('SELECT VERSION();', {
			type: QueryTypes.SELECT,
			logging: false
		});

		if (!version[0]) {
			return undefined
		}

		return (version[0] as any)['VERSION()'];
	}

	async commitChange(serializedMutation: SerializedMutation): Promise<void> {
		if (!this.sequelize) throw new Error('Sequelize instance not initialized');

		if (serializedMutation.type === 'cell-update') {
			const { table, column, newValue, primaryKey, primaryKeyColumn } = serializedMutation;
			await this.sequelize.query(
				`UPDATE \`${table}\` SET \`${column.name}\` = :newValue WHERE \`${primaryKeyColumn}\` = :primaryKey`,
				{
					replacements: { newValue, primaryKey },
					type: QueryTypes.UPDATE,
				}
			);
		}

		if (serializedMutation.type === 'row-delete') {
			const { table, primaryKey, primaryKeyColumn } = serializedMutation;
			await this.sequelize.query(
				`DELETE FROM \`${table}\` WHERE \`${primaryKeyColumn}\` = :primaryKey`,
				{
					replacements: { primaryKey },
					type: QueryTypes.DELETE,
				}
			);
		 }
	}

	async runArbitraryQueryAndGetOutput(code: string): Promise<any> {
		if (!this.sequelize) throw new Error('Sequelize instance not initialized');

		return (await this.sequelize.query(code, {
			type: QueryTypes.SELECT,
			logging: false,
		}));
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
