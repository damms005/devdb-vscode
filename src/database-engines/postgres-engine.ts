import knexlib from "knex";
import { Column, DatabaseEngine, KnexClient, QueryResponse, RawQueryOptions, RawQueryResultWithMeta, SerializedMutation } from '../types';
import { SqlService, assertReadOnlySql, sanitizeIdentifier, stripSqlCommentsAndLiterals } from '../services/sql';
import { reportError } from "../services/initialization-error-service";

export class PostgresEngine implements DatabaseEngine {
	public connection: knexlib.Knex | null = null;

	constructor(connector: knexlib.Knex) {
		this.connection = connector;
	}

	getType(): KnexClient {
		return 'postgres';
	}

	getConnection(): knexlib.Knex | null {
		return this.connection
	}

	async isOkay(): Promise<boolean> {
		if (!this.connection) return false;

		try {
			await this.connection.raw('SELECT VERSION()');
			return true;
		} catch (error) {
			reportError(`PostgreSQL OK-check error: ${error}`);
			return false;
		}
	}

	async disconnect(): Promise<void> {
		if (this.connection) this.connection.destroy(() => null);
	}

	async getTableCreationSql(table: string): Promise<string> {
		if (!this.connection) {
			throw new Error('Not connected to the database');
		}

		const { schemaName, tableName } = getTableSchema(table);

		const tableCreationSql = await this.connection.raw(`
        SELECT
            'CREATE TABLE ' || quote_ident(table_schema) || '.' || quote_ident(table_name) || ' (' ||
            string_agg(column_name || ' ' ||
                       CASE
                           WHEN data_type = 'character varying' THEN
                               'character varying(' || character_maximum_length || ')'
                           ELSE
                               data_type
                       END, ', ' ORDER BY ordinal_position) ||
            ');' AS create_sql
        FROM
            information_schema.columns
        WHERE
            table_name = ? AND table_schema = ?
        GROUP BY
            table_name, table_schema
    `, [tableName, schemaName]) as any;

		const sql = tableCreationSql.rows[0]?.create_sql || '';

		try {
			const { format } = await import('sql-formatter')

			const formattedSql = format(sql, {
				language: 'sqlite',
				tabWidth: 2,
				keywordCase: 'upper',
			});

			return formattedSql
		} catch (formatErr) {
			reportError(`PostgreSQL formatting error: ${formatErr}`);

			return sql
		}
	}

	async getTables(): Promise<string[]> {
		if (!this.connection) {
			throw new Error('Not connected to the database');
		}

		const tables = await this.connection('pg_catalog.pg_tables')
			.whereNotIn('schemaname', ['pg_catalog', 'information_schema'])
			.select([`tablename`, `schemaname`]);

		return tables.map(getTableName);
	}

