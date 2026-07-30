import { stat } from 'fs/promises';
import { reportError } from '../services/initialization-error-service';
import { Column, DatabaseEngine, KnexClient, QueryResponse, SerializedMutation } from '../types';
import { buildWhereClause } from '../services/sql';

/**
 * Minimal structural typings for the `@duckdb/node-api` (DuckDB Neo) driver.
 * We avoid a hard compile-time dependency on the package's own types so the
 * extension still builds when the optional dependency is not installed.
 */
interface DuckDbResultReader {
	getRowObjects(): Record<string, any>[];
}

interface DuckDbConnection {
	runAndReadAll(sql: string, params?: any[]): Promise<DuckDbResultReader>;
	run(sql: string, params?: any[]): Promise<unknown>;
	closeSync?(): void;
	disconnectSync?(): void;
}

interface DuckDbInstance {
	connect(): Promise<DuckDbConnection>;
	closeSync?(): void;
}

interface DuckDbModule {
	DuckDBInstance: {
		create(path?: string, config?: Record<string, string>): Promise<DuckDbInstance>;
	};
}

/**
 * A data file (Parquet/CSV/JSON) DuckDB can read directly. When provided, the
 * engine opens an in-memory database and exposes the file as a queryable VIEW,
 * which is the defining DuckDB feature (query files without importing them).
 */
export interface DuckDbDataFile {
	path: string;
	viewName: string;
}

export interface DuckDbEngineOptions {
	/**
	 * Opens the database with `access_mode=READ_ONLY` so DuckDB never takes an
	 * exclusive write lock on the user's file (which would block their other
	 * DuckDB processes). Defaults to `true` for on-disk files. Pass `false` to
	 * explicitly opt into a read-write connection.
	 */
	readOnly?: boolean;

	/**
	 * When set, the engine ignores `dbPath`, opens an in-memory database and
	 * registers `dataFile` as a VIEW. Such views are never editable.
	 */
	dataFile?: DuckDbDataFile;
}

/**
 * DuckDB is an embedded, single-file, SQLite-class engine (no server/auth), so
 * this engine mirrors `SqliteEngine`: it opens a `.duckdb`/`.db` file path and
 * speaks SQL directly. Complex columnar values (LIST/STRUCT/MAP/ENUM) are
 * normalized to plain, JSON-serializable JS values before leaving the engine.
 */
export class DuckDbEngine implements DatabaseEngine {
	public dbPath: string;
	private instance: DuckDbInstance | null = null;
	private connection: DuckDbConnection | null = null;
	private connecting: Promise<DuckDbConnection | null> | null = null;
	private readonly readOnly: boolean;
	private readonly dataFile?: DuckDbDataFile;

	constructor(dbPath: string = ':memory:', options: DuckDbEngineOptions = {}) {
		this.dataFile = options.dataFile;
		this.dbPath = this.dataFile ? ':memory:' : dbPath;
		this.readOnly = options.readOnly ?? (this.dbPath !== ':memory:');
	}

	/**
	 * True when the file is opened read-only (default for on-disk files) or when
	 * browsing a data file as a VIEW. Callers use this to disable edits so
	 * `commitChange` never silently no-ops against a non-writable connection.
	 */
	isReadOnly(): boolean {
		return this.connectionIsReadOnly() || !!this.dataFile;
	}

	/**
	 * Whether the underlying DuckDB connection is opened with `access_mode=READ_ONLY`.
	 * Only on-disk files can be read-only; `:memory:` databases are always writable.
	 */
	private connectionIsReadOnly(): boolean {
		return this.readOnly && this.dbPath !== ':memory:';
	}

	getType(): KnexClient {
		return 'duckdb';
	}

	getFilename(): string {
		return this.dbPath;
	}

	/**
	 * DuckDB is not a knex client and its connection is neither a Knex instance
	 * nor a SQLite `Database`, so we intentionally expose no shared connection
	 * object to the messenger transaction path (see `commitChange`).
	 */
	getConnection(): null {
		return null;
	}

	private async loadDriver(): Promise<DuckDbModule> {
		try {
			// @ts-ignore - '@duckdb/node-api' is an optional dependency resolved at runtime
			return (await import('@duckdb/node-api')) as unknown as DuckDbModule;
		} catch (err) {
			throw new Error(
				`The '@duckdb/node-api' package is required for DuckDB support but could not be loaded: ${String(err)}`
			);
		}
	}

