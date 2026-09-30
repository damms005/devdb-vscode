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
	readonly done: boolean;
}

interface DuckDbPreparedStatement {
	readonly statementType: number;
	streamAndReadUntil(targetRowCount: number): Promise<DuckDbResultReader>;
	destroySync?(): void;
}

interface DuckDbExtractedStatements {
	readonly count: number;
	prepare(index: number): Promise<DuckDbPreparedStatement>;
}

interface DuckDbConnection {
	runAndReadAll(sql: string, params?: any[]): Promise<DuckDbResultReader>;
	streamAndReadUntil(sql: string, targetRowCount: number, params?: any[]): Promise<DuckDbResultReader>;
	run(sql: string, params?: any[]): Promise<unknown>;
	extractStatements(sql: string): Promise<DuckDbExtractedStatements>;
	interrupt(): void;
	closeSync?(): void;
	disconnectSync?(): void;
}

/** `StatementType` values from `@duckdb/node-bindings` that a read-only rawQuery may run. */
const STATEMENT_TYPE_SELECT = 1;
const STATEMENT_TYPE_EXPLAIN = 4;

/**
 * Statements refused in read-only rawQuery by first keyword. Some of these
 * (e.g. `PRAGMA`) prepare as a plain SELECT, so the statement type alone does
 * not catch them.
 */
const READ_ONLY_BLOCKED_KEYWORDS = ['COPY', 'ATTACH', 'DETACH', 'INSTALL', 'LOAD', 'SET', 'RESET', 'PRAGMA', 'EXPORT', 'IMPORT', 'USE', 'CALL', 'CHECKPOINT', 'FORCE', 'UPDATE_EXTENSIONS'];

/**
 * Hard cap on the rows {@link DuckDbEngine.rawQuery} returns, matching the
 * ClickHouse engine. Results are streamed, so rows past the cap are never read.
 */
export const RAW_QUERY_MAX_ROWS = 10_000;

/** Tables above this row count are summarized from a sample. */
export const SUMMARIZE_SAMPLE_THRESHOLD = 5_000_000;

/** Approximate number of rows a sampled SUMMARIZE reads. */
const SUMMARIZE_SAMPLE_ROWS = 1_000_000;

/** Columns of a DuckDB `SUMMARIZE` result, in order. */
const SUMMARIZE_COLUMNS = ['column_name', 'column_type', 'min', 'max', 'approx_unique', 'avg', 'std', 'q25', 'q50', 'q75', 'count', 'null_percentage'];

/** BLOB cells show at most this many bytes as hex. */
const BLOB_PREVIEW_BYTES = 64;

/**
 * Rows returned by {@link DuckDbEngine.rawQuery}. `truncated` is true when the
 * result had more than {@link RAW_QUERY_MAX_ROWS} rows and was cut.
 */