	async getColumns(table: string): Promise<Column[]> {
		if (!this.connection) {
			throw new Error('Not connected to the database');
		}

		const { schemaName, tableName } = getTableSchema(table);

		type TableColumn = { "type": string, name: string, ordinal_position: number, is_nullable: string, udt_name: string }

		const columns: TableColumn[] = await this.connection('information_schema.columns')
			.whereRaw("LOWER(table_name) = LOWER(?)", [tableName])
			.whereRaw("LOWER(table_schema) = LOWER(?)", [schemaName])
			.select(['column_name AS name', 'data_type AS type', 'udt_name', 'ordinal_position', 'is_nullable']) as any[];

		const vectorDimensions = await this.getVectorColumnDimensions(schemaName, tableName);

		const editableColumnTypeNamesLowercase = this.getEditableColumnTypeNamesLowercase()

		const primaryKeyResult = await this.connection('information_schema.table_constraints as tc')
			.join('information_schema.key_column_usage as kcu', 'tc.constraint_name', 'kcu.constraint_name')
			.where('tc.constraint_type', 'PRIMARY KEY')
			.andWhereRaw('LOWER(tc.table_name) = LOWER(?)', [tableName])
			.andWhereRaw('LOWER(tc.table_schema) = LOWER(?)', [schemaName])
			.select('kcu.column_name');
		const primaryKeySet = new Set(primaryKeyResult.map(row => row.column_name.toLowerCase()));

		const computedColumns: Column[] = [];

		for (const column of columns) {
			const foreignKey = await getForeignKeyFor(table, column.name, this.connection);

			const udtName = column.udt_name?.toLowerCase();
			const isVector = udtName === 'vector';

			if (isVector) {
				const dimension = vectorDimensions[column.name.toLowerCase()];
				const type = dimension && dimension > 0 ? `vector(${dimension})` : 'vector';

				computedColumns.push({
					...{
						name: column.name,
						type,
						isPrimaryKey: primaryKeySet.has(column.name.toLowerCase()),
						isNumeric: false,
						isPlainTextType: false,
						isNullable: column.is_nullable === 'YES',
						isEditable: false,
						foreignKey
					},
					ordinal_position: column.ordinal_position
				} as Column & { ordinal_position: number });

				continue;
			}

			// Surface opaque extension types (halfvec, sparsevec, PostGIS) by their real
			// name instead of 'USER-DEFINED', so filters and editors can recognise them.
			const type = column.type === 'USER-DEFINED' && udtName && OPAQUE_USER_DEFINED_TYPES.includes(udtName)
				? udtName
				: column.type;

			computedColumns.push({
				...{
					name: column.name,
					type,
					isPrimaryKey: primaryKeySet.has(column.name.toLowerCase()),
					isNumeric: this.getNumericColumnTypeNamesLowercase().includes(column.type.toLowerCase()),
					isPlainTextType: this.getPlainStringTypes().includes(column.type.toLowerCase()),
					isNullable: column.is_nullable === 'YES',
					isEditable: editableColumnTypeNamesLowercase.includes(column.type.toLowerCase()) || editableColumnTypeNamesLowercase.some(edtiableColumn => column.type.toLowerCase().startsWith(edtiableColumn)),
					foreignKey
				},
				// add a temporary property for sorting via type assertion
				ordinal_position: column.ordinal_position
			} as Column & { ordinal_position: number });
		}

		// Sort columns by their ordinal position in the table
		computedColumns.sort((a: any, b: any) => a.ordinal_position - b.ordinal_position);

		// Remove the temporary ordinal_position property
		for (const column of computedColumns) {
			delete (column as any).ordinal_position;
		}

		return computedColumns;
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return ['smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision'];
	}

	getEditableColumnTypeNamesLowercase(): string[] {
		const numericTypes = this.getNumericColumnTypeNamesLowercase();
		const stringTypes = this.getPlainStringTypes();
		return [...numericTypes, ...stringTypes];
	}

	getPlainStringTypes(): string[] {
		return ['character', 'character varying', 'text', 'json', 'jsonb'];
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		return SqlService.getTotalRows(this, 'postgres', this.connection, table, columns, whereClause);
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return SqlService.getRows(this, 'postgres', this.connection, table, columns, limit, offset, whereClause);
	}

	async getVersion(): Promise<string | undefined> {
		return undefined
	}

	async commitChange(serializedMutation: SerializedMutation, transaction: knexlib.Knex.Transaction): Promise<void> {
		await SqlService.commitChange(this.connection, serializedMutation, transaction, '"');
	}

	/**
	 * Runs arbitrary SQL and returns the result rows. With `readOnly`, the statement must
	 * pass {@link assertReadOnlySql} and runs inside `BEGIN TRANSACTION READ ONLY` over the
	 * extended protocol (which rejects stacked statements server-side), then rolls back.
	 */
	async rawQuery(code: string, options?: RawQueryOptions): Promise<any> {
		if (!this.connection) throw new Error('Connection not initialized');

		if (!options?.readOnly) {
			const result = await this.connection.raw(code) as any;
			if (options?.withMeta) {
				return withMeta(Array.isArray(result) ? result[result.length - 1] : result);
			}
			// several statements yield one result per statement
			return Array.isArray(result) ? result.map(entry => entry.rows) : result.rows;
		}

		assertReadOnlySql(code, 'postgres', POSTGRES_READ_ONLY_KEYWORDS, POSTGRES_READ_ONLY_DENIED_PATTERNS);

		return this.runReadOnly(async (trx) => {
			const result = await trx.raw(code).options({ queryMode: 'extended' }) as any;
			return options?.withMeta ? withMeta(result) : result.rows;
		});
	}