	private async getDuckDbConnection(): Promise<DuckDbConnection | null> {
		if (this.connection) {
			return this.connection;
		}

		if (this.connecting) {
			return this.connecting;
		}

		this.connecting = (async () => {
			try {
				const { DuckDBInstance } = await this.loadDriver();
				const config: Record<string, string> = {};
				if (this.connectionIsReadOnly()) {
					config.access_mode = 'READ_ONLY';
				}
				this.instance = await DuckDBInstance.create(this.dbPath, config);
				this.connection = await this.instance.connect();

				if (this.dataFile) {
					await this.connection.run(this.buildCreateViewSql(this.dataFile));
				}

				return this.connection;
			} catch (err) {
				reportError(this.describeConnectionError(err));
				return null;
			} finally {
				this.connecting = null;
			}
		})();

		return this.connecting;
	}

	/**
	 * Surfaces the holder PID from DuckDB's lock-conflict error so the user can
	 * identify (and close) the other process holding the write lock, instead of
	 * seeing an opaque "IO Error". Falls back to the raw error otherwise.
	 */
	private describeConnectionError(err: unknown): string {
		const message = String(err);
		const pidMatch = message.match(/PID\s+(\d+)/i);
		if (pidMatch) {
			return `DuckDB file "${this.dbPath}" is locked by another process (PID ${pidMatch[1]}). Close that process, or open the database read-only. Original error: ${message}`;
		}
		return `DuckDB connection error: ${message}`;
	}

