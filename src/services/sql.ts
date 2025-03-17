import knexlib from "knex";
import { Column, DatabaseEngine, KnexClientType, QueryResponse, SerializedMutation, WhereEntry } from "../types";
import { reportError } from "./initialization-error-service";

export const SqlService = {

	buildWhereClause(engine: DatabaseEngine, dialect: KnexClientType, columns: Column[], whereClause?: Record<string, any>): WhereEntry[] {
		if (!whereClause) return []

		return buildWhereClause(engine, dialect, whereClause, columns);
	},

	async getRows(engine: DatabaseEngine, dialect: KnexClientType, connection: knexlib.Knex | null, table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		if (!connection) return;

		if (!columns.length) {
			throw new Error(`No columns in target table ${table}`)
		}

		try {
			let loggedSql = '';
			let rows
			let query = connection(table).select("*")
			if (whereClause) {
				const build = buildWhereClause(engine, dialect, whereClause, columns)
				for (let index = 0; index < build.length; index++) {
					const element = build[index];
					if (element.useRawCast) {
						// Use raw to cast the column to text for the comparison
						query = query.whereRaw(`${element.column}::text ${element.operator} ?`, [element.value]);
					} else {
						query = query.where(element.column, element.operator, element.value);
					}
				}
			}
			if (limit) {
				query = query.limit(limit)
			}
			if (offset) {
				query = query.offset(offset)
			}

			rows = (await query)
			loggedSql = query.toString()
			return { rows, sql: loggedSql };
		} catch (error) {
			reportError(String(error));
			return
		}
	},

	async getTotalRows(engine: DatabaseEngine, dialect: KnexClientType, connection: knexlib.Knex | null, table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number | undefined> {
		if (!connection) return;

		const result = await connection(table).where(whereClause ?? {}).count('* as count');

		return (result[0])?.count as number;
	},

	async commitChange(connection: knexlib.Knex | null, serializedMutation: SerializedMutation, transaction?: knexlib.Knex.Transaction, openDelimiter: string = '`'): Promise<void> {
		if (!connection) return;

		const { table, primaryKey, primaryKeyColumn } = serializedMutation;
		let query = '';
		let replacements: Record<string, any> = { primaryKey };
		const closeDelimiter = openDelimiter === '[' ? ']' : openDelimiter;

		if (serializedMutation.type === 'cell-update') {
			const { column, newValue } = serializedMutation;
			query = `UPDATE ${openDelimiter}${table}${closeDelimiter} SET ${openDelimiter}${column.name}${closeDelimiter} = :newValue WHERE ${openDelimiter}${primaryKeyColumn}${closeDelimiter} = :primaryKey`;
			replacements = { ...replacements, newValue };
		} else if (serializedMutation.type === 'row-delete') {
			query = `DELETE FROM ${openDelimiter}${table}${closeDelimiter} WHERE ${openDelimiter}${primaryKeyColumn}${closeDelimiter} = :primaryKey`;
		}

		if (transaction) {
			await transaction.raw(query, replacements);
		} else {
			await (connection).raw(query, replacements);
		}
	}
}

function buildWhereClause(engine: DatabaseEngine, dialect: KnexClientType, whereClause: Record<string, any>, columns: Column[]): WhereEntry[] {
	const whereEntries: WhereEntry[] = [];
	Object.entries(whereClause)
		.forEach(([column, value]) => {
			const targetColumn = columns.find((c: Column) => c.name === column);
			if (!targetColumn) {
				throw new Error(`Invalid column name: ${column}`)
			}
			if (value === '') { // e.g. user cleared the textbox, do not filter the column
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
			let columnExpression = column;

			value = getTransformedValue(targetColumn, value, isNumericComparison);
			whereEntries.push({
				column: columnExpression,
				operator,
				value,
				useRawCast: isStringablePostgresComparison && !isNumericComparison
			});
		})
	return whereEntries
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