export type DuckDbRawQueryRows = Record<string, any>[] & { truncated?: boolean };

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

	/**
	 * Tables outside the default `main` schema are listed as `schema.table`. This maps
	 * each listed name to its parts, so a dot inside a `main` table name stays literal.
	 */
	private tableParts = new Map<string, { schema: string, name: string }>();

	/**
	 * Row counts of the data-file view, keyed by filter. A CSV/JSON view
	 * re-parses the whole file for each COUNT(*), so the count is kept for the
	 * session.
	 */
	private readonly dataFileCountCache = new Map<string, number>();

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
			/**
			 * Platform VSIX files ship one native binding. linux-armhf and the
			 * universal VSIX ship none, so the binding lookup fails there.
			 */
			if (/unsupported arch|node-bindings-[\w-]+\/duckdb\.node/.test(String(err))) {
				throw new Error(`DuckDB is not supported on this platform (${process.platform}-${process.arch}). Install the DevDb build for your platform from the VS Code Marketplace.`);
			}
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
				const connection = await this.instance.connect();

				if (this.dataFile) {
					await connection.run(this.buildCreateViewSql(this.dataFile));
				}

				await this.lockDown(connection);

				this.connection = connection;
				return connection;
			} catch (err) {
				reportError(this.describeConnectionError(err));
				this.instance?.closeSync?.();
				this.instance = null;
				return null;
			} finally {
				this.connecting = null;
			}
		})();

		return this.connecting;
	}

	/**
	 * Removes DuckDB's file, network and extension access once the database
	 * (and the data-file view) is open, then locks the configuration so SQL
	 * cannot turn it back on. Without this, any query (including one from the
	 * MCP server) could read `/etc/passwd`, write files with COPY, ATTACH other
	 * databases or download extensions. A data-file view keeps read access to
	 * its one file through `allowed_paths`; writing to it stays blocked.
	 */
	private async lockDown(connection: DuckDbConnection): Promise<void> {
		if (this.dataFile) {
			await connection.run(`SET allowed_paths = [${this.quoteLiteral(this.dataFile.path)}]`);
		}
		await connection.run('SET enable_external_access = false');
		await connection.run('SET autoinstall_known_extensions = false');
		await connection.run('SET autoload_known_extensions = false');
		await connection.run('SET lock_configuration = true');
	}

	private quoteLiteral(value: string): string {
		return `'${value.replace(/'/g, "''")}'`;
	}

	/**
	 * Runs `task` on the connection and calls `interrupt()` when `signal`
	 * aborts, so the host's cancel stops the running DuckDB query.
	 */
	private async withInterrupt<T>(connection: DuckDbConnection, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
		if (signal?.aborted) {
			throw new Error('Query cancelled');
		}

		const onAbort = () => connection.interrupt();
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			return await task();
		} finally {
			signal?.removeEventListener('abort', onAbort);
		}
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
		return `CREATE VIEW ${this.escapeIdentifier(dataFile.viewName)} AS SELECT * FROM ${reader}(${this.quoteLiteral(dataFile.path)})`;
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

	private async query(sql: string, params: any[] = [], signal?: AbortSignal): Promise<Record<string, any>[]> {
		const connection = await this.requireConnection();
		const reader = await this.withInterrupt(connection, signal, () => connection.runAndReadAll(sql, params));
		return reader.getRowObjects().map((row) => this.normalizeRow(row));
	}

	private async requireConnection(): Promise<DuckDbConnection> {
		const connection = await this.getDuckDbConnection();
		if (!connection) {
			throw new Error('Cannot connect to database');
		}
		return connection;
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
				`SELECT table_schema, table_name FROM information_schema.tables
				 WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
				 ORDER BY table_schema <> 'main', table_schema, table_name`
			);
			this.tableParts.clear();
			return rows.map((row) => {
				const schema = String(row.table_schema);
				const name = String(row.table_name);
				const listed = schema === 'main' ? name : `${schema}.${name}`;
				this.tableParts.set(listed, { schema, name });
				return listed;
			});
		} catch (err) {
			reportError(`DuckDB get tables error: ${err}`);
			return [];
		}
	}

	async getTableCreationSql(table: string): Promise<string> {
		try {
			const rows = await this.query(
				`SELECT sql FROM duckdb_tables() WHERE schema_name = $1 AND table_name = $2`,
				[this.partsOf(table).schema, this.partsOf(table).name]
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

			const rawColumns = await this.query(`PRAGMA table_info(${this.tableRef(table)})`) as unknown as TableColumn[];

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
				 WHERE schema_name = $1 AND table_name = $2 AND constraint_type = 'FOREIGN KEY'`,
				[this.partsOf(table).schema, this.partsOf(table).name]
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

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>, signal?: AbortSignal): Promise<number> {
		try {
			let sql = `SELECT COUNT(*) AS count FROM ${this.tableRef(table)}`;
			const params: any[] = [];

			if (whereClause && Object.keys(whereClause).length > 0) {
				const { whereString, whereParams } = this.buildWhereClause(whereClause, columns, params.length);
				if (whereString.trim()) {
					sql += ` WHERE ${whereString}`;
					params.push(...whereParams);
				}
			}

			const isDataFileView = this.dataFile?.viewName === table;
			const cacheKey = `${sql}\u0000${JSON.stringify(params)}`;
			const cached = isDataFileView ? this.dataFileCountCache.get(cacheKey) : undefined;
			if (cached !== undefined) {
				return cached;
			}

			const rows = await this.query(sql, params, signal);
			const count = rows.length ? Number(rows[0].count) : 0;
			if (isDataFileView) {
				this.dataFileCountCache.set(cacheKey, count);
			}
			return count;
		} catch (err) {
			reportError(`DuckDB get total rows error: ${err}`);
			return 0;
		}
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>, signal?: AbortSignal): Promise<QueryResponse | undefined> {
		try {
			const columnNames = columns.map((col) => this.escapeIdentifier(col.name)).join(', ');
			let sql = `SELECT ${columnNames} FROM ${this.tableRef(table)}`;
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

			const rows = await this.query(sql, params, signal);
			return { rows, sql };
		} catch (err) {
			reportError(`DuckDB get rows error: ${err}`);
			return undefined;
		}
	}

	/**
	 * Runs `SUMMARIZE <table>` and returns the per-column statistics rows
	 * (min/max/approx_unique/avg/std/percentiles/null_percentage/…).
	 *
	 * - Tables above {@link SUMMARIZE_SAMPLE_THRESHOLD} rows are summarized
	 *   from a system sample of about {@link SUMMARIZE_SAMPLE_ROWS} rows.
	 * - When SUMMARIZE fails for the table (e.g. `Overflow in HUGEINT
	 *   addition` in `avg`), each column is summarized alone, and a column that
	 *   still fails gets min/max/approx_unique/count/null_percentage only.
	 *
	 * When a sample or a fallback is used, every row gets a `note` column that
	 * says so. A cancel (via `signal`) rejects instead of returning rows.
	 */
	async summarize(table: string, signal?: AbortSignal): Promise<Record<string, any>[]> {
		const rowCount = await this.getTotalRows(table, [], undefined, signal);
		const sampled = rowCount > SUMMARIZE_SAMPLE_THRESHOLD;
		const source = sampled
			? `(SELECT * FROM ${this.tableRef(table)} USING SAMPLE ${Math.min(100, Math.ceil((SUMMARIZE_SAMPLE_ROWS / rowCount) * 100))}% (system))`
			: this.tableRef(table);
		const sampleNote = sampled ? `Sampled about ${SUMMARIZE_SAMPLE_ROWS.toLocaleString('en-US')} of ${rowCount.toLocaleString('en-US')} rows` : '';

		try {
			const rows = await this.query(`SUMMARIZE SELECT * FROM ${source}`, [], signal);
			return sampleNote ? rows.map((row) => ({ ...row, note: sampleNote })) : rows;
		} catch (err) {
			if (signal?.aborted) {
				throw err;
			}
			// Expected fallback (e.g. HUGEINT overflow): each column row carries a note, so no toast.
			console.warn(`DuckDB summarize failed, summarizing per column: ${err}`);
		}

		const columns = await this.getColumns(table);
		const rows: Record<string, any>[] = [];
		for (const column of columns) {
			rows.push(await this.summarizeColumn(source, column, signal));
		}

		return rows.map((row) => ({ ...row, note: [sampleNote, row.note].filter(Boolean).join('; ') }));
	}

	private async summarizeColumn(source: string, column: Column, signal?: AbortSignal): Promise<Record<string, any>> {
		const name = this.escapeIdentifier(column.name);

		try {
			const [row] = await this.query(`SUMMARIZE SELECT ${name} FROM ${source}`, [], signal);
			return { ...row, note: '' };
		} catch (err) {
			if (signal?.aborted) {
				throw err;
			}

			const summary: Record<string, any> = Object.fromEntries(SUMMARIZE_COLUMNS.map((key) => [key, null]));
			summary.column_name = column.name;
			summary.column_type = column.type;

			try {
				const [basic] = await this.query(
					`SELECT min(${name})::VARCHAR AS min, max(${name})::VARCHAR AS max,
					        approx_count_distinct(${name}) AS approx_unique, count(*) AS count,
					        round(100.0 * count_if(${name} IS NULL) / nullif(count(*), 0), 2)::VARCHAR AS null_percentage
					 FROM ${source}`,
					[],
					signal
				);
				Object.assign(summary, basic);
				summary.note = `avg/std/quantiles unavailable: ${this.firstLine(err)}`;
			} catch (basicErr) {
				if (signal?.aborted) {
					throw basicErr;
				}
				summary.note = `SUMMARIZE failed: ${this.firstLine(basicErr)}`;
			}

			return summary;
		}
	}

	private firstLine(err: unknown): string {
		return String(err instanceof Error ? err.message : err).split('\n')[0];
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
			sql = `UPDATE ${this.tableRef(table)}
			       SET ${this.escapeIdentifier(mutation.column.name)} = $1
			       WHERE ${this.escapeIdentifier(primaryKeyColumn)} = $2`;
			params = [this.transformValueForDuckDb(mutation.newValue), primaryKey];
		} else if (type === 'row-delete') {
			sql = `DELETE FROM ${this.tableRef(table)} WHERE ${this.escapeIdentifier(primaryKeyColumn)} = $1`;
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

	/**
	 * Runs arbitrary SQL. Row results are streamed and cut at
	 * {@link RAW_QUERY_MAX_ROWS}; a cut result has `truncated: true`.
	 *
	 * With `options.readOnly`, only one statement is accepted and it must
	 * prepare as a SELECT (or a plain EXPLAIN). COPY/ATTACH/INSTALL/LOAD/SET/
	 * PRAGMA/EXPORT and similar are refused by keyword. File, network and
	 * extension access are off for every query (see {@link lockDown}).
	 */
	async rawQuery(code: string, options?: { readOnly?: boolean; signal?: AbortSignal }): Promise<any> {
		try {
			const connection = await this.requireConnection();

			if (options?.readOnly) {
				return await this.runReadOnly(connection, code, options.signal);
			}

			const isReadQuery = /^\s*(SELECT|PRAGMA|WITH|SHOW|DESCRIBE|EXPLAIN|CALL|VALUES|FROM|TABLE|SUMMARIZE|PIVOT|UNPIVOT)\b/i.test(code);

			if (isReadQuery) {
				const reader = await this.withInterrupt(connection, options?.signal, () => connection.streamAndReadUntil(code, RAW_QUERY_MAX_ROWS + 1));
				return this.capRows(reader);
			}

			await this.withInterrupt(connection, options?.signal, () => connection.run(code));
			return { changes: 0 };
		} catch (err) {
			reportError(`DuckDB run arbitrary query error: ${err}`);
			throw err;
		}
	}

	private async runReadOnly(connection: DuckDbConnection, code: string, signal?: AbortSignal): Promise<DuckDbRawQueryRows> {
		const keyword = firstKeyword(code);
		if (READ_ONLY_BLOCKED_KEYWORDS.includes(keyword)) {
			throw new Error(`${keyword} is not allowed in read-only mode`);
		}

		const extracted = await connection.extractStatements(code);
		if (extracted.count !== 1) {
			throw new Error('Read-only mode accepts exactly one statement');
		}

		const prepared = await extracted.prepare(0);
		try {
			const isPlainExplain = prepared.statementType === STATEMENT_TYPE_EXPLAIN && !/^EXPLAIN\s+ANALY[SZ]E\b/i.test(stripSqlComments(code).trim());
			if (prepared.statementType !== STATEMENT_TYPE_SELECT && !isPlainExplain) {
				throw new Error('Read-only mode accepts only SELECT statements');
			}

			const reader = await this.withInterrupt(connection, signal, () => prepared.streamAndReadUntil(RAW_QUERY_MAX_ROWS + 1));
			return this.capRows(reader);
		} finally {
			prepared.destroySync?.();
		}
	}

	private capRows(reader: DuckDbResultReader): DuckDbRawQueryRows {
		const allRows = reader.getRowObjects();
		const rows: DuckDbRawQueryRows = allRows.slice(0, RAW_QUERY_MAX_ROWS).map((row) => this.normalizeRow(row));
		if (allRows.length > RAW_QUERY_MAX_ROWS) {
			rows.truncated = true;
		}
		return rows;
	}

	private buildWhereClause(whereClause: Record<string, any>, columns: Column[], paramOffset: number): { whereString: string; whereParams: any[] } {
		const wheres: string[] = [];
		const whereParams: any[] = [];

		const clause = buildWhereClause(this, 'sqlite3', whereClause, columns);

		clause.forEach((entry) => {
			const column = entry.useRawCast ? `CAST(${this.escapeIdentifier(entry.column)} AS VARCHAR)` : this.escapeIdentifier(entry.column);
			wheres.push(`${column} ${entry.operator} $${paramOffset + whereParams.length + 1}`);
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
			return this.blobPreview(value);
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
			/**
			 * DuckDB value classes are matched by shape, not constructor name,
			 * because the production bundle may rename classes.
			 */

			/** LIST/ARRAY values wrap their elements in an `items` array. */
			if (Array.isArray(value.items)) {
				return (value.items as any[]).map((item) => this.normalizeValue(item));
			}

			/** MAP values hold `{ key, value }` pairs in an `entries` array. */
			if (Array.isArray(value.entries)) {
				const out: Record<string, any> = {};
				for (const entry of value.entries as { key: any; value: any }[]) {
					const key = this.normalizeValue(entry.key);
					out[typeof key === 'string' ? key : JSON.stringify(key)] = this.normalizeValue(entry.value);
				}
				return out;
			}

			/** STRUCT values expose their fields under an `entries` object. */
			if (value.entries && typeof value.entries === 'object') {
				const out: Record<string, any> = {};
				for (const [key, entryValue] of Object.entries(value.entries)) {
					out[key] = this.normalizeValue(entryValue);
				}
				return out;
			}

			/** UNION values carry the active member as `{ tag, value }`. */
			if (typeof value.tag === 'string' && 'value' in value) {
				return this.normalizeValue(value.value);
			}

			/** BLOB values: hex preview of the first bytes plus the total size. */
			if (value.bytes instanceof Uint8Array) {
				return this.blobPreview(value.bytes);
			}

			/**
			 * Scalar value classes (DECIMAL, UUID, DATE, TIME, TIMESTAMP[TZ],
			 * INTERVAL, BIT, BIGNUM, …) render with DuckDB's own text form via
			 * toString(). Walking their fields instead would show internals such
			 * as `{ width, scale, value }` for a DECIMAL.
			 */
			if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
				return String(value);
			}

			if (typeof value.toJSON === 'function') {
				return this.normalizeValue(value.toJSON());
			}

			const out: Record<string, any> = {};
			for (const [key, entryValue] of Object.entries(value)) {
				out[key] = this.normalizeValue(entryValue);
			}
			return out;
		}

		return value;
	}

	private blobPreview(bytes: Uint8Array): string {
		const hex = Buffer.from(bytes.subarray(0, BLOB_PREVIEW_BYTES)).toString('hex').toUpperCase();
		return bytes.length > BLOB_PREVIEW_BYTES
			? `0x${hex}… (${bytes.length} bytes)`
			: `0x${hex}`;
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

	private partsOf(table: string): { schema: string, name: string } {
		return this.tableParts.get(table) ?? { schema: 'main', name: table };
	}

	/** Quoted, schema-qualified reference for a table name returned by getTables(). */
	private tableRef(table: string): string {
		const { schema, name } = this.partsOf(table);
		return `${this.escapeIdentifier(schema)}.${this.escapeIdentifier(name)}`;
	}

	private escapeIdentifier(identifier: string): string {
		return `"${identifier.replace(/"/g, '""')}"`;
	}

	destroy(): void { }
}

function stripSqlComments(sql: string): string {
	return sql
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/--[^\n]*/g, ' ');
}

/** Upper-cased first keyword of a statement, skipping comments, whitespace and `(`. */
function firstKeyword(sql: string): string {
	const stripped = stripSqlComments(sql).replace(/^[\s(]+/, '');
	return (stripped.match(/^[A-Za-z_]+/)?.[0] ?? '').toUpperCase();
}
