import { Sequelize, QueryTypes } from 'sequelize';

export class PostgresEngine {
	private sequelize: Sequelize | null = null;

	constructor(private connectionString: string) { }

	async connect(): Promise<void> {
		this.sequelize = new Sequelize(this.connectionString);
		await this.sequelize.authenticate();
	}

	async disconnect(): Promise<void> {
		if (this.sequelize) await this.sequelize.close();
	}

	async getRows(table: string, limit: number, offset: number, whereClause?: Record<string, any>): Promise<any[] | undefined> {
		if (!this.sequelize) {
			throw new Error('Not connected to the database');
		}

		let where = '';
		if (whereClause) {
			where = ' WHERE ' + Object.entries(whereClause).map(([key, value]) => `${key} = ${value}`).join(' AND ');
		}

		const rows = await this.sequelize.query(`SELECT * FROM ${table}${where} LIMIT ${limit} OFFSET ${offset}`, { type: QueryTypes.SELECT });

		return rows;
	}

	async getForeignKeyFor(table: string, column: string): Promise<{ table: string, column: string } | undefined> {
		if (!this.sequelize) {
			throw new Error('Not connected to the database');
		}

		const foreignKeys = await this.sequelize.query(`
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
}