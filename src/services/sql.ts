import { Dialect, QueryTypes, Sequelize, Transaction } from "sequelize";
import { Column, DatabaseEngine, QueryResponse, SerializedMutation } from "../types";
import { reportError } from "./initialization-error-service";

export const SqlService = {

	buildWhereClause(engine: DatabaseEngine, dialect: Dialect, columns: Column[], openDelimiter: string, whereClause?: Record<string, any>): { where: string[], replacements: string[] } {
		if (!whereClause) return {
			where: [],
			replacements: []
		}

		return buildWhereClause(engine, dialect, whereClause, columns, openDelimiter);
	},

	async getRows(engine: DatabaseEngine, dialect: Dialect, sequelize: Sequelize | null, table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!sequelize) return;

		let openDelimiter = '`'
		if (dialect === 'postgres') {
			openDelimiter = '"';
		}

		const { where, replacements } = this.buildWhereClause(engine, dialect, columns, openDelimiter, whereClause);

		let limitConstraint = limit ? `LIMIT ${limit}` : '';
		limitConstraint += offset ? ` OFFSET ${offset}` : '';

		const whereString = where.length ? `WHERE ${where.join(' AND ')}` : '';
		let loggedSql = '';
		let rows

		const sql = `SELECT * FROM ${openDelimiter}${table}${openDelimiter} ${whereString} ${limitConstraint}`

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

	async getTotalRows(engine: DatabaseEngine, dialect: Dialect, sequelize: Sequelize | null, table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number | undefined> {
		if (!sequelize) return;

		let openDelimiter = '`'
		if (dialect === 'postgres') {
			openDelimiter = '"';
		}

		const { where, replacements } = this.buildWhereClause(engine, dialect, columns, openDelimiter, whereClause);
		const whereString = where.length ? `WHERE ${where.join(' AND ')}` : '';
		let count;

		try {
			count = await sequelize.query(`SELECT COUNT(*) FROM ${openDelimiter}${table}${openDelimiter} ${whereString}`, {
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

	async commitChange(sequelize: Sequelize | null, serializedMutation: SerializedMutation, transaction?: Transaction, openDelimiter: string = '`'): Promise<void> {
		if (!sequelize) return;

		const { table, primaryKey, primaryKeyColumn } = serializedMutation;
		let query = '';
		let replacements: Record<string, any> = { primaryKey };

		if (serializedMutation.type === 'cell-update') {
			const { column, newValue } = serializedMutation;
			query = `UPDATE ${openDelimiter}${table}${openDelimiter} SET ${openDelimiter}${column.name}${openDelimiter} = :newValue WHERE ${openDelimiter}${primaryKeyColumn}${openDelimiter} = :primaryKey`;
			replacements = { ...replacements, newValue };
		} else if (serializedMutation.type === 'row-delete') {
			query = `DELETE FROM ${openDelimiter}${table}${openDelimiter} WHERE ${openDelimiter}${primaryKeyColumn}${openDelimiter} = :primaryKey`;
		}

		if (query) {
			await sequelize.query(query, {
				replacements,
				type: serializedMutation.type === 'cell-update' ? QueryTypes.UPDATE : QueryTypes.DELETE,
				transaction
			});
		}
	}
}

function buildWhereClause(engine: DatabaseEngine, dialect: Dialect, whereClause: Record<string, any>, columns: Column[], openDelimiter: string) {
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

			const isNumericComparison = engine.getNumericColumnTypeNamesLowercase().includes(targetColumn.type.toLocaleLowerCase());
			if (isNumericComparison) {
				operator = '=';
			}

			const isStringablePostgresComparison = /(uuid|integer|smallint|bigint|int\d|timestamp)/i.test(targetColumn.type) && dialect === 'postgres';
			if (isStringablePostgresComparison) {
				column = `"${column}"::text`;
				openDelimiter = ''
			}

			value = getTransformedValue(targetColumn, value, isNumericComparison);

			where.push(`${openDelimiter}${column}${openDelimiter} ${operator} ?`);
			replacements.push(value);
		})

	return { where, replacements }
}

function getTransformedValue(targetColumn: Column, value: any, isNumericComparison: boolean) {
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

	return isNumericComparison ? value : `%${value}%`
}
