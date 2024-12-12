import { Dialect, QueryTypes, Sequelize } from "sequelize";
import { Column, QueryResponse } from "../types";
import { reportError } from "./initialization-error-service";

export const SqlService = {

	buildWhereClause(dialect: Dialect, columns: Column[], delimiter: string, whereClause?: Record<string, any>): { where: string[], replacements: string[] } {
		if (!whereClause) return {
			where: [],
			replacements: []
		}

		return buildWhereClause(dialect, whereClause, columns, delimiter);
	},

	async getRows(dialect: Dialect, sequelize: Sequelize | null, table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!sequelize) return;

		let delimiter = '`'
		if (dialect === 'postgres') {
			delimiter = '"';
		}

		const { where, replacements } = this.buildWhereClause(dialect, columns, delimiter, whereClause);

		let limitConstraint = limit ? `LIMIT ${limit}` : '';
		limitConstraint += offset ? ` OFFSET ${offset}` : '';

		const whereString = where.length ? `WHERE ${where.join(' AND ')}` : '';
		let loggedSql = '';
		let rows

		const sql = `SELECT * FROM ${delimiter}${table}${delimiter} ${whereString} ${limitConstraint}`

		try {
			rows = await sequelize.query(sql, {
				type: QueryTypes.SELECT,
				raw: true,
				replacements,
				logging: query => loggedSql = `${loggedSql}\n${query}`
			});
		} catch (error) {
			reportError(String(error));
			return
		}

		return { rows, sql: loggedSql };
	},

	async getTotalRows(dialect: Dialect, sequelize: Sequelize | null, table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number | undefined> {
		if (!sequelize) return;

		let delimiter = '`'
		if (dialect === 'postgres') {
			delimiter = '"';
		}

		const { where, replacements } = this.buildWhereClause(dialect, columns, delimiter, whereClause);
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

function buildWhereClause(dialect: Dialect, whereClause: Record<string, any>, columns: Column[], delimiter: string) {
	const where: string[] = [];
	const replacements: string[] = [];

	Object.entries(whereClause)
		.forEach(([column, value]) => {

			const targetColumn = columns.find((c: Column) => c.name === column);

			if (!targetColumn) {
				throw new Error(`Invalid column name: ${column}`)
			}

			if (value === '') { // if user clear the textbox, do not filter the column
				return;
			}

			let operator = 'LIKE';

			if (targetColumn.type === 'boolean') {
				operator = ' is ';
			}

			const numericColumns = ['int', 'float', 'decimal', 'bigint', 'smallint', 'integer'];
			const shouldDoNumericComparison = numericColumns.includes(targetColumn.type.toLocaleLowerCase());
			if (shouldDoNumericComparison) {
				operator = ' = ';
			}

			const isStringablePostgresComparison = /(uuid|integer|smallint|bigint|int\d|timestamp)/i.test(targetColumn.type) && dialect === 'postgres';
			if (isStringablePostgresComparison) {
				column = `"${column}"::text`;
				delimiter = ''
			}

			value = getTransformedValue(targetColumn, value,shouldDoNumericComparison);

			where.push(`${delimiter}${column}${delimiter} ${operator} ?`);
			replacements.push(value);
		})

	return { where, replacements }
}

function getTransformedValue(targetColumn: Column, value: any, shouldDoNumericComparison: boolean) {
	if (targetColumn.type === 'boolean') {
		if (typeof value === 'number') {
			return Boolean(value)
		} else if (!String(value).trim()) {
			return Boolean(false)
		} else if (String(value).trim().toLowerCase() === 'false') {
			return false
		} else if (!isNaN(value)) {
			return Boolean(Number(value))
		} else {
			return Boolean(value)
		}
	}

	return shouldDoNumericComparison ? value : `%${value}%`
}

