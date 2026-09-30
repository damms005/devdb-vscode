import { Column, DatabaseEngine, KnexClient, QueryResponse, RawQueryOptions, SerializedMutation } from '../types';
import { assertReadOnlySql, buildWhereClause } from '../services/sql';
import { assertReadOnlyPragma } from './sqlite-engine';
import { isD1InternalTable } from './d1-local-sqlite-engine';

export type SqlValue = string | number | boolean | null | Buffer;

export type StatementResult = {
	columns: string[]
	rows: Record<string, any>[]
	changes?: number
	lastRowId?: number | string
}

/**
 * Statement keywords a read-only query may start with.
 */
const READ_ONLY_KEYWORDS = ['SELECT', 'WITH', 'EXPLAIN', 'VALUES', 'PRAGMA'];

/**
 * Write verbs that SQLite accepts inside a read-looking statement (`WITH ... DELETE`,
 * `EXPLAIN UPDATE ...`). `REPLACE` alone is also a string function, so only `REPLACE INTO` counts.
 */
const EMBEDDED_WRITES = [/\b(INSERT|UPDATE|DELETE|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX)\b/i, /\bREPLACE\s+INTO\b/i];

/**
 * Checks that `code` is a single read statement for a SQLite-dialect server that has no
 * read-only session mode (e.g. Cloudflare D1), and returns it.
 */
export function assertReadOnlySqliteStatement(code: string): string {
	const statement = assertReadOnlySql(code, 'sqlite', READ_ONLY_KEYWORDS, EMBEDDED_WRITES);
	if (/^PRAGMA\b/i.test(statement)) {
		assertReadOnlyPragma(statement);
	}

	return statement;
}

/**
 * A SQLite-dialect database reached over the network (Cloudflare D1, Turso/libSQL). The
 * subclass only runs statements; this class builds them. Every value goes in as a parameter.
 */
export abstract class RemoteSqliteEngine implements DatabaseEngine {
	abstract getType(): KnexClient

	/**
	 * Runs one parameterised statement.
	 */
	protected abstract execute(sql: string, params?: SqlValue[], signal?: AbortSignal): Promise<StatementResult>

	/**
	 * Runs `code` as the user wrote it. With `readOnly`, the subclass must guarantee no write.
	 */
	protected abstract executeRaw(code: string, options: RawQueryOptions): Promise<any>

	abstract disconnect(): Promise<void>

	getConnection(): null {
		return null;
	}

	async isOkay(): Promise<boolean> {
		try {
			await this.execute('SELECT 1');
			return true;
		} catch {
			return false;
		}
	}

	async getTables(): Promise<string[]> {
		const result = await this.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`);
		return result.rows.map(row => String(row.name)).filter(name => !isD1InternalTable(name));
	}

	async getTableCreationSql(table: string): Promise<string> {
		const result = await this.execute(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
		const sql = result.rows[0]?.sql;
		if (!sql) return '';

		try {
			const { format } = await import('sql-formatter');
			return format(String(sql), { language: 'sqlite', tabWidth: 2, keywordCase: 'upper' });
		} catch {
			return String(sql);
		}
	}

	async getColumns(table: string): Promise<Column[]> {
		const [columns, foreignKeys] = await Promise.all([
			this.execute(`PRAGMA table_info(${this.escapeIdentifier(table)})`),
			this.execute(`PRAGMA foreign_key_list(${this.escapeIdentifier(table)})`).catch(() => ({ rows: [] as Record<string, any>[] })),
		]);

		const numeric = this.getNumericColumnTypeNamesLowercase();
		const plainText = ['text', 'varchar', 'character', 'json'];
		const editable = [...numeric, ...plainText];

		return columns.rows.map((column): Column => {
			const type = String(column.type ?? '');
			const lower = type.toLowerCase();
			const foreignKey = foreignKeys.rows.find(fk => fk.from === column.name);

			return {
				name: String(column.name),
				type,
				isNullable: Number(column.notnull) === 0,
				isPrimaryKey: Number(column.pk) > 0,
				isNumeric: numeric.includes(lower),
				isPlainTextType: plainText.includes(lower),
				isEditable: editable.includes(lower) || editable.some(prefix => lower.startsWith(prefix)),
				foreignKey: foreignKey ? { table: String(foreignKey.table), column: String(foreignKey.to) } : undefined,
			};
		});
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['integer', 'int', 'real', 'numeric', 'float', 'double', 'bigint'];
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>, signal?: AbortSignal): Promise<number> {
		const { where, params } = this.buildWhere(columns, whereClause);
		const result = await this.execute(`SELECT COUNT(*) AS count FROM ${this.escapeIdentifier(table)}${where}`, params, signal);

		return Number(result.rows[0]?.count ?? 0);
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>, signal?: AbortSignal): Promise<QueryResponse | undefined> {
		const columnList = columns.length ? columns.map(column => this.escapeIdentifier(column.name)).join(', ') : '*';
		const { where, params } = this.buildWhere(columns, whereClause);
		const sql = `SELECT ${columnList} FROM ${this.escapeIdentifier(table)}${where} LIMIT ? OFFSET ?`;
		const result = await this.execute(sql, [...params, limit, offset], signal);

		return { rows: result.rows, sql };
	}

	async commitChange(mutation: SerializedMutation): Promise<void> {
		const table = this.escapeIdentifier(mutation.table);
		const key = this.escapeIdentifier(mutation.primaryKeyColumn);

		if (mutation.type === 'cell-update') {
			await this.execute(
				`UPDATE ${table} SET ${this.escapeIdentifier(mutation.column.name)} = ? WHERE ${key} = ?`,
				[toSqlValue(mutation.newValue), toSqlValue(mutation.primaryKey)],
			);
			return;
		}

		if (mutation.type === 'row-delete') {
			await this.execute(`DELETE FROM ${table} WHERE ${key} = ?`, [toSqlValue(mutation.primaryKey)]);
			return;
		}

		throw new Error(`Unsupported mutation type: ${(mutation as { type: string }).type}`);
	}

	async getVersion(): Promise<string | undefined> {
		try {
			const result = await this.execute('SELECT sqlite_version() AS version');
			return result.rows[0]?.version ? String(result.rows[0].version) : undefined;
		} catch {
			return undefined;
		}
	}

	async rawQuery(code: string, options: RawQueryOptions = {}): Promise<any> {
		if (options.readOnly) {
			assertReadOnlySqliteStatement(code);
		}

		return this.executeRaw(code, options);
	}

	protected escapeIdentifier(identifier: string): string {
		return `"${identifier.replace(/"/g, '""')}"`;
	}

	private buildWhere(columns: Column[], whereClause?: Record<string, any>): { where: string, params: SqlValue[] } {
		if (!whereClause || Object.keys(whereClause).length === 0) {
			return { where: '', params: [] };
		}

		const conditions: string[] = [];
		const params: SqlValue[] = [];
		for (const entry of buildWhereClause(this, 'sqlite3', whereClause, columns)) {
			const column = this.escapeIdentifier(entry.column);
			conditions.push(`${entry.useRawCast ? `CAST(${column} AS TEXT)` : column} ${entry.operator.trim()} ?`);
			params.push(toSqlValue(entry.value));
		}

		return { where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', params };
	}
}

export function toSqlValue(value: unknown): SqlValue {
	if (value === null || value === undefined) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
	if (value instanceof Date) return value.toISOString();
	if (Buffer.isBuffer(value) || typeof value === 'number' || typeof value === 'string') return value;
	return JSON.stringify(value);
}
