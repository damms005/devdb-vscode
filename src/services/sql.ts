import knexlib from "knex";
import { Column, DatabaseEngine, KnexClientType, QueryResponse, SerializedMutation, WhereEntry } from "../types";
import { reportError } from "./initialization-error-service";
import { SqliteEngine } from "../database-engines/sqlite-engine";

export function sanitizeIdentifier(identifier: string, openDelimiter: string, closeDelimiter: string): string {
	const escaped = identifier.replace(new RegExp(`\\${closeDelimiter}`, 'g'), `${closeDelimiter}${closeDelimiter}`);
	return `${openDelimiter}${escaped}${closeDelimiter}`;
}

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
				const conditions = buildWhereClause(engine, dialect, whereClause, columns)
				query = applyConditionToQuery(query, conditions)
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

	async getTotalRows(engine: DatabaseEngine, dialect: KnexClientType, connection: knexlib.Knex | null, table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		if (!connection) return 0;

		let query = connection(table);

		if (whereClause) {
			const conditions = buildWhereClause(engine, dialect, whereClause, columns)
			query = applyConditionToQuery(query, conditions)
		}

		const result = await query.count('* as count');

		return (result[0])?.count as number;
	},

	async commitChange(connection: knexlib.Knex | null, serializedMutation: SerializedMutation, transaction?: knexlib.Knex.Transaction, openDelimiter: string = '`'): Promise<void> {
		if (!connection) return;

		const { table, primaryKey, primaryKeyColumn } = serializedMutation;
		let query = '';
		let replacements: Record<string, any> = { primaryKey };
		const closeDelimiter = openDelimiter === '[' ? ']' : openDelimiter;

		// Postgres tables may be schema-qualified (`schema.table`); quote each part.
		const safeTable = openDelimiter === '"'
			? table.split('.').map(part => sanitizeIdentifier(part, openDelimiter, closeDelimiter)).join('.')
			: sanitizeIdentifier(table, openDelimiter, closeDelimiter);
		const safePkCol = sanitizeIdentifier(primaryKeyColumn, openDelimiter, closeDelimiter);

		if (serializedMutation.type === 'cell-update') {
			const { column, newValue } = serializedMutation;
			const safeColName = sanitizeIdentifier(column.name, openDelimiter, closeDelimiter);
			query = `UPDATE ${safeTable} SET ${safeColName} = :newValue WHERE ${safePkCol} = :primaryKey`;
			replacements = { ...replacements, newValue };
		} else if (serializedMutation.type === 'row-delete') {
			query = `DELETE FROM ${safeTable} WHERE ${safePkCol} = :primaryKey`;
		}

		if (transaction) {
			await transaction.raw(query, replacements);
			await transaction.commit()
		} else {
			await (connection).raw(query, replacements);
		}
	}
}

/**
 * Base types (lowercased, before any `(`) that cannot be meaningfully substring-matched:
 * embeddings, binary blobs, spatial values and nested/collection types. Filters on these
 * are skipped instead of producing a `LIKE` that errors or matches garbage.
 */
const OPAQUE_BASE_TYPES = new Set([
	'vector', 'halfvec', 'sparsevec',
	'bytea', 'blob', 'tinyblob', 'mediumblob', 'longblob', 'binary', 'varbinary', 'image', 'bit varying',
	'geometry', 'geography', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection',
	'array', 'list', 'struct', 'map', 'union', 'tuple', 'nested', 'object',
])

/**
 * String base types that support `LIKE` natively. On Postgres and DuckDB (the `sqlite3`
 * dialect path) every other non-numeric, non-opaque type (uuid, date, timestamp, enum,
 * json, inet, ...) has no `LIKE` operator, so the entry is flagged `useRawCast` and
 * compared as text. MySQL and MSSQL convert implicitly and never need the cast.
 */
const NATIVE_TEXT_BASE_TYPES = new Set(['character', 'character varying', 'text', 'varchar', 'char', 'name', 'citext', 'string', 'bpchar', 'nvarchar', 'nchar', 'clob'])

