import { format } from 'sql-formatter';
import { QueryTypes, Sequelize } from 'sequelize';
import { Column, DatabaseEngine, QueryResponse } from '../types';
import { SqlService } from '../services/sql';

export type MssqlConnectionDetails = { host: string, port: number, username: string, password: string, database: string }

export class MssqlEngine implements DatabaseEngine {

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

		interface CreationSqlResult {
			'Create Table': string;
		}

		const creationSql = await this.sequelize.query<CreationSqlResult>(`exec sp_columns '${table}'`, {
			type: QueryTypes.SELECT,
			raw: true,
			logging: false
		});

		return JSON.stringify(creationSql, null, 2);

	}

	async getTables(): Promise<string[]> {
		if (!this.sequelize) return [];

		const tables = await this.sequelize.query(`
			SELECT TABLE_NAME
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_TYPE = 'BASE TABLE'
			AND TABLE_NAME NOT IN ('MSreplication_options', 'spt_fallback_db', 'spt_fallback_dev', 'spt_fallback_usg', 'spt_monitor');
		`, {
			type: QueryTypes.SELECT,
			raw: true,
			logging: false
		});

		return tables.map((table: any) => table['TABLE_NAME']).sort();
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.sequelize) return [];

		const columns = await this.sequelize.query(`SELECT COLUMN_NAME AS Field, DATA_TYPE AS Type, IS_NULLABLE AS [Null], COLUMNPROPERTY(object_id(TABLE_NAME), COLUMN_NAME, 'IsIdentity') AS [Key] FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${table}';`, {
			type: QueryTypes.SELECT,
			raw: true,
			logging: false
		}) as any[];

		const computedColumns = []

		for (const column of columns) {
			const foreignKey = await getForeignKeyFor(table, column.Field, this.sequelize as Sequelize)

			computedColumns.push({
				name: column.Field,
				type: column.Type,
				isPrimaryKey: column.Key === 1,
				isOptional: column.Null === 'YES',
				foreignKey
			})
		}

		return computedColumns
	}

	async getTotalRows(table: string, whereClause?: Record<string, any>): Promise<number | undefined> {
		if (!this.sequelize) return undefined;

		const where = whereClause ? `WHERE ${Object.keys(whereClause).map(key => `${key} = :${key}`).join(' AND ')}` : '';
		const replacements = whereClause ? whereClause : {};

		const result = await this.sequelize.query<{ count: number }>(`SELECT COUNT(*) as count FROM ${table} ${where}`, {
			type: QueryTypes.SELECT,
			raw: true,
			logging: false,
			replacements
		});

		return result[0]?.count;
	}

	async getRows(table: string, limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!this.sequelize) return undefined;

		const where = whereClause ? `WHERE ${Object.keys(whereClause).map(key => `${key} = :${key}`).join(' AND ')}` : '';
		const replacements = whereClause ? whereClause : {};

		const rows = await this.sequelize.query(`SELECT * FROM ${table} ${where} ORDER BY id OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`, {
			type: QueryTypes.SELECT,
			raw: true,
			logging: false,
			replacements
		});

		return { rows };
	}

	async convertToSqlInsertStatement(table: string, records: Record<string, any>[]): Promise<string | undefined> { }

}

async function getForeignKeyFor(table: string, column: string, sequelize: Sequelize): Promise<{ table: string, column: string } | undefined> {
	const foreignKeys = await sequelize.query(`
		SELECT
			OBJECT_NAME(f.referenced_object_id) AS [table],
			COL_NAME(fc.referenced_object_id, fc.referenced_column_id) AS [column]
		FROM
			sys.foreign_keys AS f
		INNER JOIN
			sys.foreign_key_columns AS fc
			ON f.OBJECT_ID = fc.constraint_object_id
		WHERE
			f.parent_object_id = OBJECT_ID(N'${table}')
			AND COL_NAME(fc.parent_object_id, fc.parent_column_id) = N'${column}'
	`, {
		type: QueryTypes.SELECT,
		raw: true,
		logging: false
	});

	if (foreignKeys.length === 0) return;

	return foreignKeys[0] as any as { table: string, column: string };
}
