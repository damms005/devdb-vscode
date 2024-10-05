import { Dialect, QueryTypes, Sequelize } from "sequelize";
import { Column, QueryResponse } from "../types";
import { reportError } from "./initialization-error-service";

export const SqlService = {

	buildWhereClause(columns: Column[], delimiter: string, whereClause?: Record<string, any>): { where: string[], replacements: string[] } {
		if (!whereClause) return {
			where: [],
			replacements: []
		}

		return buildWhereClause(whereClause, columns, delimiter);
	},

	async getRows(dialect: Dialect, sequelize: Sequelize | null, table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!sequelize) return;

		let delimiter = '`'
		if (dialect === 'postgres') {
			delimiter = '"';
		}

		const { where, replacements } = this.buildWhereClause(columns, delimiter, whereClause);

		let limitConstraint = limit ? `LIMIT ${limit}` : '';
		limitConstraint += offset ? ` OFFSET ${offset}` : '';

		const whereString = where.length ? `WHERE ${where.join(' AND ')}` : '';
		let sql;
		let rows

		console.log({ where, replacements })
		console.log(`SELECT * FROM ${delimiter}${table}${delimiter} ${whereString} ${limitConstraint}`)


		try {
			rows = await sequelize.query(
				`SELECT * FROM ${delimiter}${table}${delimiter} ${whereString} ${limitConstraint}`, {
				type: QueryTypes.SELECT,
				raw: true,
				replacements,
				logging: query => { sql = query }
			});
		} catch (error) {
			reportError(String(error));
			return
		}

		return { rows, sql };
	},

	async getTotalRows(dialect: Dialect, sequelize: Sequelize | null, table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number | undefined> {
		if (!sequelize) return;

		let delimiter = '`'
		if (dialect === 'postgres') {
			delimiter = '"';
		}

		const { where, replacements } = this.buildWhereClause(columns, delimiter, whereClause);
		const whereString = where.length ? `WHERE ${where.join(' AND ')}` : '';
		let count;

		try {
			count = await sequelize.query(`SELECT COUNT(*) FROM ${delimiter}${table}${delimiter} ${whereString}`, {
				type: QueryTypes.SELECT,
				raw: true,
				replacements,
				logging: false
			});
		} catch (error) {
			reportError(String(error))
			return
		}

		let totalRows = (count[0] as { 'COUNT(*)': string })['COUNT(*)'];

		if (dialect === 'postgres') {
			totalRows = (count[0] as { count: string })['count'];
		}

		return totalRows
			? Number(totalRows)
			: 0
	},
}

function buildWhereClause(whereClause: Record<string, any>, columns: Column[], delimiter: string) {
	const where: string[] = [];
	const replacements: string[] = [];

	Object.entries(whereClause)
		.forEach(([column, value]) => {

			const targetColumn = columns.find((c: Column) => c.name === column);

			if (!targetColumn) {
				throw new Error(`Invalid column name: ${column}`)
			}

			const noop = targetColumn.type === 'boolean' && value === '';

			if (noop) {
				return
			}

			const operator = targetColumn.type === 'boolean'
				? ' is '
				: ' LIKE '

			if (targetColumn.type === 'boolean') {
				if (typeof value === 'number') {
					value = Boolean(value)
				} else if (!String(value).trim()) {
					value = Boolean(false)
				} else if (String(value).trim().toLowerCase() === 'false') {
					value = false
				} else if (!isNaN(value)) {
					value = Boolean(Number(value))
				} else {
					value = Boolean(value)
				}
			}

			where.push(`${delimiter}${column}${delimiter} ${operator} ?`)
			replacements.push(value);
		})

	return { where, replacements }
}