export function getBaseColumnType(type: string): string {
	return String(type ?? '').split('(')[0].trim().toLowerCase()
}

export function isOpaqueColumnType(type: string, dialect?: string): boolean {
	const lowered = String(type ?? '').trim().toLowerCase()
	if (lowered.endsWith('[]')) {
		return true
	}

	const base = getBaseColumnType(lowered)
	if (OPAQUE_BASE_TYPES.has(base)) {
		return true
	}

	// MSSQL has no LIKE for xml; other engines can compare it as text.
	return dialect === 'mssql' && base === 'xml'
}

function isNumericColumn(engine: DatabaseEngine | SqliteEngine, type: string): boolean {
	const numericTypes = engine.getNumericColumnTypeNamesLowercase()
	const lowered = String(type ?? '').trim().toLowerCase()
	const base = getBaseColumnType(lowered)

	return numericTypes.includes(lowered)
		|| numericTypes.includes(base)
		|| numericTypes.includes(base.split(' ')[0])
}

export function buildWhereClause(engine: DatabaseEngine | SqliteEngine, dialect: KnexClientType | 'sqlite3', whereClause: Record<string, any>, columns: Column[]): WhereEntry[] {
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

			const isBoolean = targetColumn.type === 'boolean'
			const isNumericComparison = !isBoolean && isNumericColumn(engine, targetColumn.type);

			// Skip only known opaque/complex columns (pgvector, blobs, spatial, arrays,
			// LIST/STRUCT/MAP, ...). Everything else (varchar(n), char(n), enum, date, json,
			// uuid, ...) is still filtered.
			if (!isBoolean && !isNumericComparison && isOpaqueColumnType(targetColumn.type, dialect)) {
				return;
			}

			let operator = 'LIKE';
			if (isBoolean) {
				operator = ' is ';
			}
			if (isNumericComparison) {
				operator = '=';
			}

			const needsTextCast = (dialect === 'postgres' || dialect === 'sqlite3')
				&& !isBoolean
				&& !isNumericComparison
				&& !NATIVE_TEXT_BASE_TYPES.has(getBaseColumnType(targetColumn.type));

			value = getTransformedValue(targetColumn, value, isNumericComparison);
			whereEntries.push({
				column,
				operator,
				value,
				useRawCast: needsTextCast
			});
		})
	return whereEntries
}