	/**
	 * Runs `work` inside a `READ ONLY` transaction that is always rolled back, so nothing it
	 * does can persist even if a write slipped past validation.
	 */
	private async runReadOnly<T>(work: (trx: knexlib.Knex.Transaction) => Promise<T>): Promise<T> {
		if (!this.connection) throw new Error('Connection not initialized');

		const trx = await this.connection.transaction({ readOnly: true });
		try {
			return await work(trx);
		} finally {
			await trx.rollback();
		}
	}

	/**
	 * Returns a map of lowercased column name to its pgvector dimension for a table.
	 * pgvector stores the declared dimension directly in `pg_attribute.atttypmod`
	 * (e.g. `vector(1536)` => 1536), or -1 when the dimension was left unspecified.
	 *
	 * @returns {Promise<Record<string, number>>}
	 */
	async getVectorColumnDimensions(schemaName: string, tableName: string): Promise<Record<string, number>> {
		if (!this.connection) {
			throw new Error('Not connected to the database');
		}

		try {
			const result = await this.connection.raw(`
				SELECT a.attname AS name, a.atttypmod AS dimension
				FROM pg_attribute a
				JOIN pg_class c ON c.oid = a.attrelid
				JOIN pg_namespace n ON n.oid = c.relnamespace
				JOIN pg_type t ON t.oid = a.atttypid
				WHERE LOWER(c.relname) = LOWER(?)
					AND LOWER(n.nspname) = LOWER(?)
					AND t.typname = 'vector'
					AND a.attnum > 0
					AND NOT a.attisdropped
			`, [tableName, schemaName]) as any;

			const dimensions: Record<string, number> = {};
			for (const row of result.rows) {
				dimensions[String(row.name).toLowerCase()] = Number(row.dimension);
			}

			return dimensions;
		} catch (error) {
			reportError(`PostgreSQL vector dimension lookup error: ${error}`);
			return {};
		}
	}