	/**
	 * Builds a `CREATE VIEW` over a data file using the reader matching its
	 * extension (`read_parquet`/`read_csv_auto`/`read_json_auto`).
	 */
	private buildCreateViewSql(dataFile: DuckDbDataFile): string {
		const reader = this.dataFileReader(dataFile.path);
		const literalPath = dataFile.path.replace(/'/g, "''");
		return `CREATE VIEW ${this.escapeIdentifier(dataFile.viewName)} AS SELECT * FROM ${reader}('${literalPath}')`;
	}

	private dataFileReader(path: string): string {
		const lower = path.toLowerCase();
		if (lower.endsWith('.parquet')) {
			return 'read_parquet';
		}
		if (lower.endsWith('.json') || lower.endsWith('.ndjson')) {
			return 'read_json_auto';
		}
		return 'read_csv_auto';
	}

	private async query(sql: string, params: any[] = []): Promise<Record<string, any>[]> {
		const connection = await this.getDuckDbConnection();
		if (!connection) {
			throw new Error('Cannot connect to database');
		}

		const reader = await connection.runAndReadAll(sql, params);
		return reader.getRowObjects().map((row) => this.normalizeRow(row));
	}

	async isOkay(): Promise<boolean> {
		try {
			const connection = await this.getDuckDbConnection();
			if (!connection) {
				return false;
			}

			if (this.dbPath !== ':memory:') {
				const stats = await stat(this.dbPath);
				const fileSizeGB = Math.round((stats.size / (1024 * 1024 * 1024) + Number.EPSILON) * 100) / 100;
				const maxSizeGB = 5;
				if (fileSizeGB > maxSizeGB) {
					reportError(`Warning: DuckDB database file size too big for health check: ${fileSizeGB}GB. Maximum size is ${maxSizeGB}GB. File: ${this.dbPath}`);
					return true;
				}
			}

			const rows = await this.query('SELECT 1 AS ok');
			return rows.length > 0 && Number(rows[0].ok) === 1;
		} catch (err) {
			reportError(`DuckDB OK-check error: ${err}`);
			return false;
		}
	}

	async disconnect(): Promise<void> {
		try {
			this.connection?.disconnectSync?.();
			this.connection?.closeSync?.();
			this.instance?.closeSync?.();
		} catch (err) {
			reportError(`DuckDB disconnect error: ${err}`);
		} finally {
			this.connection = null;
			this.instance = null;
		}
	}

	async getTables(): Promise<string[]> {
		try {
			const rows = await this.query(
				`SELECT table_name FROM information_schema.tables
				 WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
				 ORDER BY table_name`
			);
			return rows.map((row) => String(row.table_name));
		} catch (err) {
			reportError(`DuckDB get tables error: ${err}`);
			return [];
		}
	}

	async getTableCreationSql(table: string): Promise<string> {
		try {
			const rows = await this.query(
				`SELECT sql FROM duckdb_tables() WHERE table_name = $1`,
				[table]
			);

			const sql = rows[0]?.sql ? String(rows[0].sql) : '';
			if (!sql) {
				return '';
			}

			try {
				const { format } = await import('sql-formatter');
				return format(sql, { language: 'sqlite', tabWidth: 2, keywordCase: 'upper' });
			} catch (formatErr) {
				reportError(`DuckDB SQL formatting error: ${formatErr}`);
				return sql;
			}
		} catch (err) {
			reportError(`DuckDB get table creation SQL error: ${err}`);
			return '';
		}
	}

	async getColumns(table: string): Promise<Column[]> {
		try {
			type TableColumn = { name: string; type: string; notnull: number | boolean; pk: number | boolean };

			const rawColumns = await this.query(`PRAGMA table_info(${this.escapeIdentifier(table)})`) as unknown as TableColumn[];

			const foreignKeys = await this.getForeignKeys(table);
			const editableColumnTypeNamesLowercase = this.getEditableColumnTypeNamesLowercase();

			return rawColumns.map((column): Column => {
				const baseType = this.getBaseType(column.type);
				const isComplex = this.isComplexType(column.type);
				const foreignKey = foreignKeys.find((fk) => fk.from === column.name);

				return {
					name: column.name,
					type: column.type,
					isNullable: !this.toBoolean(column.notnull),
					isPrimaryKey: this.toBoolean(column.pk),
					isNumeric: !isComplex && this.getNumericColumnTypeNamesLowercase().includes(baseType),
					isPlainTextType: !isComplex && this.getPlainStringTypes().includes(baseType),
					isEditable: !this.isReadOnly()
						&& !isComplex
						&& (editableColumnTypeNamesLowercase.includes(baseType)
							|| editableColumnTypeNamesLowercase.some((editable) => baseType.startsWith(editable))),
					foreignKey: foreignKey
						? { table: foreignKey.table, column: foreignKey.to }
						: undefined,
				};
			});
		} catch (err) {
			reportError(`DuckDB get columns error: ${err}`);
			return [];
		}
	}

	private async getForeignKeys(table: string): Promise<{ from: string; table: string; to: string }[]> {
		try {
			const rows = await this.query(
				`SELECT constraint_column_names, referenced_table, referenced_column_names
				 FROM duckdb_constraints()
				 WHERE table_name = $1 AND constraint_type = 'FOREIGN KEY'`,
				[table]
			);

			const foreignKeys: { from: string; table: string; to: string }[] = [];
			for (const row of rows) {
				const fromColumns: any[] = Array.isArray(row.constraint_column_names) ? row.constraint_column_names : [];
				const toColumns: any[] = Array.isArray(row.referenced_column_names) ? row.referenced_column_names : [];
				const referencedTable = row.referenced_table ? String(row.referenced_table) : '';

				fromColumns.forEach((fromColumn, index) => {
					foreignKeys.push({
						from: String(fromColumn),
						table: referencedTable,
						to: String(toColumns[index] ?? toColumns[0] ?? ''),
					});
				});
			}

			return foreignKeys;
		} catch {
			return [];
		}
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return [
			'tinyint', 'smallint', 'integer', 'int', 'int1', 'int2', 'int4', 'int8', 'bigint', 'hugeint',
			'utinyint', 'usmallint', 'uinteger', 'ubigint', 'uhugeint',
			'decimal', 'numeric', 'real', 'float', 'float4', 'float8', 'double',
		];
	}

	getEditableColumnTypeNamesLowercase(): string[] {
		return [...this.getNumericColumnTypeNamesLowercase(), ...this.getPlainStringTypes()];
	}

	getPlainStringTypes(): string[] {
		return ['varchar', 'char', 'bpchar', 'text', 'string', 'json', 'uuid'];
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		try {
			let sql = `SELECT COUNT(*) AS count FROM ${this.escapeIdentifier(table)}`;
			const params: any[] = [];

			if (whereClause && Object.keys(whereClause).length > 0) {
				const { whereString, whereParams } = this.buildWhereClause(whereClause, columns, params.length);
				if (whereString.trim()) {
					sql += ` WHERE ${whereString}`;
					params.push(...whereParams);
				}
			}

			const rows = await this.query(sql, params);
			return rows.length ? Number(rows[0].count) : 0;
		} catch (err) {
			reportError(`DuckDB get total rows error: ${err}`);
			return 0;
		}
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		try {
			const columnNames = columns.map((col) => this.escapeIdentifier(col.name)).join(', ');
			let sql = `SELECT ${columnNames} FROM ${this.escapeIdentifier(table)}`;
			const params: any[] = [];

			if (whereClause && Object.keys(whereClause).length > 0) {
				const { whereString, whereParams } = this.buildWhereClause(whereClause, columns, params.length);
				if (whereString.trim()) {
					sql += ` WHERE ${whereString}`;
					params.push(...whereParams);
				}
			}

			sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
			params.push(limit, offset);

			const rows = await this.query(sql, params);
			return { rows, sql };
		} catch (err) {
			reportError(`DuckDB get rows error: ${err}`);
			return undefined;
		}
	}

	/**
	 * Runs `SUMMARIZE <table>` and returns the per-column statistics rows
	 * (min/max/approx_unique/avg/std/percentiles/null_percentage/…) for a future
	 * column-stats panel.
	 */
	async summarize(table: string): Promise<Record<string, any>[]> {
		try {
			return await this.query(`SUMMARIZE ${this.escapeIdentifier(table)}`);
		} catch (err) {
			reportError(`DuckDB summarize error: ${err}`);
			return [];
		}
	}

	async getVersion(): Promise<string> {
		try {
			const rows = await this.query('SELECT version() AS version');
			return rows.length ? String(rows[0].version) : 'unknown';
		} catch (err) {
			reportError(`DuckDB get version error: ${err}`);
			return 'unknown';
		}
	}

	/**
	 * DuckDB does not participate in the shared knex/SQLite transaction path used
	 * by the messenger, so mutations are applied directly. This keeps single-cell
	 * updates and row deletions working for the embedded file.
	 */
	async commitChange(mutation: SerializedMutation): Promise<void> {
		if (this.isReadOnly()) {
			throw new Error(`Cannot modify data: the DuckDB connection to "${this.dbPath}" is read-only.`);
		}

		const connection = await this.getDuckDbConnection();
		if (!connection) {
			throw new Error('Cannot connect to database');
		}

		const { type, table, primaryKeyColumn, primaryKey } = mutation;

		let sql: string;
		let params: any[];

		if (type === 'cell-update') {
			sql = `UPDATE ${this.escapeIdentifier(table)}
			       SET ${this.escapeIdentifier(mutation.column.name)} = $1
			       WHERE ${this.escapeIdentifier(primaryKeyColumn)} = $2`;
			params = [this.transformValueForDuckDb(mutation.newValue), primaryKey];
		} else if (type === 'row-delete') {
			sql = `DELETE FROM ${this.escapeIdentifier(table)} WHERE ${this.escapeIdentifier(primaryKeyColumn)} = $1`;
			params = [primaryKey];
		} else {
			throw new Error(`Unsupported mutation type: ${type}`);
		}

		/**
		 * DuckDB has no shared knex/SQLite transaction object on this engine
		 * (getConnection() is null), so we wrap the write in an explicit
		 * BEGIN/COMMIT to keep it atomic and roll back on failure.
		 */
		await connection.run('BEGIN TRANSACTION');
		try {
			await connection.run(sql, params);
			await connection.run('COMMIT');
		} catch (err) {
			try {
				await connection.run('ROLLBACK');
			} catch (rollbackErr) {
				reportError(`DuckDB rollback error: ${rollbackErr}`);
			}
			throw err;
		}
	}

	async raw(code: string): Promise<any> {
		return this.rawQuery(code);
	}

	async rawQuery(code: string): Promise<any> {
		try {
			const connection = await this.getDuckDbConnection();
			if (!connection) {
				throw new Error('Cannot connect to database');
			}

			const isReadQuery = /^\s*(SELECT|PRAGMA|WITH|SHOW|DESCRIBE|EXPLAIN|CALL|VALUES|FROM|TABLE|SUMMARIZE|PIVOT|UNPIVOT)\b/i.test(code);

			if (isReadQuery) {
				return await this.query(code);
			}

			await connection.run(code);
			return { changes: 0 };
		} catch (err) {
			reportError(`DuckDB run arbitrary query error: ${err}`);
			throw err;
		}
	}

	private buildWhereClause(whereClause: Record<string, any>, columns: Column[], paramOffset: number): { whereString: string; whereParams: any[] } {
		const wheres: string[] = [];
		const whereParams: any[] = [];

		const clause = buildWhereClause(this, 'sqlite3', whereClause, columns);

		clause.forEach((entry) => {
			wheres.push(`${this.escapeIdentifier(entry.column)} ${entry.operator} $${paramOffset + whereParams.length + 1}`);
			whereParams.push(entry.value);
		});

		return { whereString: wheres.join(' AND '), whereParams };
	}

	private transformValueForDuckDb(value: any): any {
		if (value === null || value === undefined) {
			return null;
		}

		if (value instanceof Date) {
			return value.toISOString();
		}

		return value;
	}

	private normalizeRow(row: Record<string, any>): Record<string, any> {
		const normalized: Record<string, any> = {};
		for (const [key, value] of Object.entries(row)) {
			normalized[key] = this.normalizeValue(value);
		}
		return normalized;
	}

	/**
	 * Converts DuckDB values (including LIST/STRUCT/MAP wrappers and BIGINT/HUGEINT
	 * bigints) into plain, JSON-serializable JS values so cells survive the
	 * webview postMessage boundary.
	 */
	private normalizeValue(value: any): any {
		if (value === null || value === undefined) {
			return value;
		}

		if (typeof value === 'bigint') {
			return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
				? Number(value)
				: value.toString();
		}

		if (value instanceof Date) {
			return value.toISOString();
		}

		if (value instanceof Uint8Array) {
			return Buffer.from(value).toString('base64');
		}

		if (Array.isArray(value)) {
			return value.map((item) => this.normalizeValue(item));
		}

		if (value instanceof Map) {
			const out: Record<string, any> = {};
			for (const [key, entryValue] of value.entries()) {
				out[String(key)] = this.normalizeValue(entryValue);
			}
			return out;
		}

		if (typeof value === 'object') {
			const constructorName = value?.constructor?.name;

			/** DuckDB LIST/ARRAY values wrap their elements in an `items` array. */
			if (constructorName === 'DuckDBListValue' || constructorName === 'DuckDBArrayValue' || Array.isArray((value as any).items)) {
				return ((value as any).items as any[]).map((item) => this.normalizeValue(item));
			}

			/** DuckDB STRUCT values expose their fields under an `entries` object. */
			if (constructorName === 'DuckDBStructValue' || ((value as any).entries && typeof (value as any).entries === 'object' && !Array.isArray((value as any).entries))) {
				const out: Record<string, any> = {};
				for (const [key, entryValue] of Object.entries((value as any).entries)) {
					out[key] = this.normalizeValue(entryValue);
				}
				return out;
			}

			if (typeof (value as any).toJSON === 'function') {
				return this.normalizeValue((value as any).toJSON());
			}

			const out: Record<string, any> = {};
			for (const [key, entryValue] of Object.entries(value)) {
				out[key] = this.normalizeValue(entryValue);
			}
			return out;
		}

		return value;
	}

	private isComplexType(type: string): boolean {
		return /(\[\]|\bLIST\b|\bSTRUCT\b|\bMAP\b|\bENUM\b|\bUNION\b|\bARRAY\b)/i.test(type);
	}

	/**
	 * Reduces a DuckDB declared type to a matchable base token, e.g.
	 * `DECIMAL(10,2)` -> `decimal`, `INTEGER[]` -> `integer`, `VARCHAR` -> `varchar`.
	 */
	private getBaseType(type: string): string {
		return type
			.toLowerCase()
			.replace(/\(.*\)/, '')
			.replace(/\[\]/g, '')
			.trim();
	}

	private toBoolean(value: number | boolean): boolean {
		return value === true || value === 1;
	}

	private escapeIdentifier(identifier: string): string {
		return `"${identifier.replace(/"/g, '""')}"`;
	}

	destroy(): void { }
}