function applyConditionToQuery(query: knexlib.Knex.QueryBuilder, conditions: WhereEntry[]): knexlib.Knex.QueryBuilder {
	for (const clause of conditions) {
		if (clause.useRawCast) {
			// Cast the column to text for the comparison; `??` quotes the identifier
			query = query.whereRaw(`??::text ${clause.operator} ?`, [clause.column, clause.value]);
		} else {
			query = query.where(clause.column, clause.operator, clause.value);
		}
	}

	return query;
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

export type SqlLexDialect = 'postgres' | 'mysql' | 'sqlite' | 'mssql'

/**
 * Replaces comments with a space, string literals with `''` and quoted identifiers with
 * `""`, following the quoting rules of the dialect. The result is safe for keyword and
 * statement-separator checks: `/**\/DROP`, `-- c\nTRUNCATE` and `';'` can no longer hide
 * or fake SQL. Throws on an unterminated literal or comment, and on MySQL executable
 * comments (`/*! ... *\/`), which the server runs as SQL.
 */
export function stripSqlCommentsAndLiterals(sql: string, dialect: SqlLexDialect): string {
	const isIdentifierChar = (ch: string | undefined) => !!ch && /[A-Za-z0-9_$]/.test(ch)
	let out = ''
	let i = 0
	const length = sql.length

	const skipQuoted = (closeQuote: string, backslashEscapes: boolean): void => {
		i++
		while (i < length) {
			const ch = sql[i]
			if (backslashEscapes && ch === '\\') {
				i += 2
				continue
			}
			if (ch === closeQuote) {
				if (sql[i + 1] === closeQuote) {
					i += 2
					continue
				}
				i++
				return
			}
			i++
		}
		throw new Error('Unterminated quoted string or identifier in query')
	}

	while (i < length) {
		const ch = sql[i]
		const next = sql[i + 1]

		const isDashComment = ch === '-' && next === '-'
			&& (dialect !== 'mysql' || i + 2 >= length || /\s/.test(sql[i + 2]))
		if (isDashComment || (dialect === 'mysql' && ch === '#')) {
			const end = sql.indexOf('\n', i)
			i = end === -1 ? length : end + 1
			out += ' '
			continue
		}

		if (ch === '/' && next === '*') {
			if (dialect === 'mysql' && sql[i + 2] === '!') {
				throw new Error('MySQL executable comments (/*! ... */) are not allowed')
			}
			const nests = dialect === 'postgres' || dialect === 'mssql'
			let depth = 1
			i += 2
			while (i < length && depth > 0) {
				if (nests && sql[i] === '/' && sql[i + 1] === '*') {
					depth++
					i += 2
				} else if (sql[i] === '*' && sql[i + 1] === '/') {
					depth--
					i += 2
				} else {
					i++
				}
			}
			if (depth > 0) {
				throw new Error('Unterminated comment in query')
			}
			out += ' '
			continue
		}

		if (ch === "'") {
			const prefix = sql[i - 1]
			const isPostgresEscapeString = dialect === 'postgres' && (prefix === 'e' || prefix === 'E') && !isIdentifierChar(sql[i - 2])
			skipQuoted("'", dialect === 'mysql' || isPostgresEscapeString)
			out += "''"
			continue
		}

		if (ch === '"') {
			skipQuoted('"', dialect === 'mysql')
			out += dialect === 'mysql' ? "''" : '""'
			continue
		}

		if (ch === '`' && (dialect === 'mysql' || dialect === 'sqlite')) {
			skipQuoted('`', false)
			out += '""'
			continue
		}

		if (ch === '[' && (dialect === 'mssql' || dialect === 'sqlite')) {
			skipQuoted(']', false)
			out += '""'
			continue
		}

		if (ch === '$' && dialect === 'postgres' && !isIdentifierChar(sql[i - 1])) {
			const tag = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)
			if (tag) {
				const end = sql.indexOf(tag[0], i + tag[0].length)
				if (end === -1) {
					throw new Error('Unterminated dollar-quoted string in query')
				}
				i = end + tag[0].length
				out += "''"
				continue
			}
		}

		out += ch
		i++
	}

	return out
}

/**
 * First gate for a read-only `rawQuery`: exactly one statement (a trailing `;` is fine)
 * whose first keyword (after comments and an opening `(`) is in `allowedKeywords` and
 * which matches none of `deniedPatterns`. Checks run on the comment- and literal-stripped
 * text, so `/**\/DROP`, `-- c\nTRUNCATE` and stacked `;` are caught. The engine must still
 * enforce read-only at the database level.
 *
 * @returns the stripped statement, for extra engine-specific checks.
 */
export function assertReadOnlySql(sql: string, dialect: SqlLexDialect, allowedKeywords: string[], deniedPatterns: RegExp[] = []): string {
	const stripped = stripSqlCommentsAndLiterals(sql, dialect)
	const statements = stripped.split(';').map(statement => statement.trim()).filter(Boolean)

	if (statements.length === 0) {
		throw new Error('Read-only query is empty')
	}

	if (statements.length > 1) {
		throw new Error('Read-only mode allows one statement per query')
	}

	const statement = statements[0]
	const keyword = (statement.match(/^[\s(]*([A-Za-z_]+)/)?.[1] ?? '').toUpperCase()
	if (!allowedKeywords.includes(keyword)) {
		throw new Error(`Read-only mode does not allow ${keyword || 'this'} statements (allowed: ${allowedKeywords.join(', ')})`)
	}

	for (const pattern of deniedPatterns) {
		const match = statement.match(pattern)
		if (match) {
			throw new Error(`Read-only mode does not allow "${match[0].trim()}"`)
		}
	}

	return statement
}