	/**
	 * Runs a pgvector nearest-neighbour search against `column`, ordered ascending
	 * by the chosen distance operator. The reference may be a raw vector (array or
	 * `[..]` literal string), an already-embedded `rawVector`, or the primary key
	 * value of an existing row to compare against ("more like this row").
	 *
	 * Each returned row carries a numeric `_distance` (the operator value) plus a
	 * `_similarity` (1 - distance for cosine, negated inner product for ip, `NULL`
	 * for l2/l1). The metric defaults to the ANN index opclass, else cosine.
	 *
	 * @returns rows plus display-safe SQL, resolved metric/operator, scan plan and warnings.
	 */
	async vectorSimilaritySearch(options: {
		table: string,
		column: string,
		reference?: number[] | string | number,
		rawVector?: number[],
		metric?: VectorMetric,
		limit?: number,
		where?: string,
		efSearch?: number,
	}): Promise<{ rows: any[], sql: string, operator: string, metric: string, scoreLabel: string, queryDimension?: number, scan?: { type: 'index' | 'seq', indexName?: string, indexType?: string }, warnings: string[] } | undefined> {
		if (!this.connection) {
			throw new Error('Not connected to the database');
		}

		const { schemaName, tableName } = getTableSchema(options.table);
		const quotedTable = `${sanitizeIdentifier(schemaName, '"', '"')}.${sanitizeIdentifier(tableName, '"', '"')}`;
		const quotedColumn = sanitizeIdentifier(options.column, '"', '"');
		const safeLimit = Math.max(1, Math.min(1000, Math.trunc(Number(options.limit) || 10)));
		const whereClause = options.where && options.where.trim().length > 0 ? `WHERE ${assertSafeWhereFragment(options.where)}` : '';

		const metric: VectorMetric = options.metric ?? (await this.getVectorIndexOpclass(options.table, options.column)) ?? 'cosine';
		const { operator, scoreLabel } = getMetricDefinition(metric);
		const warnings: string[] = [];

		if (metric === 'ip') {
			warnings.push('Inner product (<#>) returns the negative inner product; _similarity is negated to restore the intuitive sign.');
		}

		const parsed = parseVectorReference(options.rawVector, options.reference);

		try {
			if (parsed.literal !== undefined) {
				const queryDimension = parsed.dimension;
				const columnDimensions = await this.getVectorColumnDimensions(schemaName, tableName);
				const columnDimension = columnDimensions[options.column.toLowerCase()];

				if (queryDimension !== undefined && queryDimension > 0 && columnDimension !== undefined && columnDimension > 0 && queryDimension !== columnDimension) {
					return {
						rows: [],
						sql: '',
						operator,
						metric,
						scoreLabel,
						queryDimension,
						warnings: [`Query vector has ${queryDimension} dimensions but column is vector(${columnDimension}) — cannot search`],
					};
				}

				const similaritySelect = getSimilaritySelect(metric, quotedColumn, '?::vector', operator);
				const runSql = `SELECT *, (${quotedColumn} ${operator} ?::vector) AS _distance, ${similaritySelect} AS _similarity FROM ${quotedTable} ${whereClause} ORDER BY ${quotedColumn} ${operator} ?::vector LIMIT ${safeLimit}`;
				const bindings = [parsed.literal, ...(metric === 'cosine' || metric === 'ip' ? [parsed.literal] : []), parsed.literal];

				const rows = await this.runSearch(runSql, bindings, options.efSearch);
				const scan = await this.detectScan(options.table, options.column, runSql, bindings);
				if (scan?.type === 'seq') {
					warnings.push('Sequential scan — results are exact but may be slow on large tables; a production ANN index for this metric may return different (approximate) rows.');
				}

				const displaySql = runSql.split('?::vector').join(truncateVectorLiteral(parsed.dimension));
				return { rows, sql: displaySql, operator, metric, scoreLabel, queryDimension, scan, warnings };
			}

			if (parsed.pkValue === undefined) {
				throw new Error('No vector or reference row provided for similarity search');
			}

			const columns = await this.getColumns(options.table);
			const primaryKeyColumn = columns.find(candidate => candidate.isPrimaryKey)?.name;
			if (!primaryKeyColumn) {
				throw new Error(`Cannot resolve reference row: table ${options.table} has no primary key`);
			}
			const quotedPrimaryKey = sanitizeIdentifier(primaryKeyColumn, '"', '"');

			const similaritySelect = getSimilaritySelect(metric, `t.${quotedColumn}`, 'ref.v', operator);
			const runSql = `SELECT t.*, (t.${quotedColumn} ${operator} ref.v) AS _distance, ${similaritySelect} AS _similarity FROM ${quotedTable} t CROSS JOIN (SELECT ${quotedColumn} AS v FROM ${quotedTable} WHERE ${quotedPrimaryKey} = ? LIMIT 1) ref ${whereClause} ORDER BY t.${quotedColumn} ${operator} ref.v LIMIT ${safeLimit}`;
			const bindings = [parsed.pkValue];

			const rows = await this.runSearch(runSql, bindings, options.efSearch);
			const scan = await this.detectScan(options.table, options.column, runSql, bindings);
			if (scan?.type === 'seq') {
				warnings.push('Sequential scan — results are exact but may be slow on large tables; a production ANN index for this metric may return different (approximate) rows.');
			}

			const displaySql = runSql.replace('?', String(parsed.pkValue));
			return { rows, sql: displaySql, operator, metric, scoreLabel, scan, warnings };
		} catch (error) {
			reportError(`PostgreSQL vector similarity search error: ${error}`);
			return;
		}
	}

	/**
	 * Executes the search SQL inside a READ ONLY transaction (the SQL embeds a
	 * user-supplied `where` fragment), issuing `SET LOCAL hnsw.ef_search` first when an
	 * efSearch value is supplied (SET LOCAL only takes effect inside a transaction).
	 */
	private async runSearch(sql: string, bindings: any[], efSearch?: number): Promise<any[]> {
		const efInt = Math.trunc(Number(efSearch) || 0);

		return this.runReadOnly(async (trx) => {
			if (efInt > 0) {
				await trx.raw(`SET LOCAL hnsw.ef_search = ${efInt}`);
			}
			const result = await trx.raw(sql, bindings) as any;
			return result.rows;
		});
	}

