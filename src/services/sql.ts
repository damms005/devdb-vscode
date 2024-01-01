import { QueryTypes, Sequelize } from "sequelize";
import { QueryResponse } from "../types";

export const SqliteService = {

	buildWhereClause(whereClause?: Record<string, any>): { where: string[], replacements: string[] } {
		if (!whereClause) return {
			where: [],
			replacements: []
		}

		const where: string[] = [];
		const replacements: string[] = [];

		Object.entries(whereClause)
			.forEach(([column, value]) => {
				where.push(`${column} LIKE ?`)
				replacements.push(`%${value}%`);
			})

		return { where, replacements }
	},

	async getRows(sequelize: Sequelize | null, table: string, limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!sequelize) return;

		const { where, replacements } = this.buildWhereClause(whereClause);
		const limitConstraint = `LIMIT ${offset || 0}, ${limit || 0}`;
		const whereString = where.length ? `WHERE ${where.join(' AND ')}` : '';
		let sql;
		const rows = await sequelize.query(
			`SELECT * FROM \`${table}\` ${whereString} ${limitConstraint}`, {
			type: QueryTypes.SELECT,
			raw: true,
			replacements,
			logging: query => { sql = query }
		});

		return { rows, sql };
	},

	async getTotalRows(sequelize: Sequelize | null, table: string, whereClause?: Record<string, any>): Promise<number | null> {
		if (!sequelize) return null;

		const { where, replacements } = this.buildWhereClause(whereClause);
		const whereString = where.length ? `WHERE ${where.join(' AND ')}` : '';
		const count = await sequelize.query(`SELECT COUNT(*) FROM \`${table}\` ${whereString}`, {
			type: QueryTypes.SELECT,
			raw: true,
			replacements,
			logging: false
		});

		const totalRows = (count[0] as any)['COUNT(*)'];

		return totalRows
	},
}