	/**
	 * Runs `EXPLAIN (FORMAT JSON)` for the search and reports whether the planner
	 * chose an ANN (hnsw/ivfflat) index scan or a sequential scan. Never throws —
	 * on failure it returns undefined so the search itself is unaffected.
	 */
	private async detectScan(table: string, column: string, sql: string, bindings: any[]): Promise<{ type: 'index' | 'seq', indexName?: string, indexType?: string } | undefined> {
		if (!this.connection) {
			return undefined;
		}

		try {
			const annIndexes = await this.getVectorIndexes(table, column);
			const annIndexByName = new Map(annIndexes.map(index => [index.indexName, index.indexType]));

			const explain = await this.runReadOnly(async (trx) => await trx.raw(`EXPLAIN (FORMAT JSON) ${sql}`, bindings) as any);
			const plan = explain.rows[0]['QUERY PLAN'];
			const rootPlan = Array.isArray(plan) ? plan[0]?.Plan : plan?.Plan;

			const indexHit = findIndexScanNode(rootPlan, annIndexByName);
			if (indexHit) {
				return { type: 'index', indexName: indexHit.indexName, indexType: indexHit.indexType };
			}

			return { type: 'seq' };
		} catch (error) {
			reportError(`PostgreSQL vector EXPLAIN error: ${error}`);
			return undefined;
		}
	}

	/**
	 * Reads the opclass of any ANN index on the column to pick a sensible default
	 * metric: `vector_ip_ops` => ip, `vector_l1_ops` => l1, `vector_l2_ops` => l2,
	 * `vector_cosine_ops` (or none) => cosine.
	 *
	 * @returns {Promise<VectorMetric | undefined>} the matched metric, or undefined when no ANN index exists.
	 */
	async getVectorIndexOpclass(table: string, column: string): Promise<VectorMetric | undefined> {
		const indexes = await this.getVectorIndexes(table, column);

		for (const index of indexes) {
			const definition = index.definition.toLowerCase();
			if (definition.includes('vector_ip_ops')) {
				return 'ip';
			}
			if (definition.includes('vector_l1_ops')) {
				return 'l1';
			}
			if (definition.includes('vector_l2_ops')) {
				return 'l2';
			}
			if (definition.includes('vector_cosine_ops')) {
				return 'cosine';
			}
		}

		return undefined;
	}

	/**
	 * Returns any pgvector ANN indexes (ivfflat/hnsw) defined on the table,
	 * optionally filtered to a single column, for surfacing index health.
	 *
	 * @returns {Promise<Array<{ indexName: string, indexType: string, definition: string }>>}
	 */
	async getVectorIndexes(table: string, column?: string): Promise<Array<{ indexName: string, indexType: string, definition: string }>> {
		if (!this.connection) {
			throw new Error('Not connected to the database');
		}

		const { schemaName, tableName } = getTableSchema(table);

		try {
			const result = await this.connection.raw(`
				SELECT i.relname AS index_name, am.amname AS index_type, pg_get_indexdef(i.oid) AS definition
				FROM pg_class t
				JOIN pg_namespace n ON n.oid = t.relnamespace
				JOIN pg_index ix ON ix.indrelid = t.oid
				JOIN pg_class i ON i.oid = ix.indexrelid
				JOIN pg_am am ON am.oid = i.relam
				WHERE LOWER(t.relname) = LOWER(?)
					AND LOWER(n.nspname) = LOWER(?)
					AND am.amname IN ('ivfflat', 'hnsw')
			`, [tableName, schemaName]) as any;

			return result.rows
				.filter((row: any) => !column || String(row.definition).toLowerCase().includes(String(column).toLowerCase()))
				.map((row: any) => ({
					indexName: row.index_name,
					indexType: row.index_type,
					definition: row.definition,
				}));
		} catch (error) {
			reportError(`PostgreSQL vector index lookup error: ${error}`);
			return [];
		}
	}
}

const OPAQUE_USER_DEFINED_TYPES = ['halfvec', 'sparsevec', 'geometry', 'geography'];

/** Type names for the built-in type OIDs that query results report most often. */
const POSTGRES_TYPE_NAMES: Record<number, string> = {
	16: 'boolean', 17: 'bytea', 18: 'char', 19: 'name', 20: 'bigint', 21: 'smallint', 23: 'integer', 25: 'text', 26: 'oid',
	114: 'json', 142: 'xml', 650: 'cidr', 700: 'real', 701: 'double', 790: 'money', 829: 'macaddr', 869: 'inet',
	1042: 'char', 1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval',
	1266: 'timetz', 1560: 'bit', 1562: 'varbit', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb',
	1000: 'boolean[]', 1005: 'smallint[]', 1007: 'integer[]', 1009: 'text[]', 1015: 'varchar[]', 1016: 'bigint[]',
	1021: 'real[]', 1022: 'double[]', 1231: 'numeric[]', 2951: 'uuid[]', 3807: 'jsonb[]',
};

function withMeta(result: { rows?: Record<string, unknown>[], fields?: { name: string, dataTypeID?: number }[], rowCount?: number | null, command?: string }): RawQueryResultWithMeta {
	const command = result.command?.toUpperCase();
	return {
		rows: result.rows ?? [],
		columns: (result.fields ?? []).map(field => field.name),
		columnTypes: (result.fields ?? []).map(field => POSTGRES_TYPE_NAMES[field.dataTypeID ?? -1]),
		affectedRows: command && command !== 'SELECT' && typeof result.rowCount === 'number' ? result.rowCount : undefined,
		command,
	};
}

const POSTGRES_READ_ONLY_KEYWORDS = ['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'TABLE', 'VALUES'];

/**
 * Functions with side effects outside the transaction (server files, other sessions,
 * remote servers, config) that a READ ONLY transaction does not stop.
 */
const POSTGRES_READ_ONLY_DENIED_PATTERNS = [
	/\b(lo_import|lo_export|lo_unlink|lo_from_bytea|lo_put|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_switch_wal|pg_create_restore_point|pg_file_write|pg_file_rename|pg_file_unlink|pg_notify|set_config|dblink\w*|pg_advisory\w*|pg_try_advisory\w*)\s*\(/i,
];

/**
 * Validates a user-supplied SQL `WHERE` fragment for similarity search: no statement
 * separators and no comments that could hide a second statement. The fragment still
 * runs inside a READ ONLY transaction.
 */
function assertSafeWhereFragment(where: string): string {
	const trimmed = where.trim();
	const stripped = stripSqlCommentsAndLiterals(trimmed, 'postgres');

	if (stripped.includes(';')) {
		throw new Error('The similarity search filter must not contain ";"');
	}

	for (const pattern of POSTGRES_READ_ONLY_DENIED_PATTERNS) {
		const match = stripped.match(pattern);
		if (match) {
			throw new Error(`The similarity search filter must not use "${match[0].trim()}"`);
		}
	}

	return trimmed;
}

function getTableName(table: { schemaname: string, tablename: string }) {
	return table.schemaname === 'public' 
			? table.tablename 
			: `${table.schemaname}.${table.tablename}`;
}

function getTableSchema(table: string): { schemaName: string, tableName: string } {
	let schemaName = 'public';
	let tableName = table;

	if (tableName.includes('.')) {
		const parts = tableName.split('.');
		schemaName = parts[0];
		tableName = parts[1];
	}

	return { schemaName, tableName };
}

export type VectorMetric = 'cosine' | 'l2' | 'ip' | 'l1';

/**
 * Maps a metric to its pgvector distance operator and a human-friendly score label.
 */
function getMetricDefinition(metric: VectorMetric): { operator: string, scoreLabel: string } {
	switch (metric) {
		case 'l2':
			return { operator: '<->', scoreLabel: 'L2 distance' };
		case 'ip':
			return { operator: '<#>', scoreLabel: 'inner product' };
		case 'l1':
			return { operator: '<+>', scoreLabel: 'L1 distance' };
		case 'cosine':
		default:
			return { operator: '<=>', scoreLabel: 'cosine similarity' };
	}
}

/**
 * Builds the SQL expression for the interpretable `_similarity` value per metric:
 * cosine => `1 - distance`, ip => negated inner product, l2/l1 => `NULL`
 * (unbounded distances have no bounded similarity, so the UI shows distance instead).
 */
function getSimilaritySelect(metric: VectorMetric, columnExpr: string, vectorExpr: string, operator: string): string {
	if (metric === 'cosine') {
		return `1 - (${columnExpr} ${operator} ${vectorExpr})`;
	}

	if (metric === 'ip') {
		return `-(${columnExpr} ${operator} ${vectorExpr})`;
	}

	return 'NULL';
}

/**
 * Resolves the caller-supplied reference into either a pgvector literal string
 * (`[a,b,c]`, with its dimension) or a primary-key value ("more like this row").
 * `rawVector` (already-embedded query text) takes precedence over `reference`.
 */
function parseVectorReference(
	rawVector: number[] | undefined,
	reference: number[] | string | number | undefined,
): { literal?: string, dimension?: number, pkValue?: string | number } {
	if (Array.isArray(rawVector)) {
		return { literal: `[${rawVector.join(',')}]`, dimension: rawVector.length };
	}

	if (Array.isArray(reference)) {
		return { literal: `[${reference.join(',')}]`, dimension: reference.length };
	}

	if (typeof reference === 'string' && reference.trim().startsWith('[')) {
		const literal = reference.trim();
		const inner = literal.slice(1, literal.lastIndexOf(']')).trim();
		const dimension = inner.length === 0 ? 0 : inner.split(',').length;
		return { literal, dimension };
	}

	if (reference !== undefined) {
		return { pkValue: reference as string | number };
	}

	return {};
}

/**
 * Produces a display-safe placeholder for a bound vector literal so generated SQL
 * shown to the user does not dump thousands of floats.
 */
function truncateVectorLiteral(dimension?: number): string {
	return dimension && dimension > 0 ? `[… ${dimension} dims …]` : '[…]';
}

/**
 * Recursively walks an EXPLAIN plan tree looking for an Index (Only) Scan that
 * uses one of the known ANN indexes; returns its name and type when found.
 */
function findIndexScanNode(
	node: any,
	annIndexByName: Map<string, string>,
): { indexName: string, indexType: string } | undefined {
	if (!node || typeof node !== 'object') {
		return undefined;
	}

	const nodeType = String(node['Node Type'] ?? '');
	const indexName = node['Index Name'];
	if (nodeType.includes('Index Scan') && indexName && annIndexByName.has(indexName)) {
		return { indexName, indexType: annIndexByName.get(indexName)! };
	}

	if (Array.isArray(node.Plans)) {
		for (const child of node.Plans) {
			const hit = findIndexScanNode(child, annIndexByName);
			if (hit) {
				return hit;
			}
		}
	}

	return undefined;
}

async function getForeignKeyFor(table: string, column: string, connection: knexlib.Knex): Promise<{ table: string, column: string } | undefined> {
	const { schemaName, tableName } = getTableSchema(table);

	type Fk = {
		referenced_table: string,
		referenced_column: string,
		referenced_schema: string,
	}

	const result = await connection.raw(`
			SELECT
					ccu.table_name AS referenced_table,
					ccu.column_name AS referenced_column,
					ccu.table_schema AS referenced_schema
			FROM
					information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu
					ON tc.constraint_name = kcu.constraint_name
					AND tc.table_schema = kcu.table_schema
			JOIN information_schema.constraint_column_usage ccu
					ON ccu.constraint_name = tc.constraint_name
			WHERE
					tc.constraint_type = 'FOREIGN KEY'
					AND kcu.table_name = LOWER(?)
					AND kcu.table_schema = LOWER(?)
					AND kcu.column_name = LOWER(?)
				`, [tableName, schemaName, column]);

	const foreignKeys: Fk[] = result.rows;
	if (foreignKeys.length === 0) return undefined;

	return {
		table: getTableName({ schemaname: foreignKeys[0].referenced_schema, tablename: foreignKeys[0].referenced_table }),
		column: foreignKeys[0].referenced_column as string
	};
}
