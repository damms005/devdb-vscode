/**
 * Defense-in-depth validator for queries that come in through MCP.
 * The engines enforce read-only at the database level (rawQuery `{ readOnly: true }`);
 * this layer rejects known-dangerous constructs before they reach the engine.
 */

export type QueryValidationResult = {
	allowed: boolean;
	warning?: string;
	/** True when the query writes or destroys data. Callers must confirm before they run it. */
	destructive?: boolean;
};

export type QueryValidationOptions = {
	/** When false (default), any query that is not a read is blocked. */
	allowWrites?: boolean;
};

/** Always blocked for every SQL engine, also when writes are allowed. */
const SQL_ALWAYS_BLOCKED: { pattern: RegExp, label: string }[] = [
	{ pattern: /^DROP\s+(DATABASE|SCHEMA)\b/i, label: 'DROP DATABASE/SCHEMA' },
	{ pattern: /^TRUNCATE\b/i, label: 'TRUNCATE' },
	// Postgres
	{ pattern: /^COPY\b/i, label: 'COPY' },
	{ pattern: /\bPROGRAM\s*'/i, label: 'COPY ... PROGRAM' },
	{ pattern: /\bpg_(read_file|read_binary_file|ls_dir|stat_file|write_file)\s*\(/i, label: 'server file access function' },
	{ pattern: /\blo_(import|export|from_bytea|put)\s*\(/i, label: 'large object function' },
	{ pattern: /\bdblink\w*\s*\(/i, label: 'dblink' },
	// ClickHouse
	{ pattern: /^SYSTEM\b/i, label: 'SYSTEM' },
	{ pattern: /^KILL\b/i, label: 'KILL' },
	{ pattern: /\bINSERT\s+INTO\s+(TABLE\s+)?FUNCTION\b/i, label: 'INSERT INTO FUNCTION' },
	{ pattern: /\b(file|url|s3|s3Cluster|remote|remoteSecure|hdfs|mysql|postgresql|jdbc|odbc|azureBlobStorage|gcs)\s*\(/i, label: 'table function' },
	// DuckDB (and generic)
	{ pattern: /^(ATTACH|DETACH|INSTALL|FORCE\s+INSTALL|LOAD|SET|RESET|PRAGMA|EXPORT|IMPORT)\b/i, label: 'engine configuration statement' },
	{ pattern: /\b(read_text|read_blob|read_csv\w*|read_json\w*|read_ndjson\w*|read_parquet|parquet_scan)\s*\(/i, label: 'file read function' },
];

/** Blocked when writes are disallowed; flagged destructive when they are allowed. */
const SQL_DESTRUCTIVE: { pattern: RegExp, label: string }[] = [
	{ pattern: /^DROP\b/i, label: 'DROP' },
	{ pattern: /^ALTER\b/i, label: 'ALTER' },
	{ pattern: /^CREATE\s+(USER|ROLE)\b/i, label: 'CREATE USER' },
	{ pattern: /^GRANT\b/i, label: 'GRANT' },
	{ pattern: /^REVOKE\b/i, label: 'REVOKE' },
	{ pattern: /^DELETE\b(?![\s\S]*\bWHERE\b)/i, label: 'DELETE without WHERE' },
	{ pattern: /^UPDATE\b(?![\s\S]*\bWHERE\b)/i, label: 'UPDATE without WHERE' },
];

/** First keywords of statements that only read. */
const SQL_READ_KEYWORDS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE', 'EXISTS']);

/** Data-modifying statements inside a CTE or EXPLAIN ANALYZE body. */
const EMBEDDED_WRITE = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i;

const REDIS_ALWAYS_BLOCKED = new Set([
	'EVAL', 'EVALSHA', 'EVAL_RO', 'EVALSHA_RO', 'FCALL', 'FCALL_RO', 'FUNCTION', 'SCRIPT',
	'MODULE', 'REPLICAOF', 'SLAVEOF', 'ACL', 'MIGRATE', 'CLIENT', 'DEBUG', 'CONFIG',
	'SHUTDOWN', 'FLUSHALL', 'FLUSHDB', 'MULTI', 'EXEC', 'DISCARD', 'WATCH', 'SWAPDB', 'KEYS',
	'RESET', 'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'SYNC', 'PSYNC', 'MONITOR', 'FAILOVER', 'CLUSTER',
	'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'AUTH', 'HELLO', 'LATENCY', 'MEMORY',
]);

const REDIS_READ_VERBS = new Set([
	'GET', 'MGET', 'GETRANGE', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'EXPIRETIME', 'PEXPIRETIME',
	'SCAN', 'DBSIZE', 'RANDOMKEY', 'OBJECT', 'DUMP', 'INFO', 'PING', 'ECHO', 'TIME', 'LCS',
	'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSTRLEN', 'HSCAN', 'HRANDFIELD',
	'LRANGE', 'LLEN', 'LINDEX', 'LPOS',
	'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SCARD', 'SSCAN', 'SRANDMEMBER', 'SINTER', 'SUNION', 'SDIFF', 'SINTERCARD',
	'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGEBYLEX', 'ZSCORE', 'ZMSCORE',
	'ZCARD', 'ZCOUNT', 'ZLEXCOUNT', 'ZRANK', 'ZREVRANK', 'ZSCAN', 'ZRANDMEMBER', 'ZINTER', 'ZUNION', 'ZDIFF', 'ZINTERCARD',
	'XRANGE', 'XREVRANGE', 'XLEN', 'XREAD', 'XINFO', 'XPENDING',
	'GETBIT', 'BITCOUNT', 'BITPOS', 'BITFIELD_RO', 'PFCOUNT', 'GEOPOS', 'GEODIST', 'GEOHASH', 'GEOSEARCH', 'GEORADIUS_RO', 'GEORADIUSBYMEMBER_RO',
	'JSON.GET', 'JSON.MGET', 'JSON.TYPE', 'JSON.STRLEN', 'JSON.ARRLEN', 'JSON.OBJKEYS', 'JSON.OBJLEN',
	'FT.SEARCH', 'FT.AGGREGATE', 'FT.INFO', 'FT._LIST', 'COMMAND',
]);

type LexerMode = {
	/** `#` starts a line comment (MySQL). */
	hashComments: boolean;
	/** Backslash escapes the next character inside a literal (MySQL, Postgres E'' strings). */
	backslashEscapes: boolean;
	/** `$tag$ ... $tag$` is a string literal (Postgres). */
	dollarQuotes: boolean;
};

/** Engines lex differently, so the validator checks every mode and keeps the most restrictive result. */
const LEXER_MODES: LexerMode[] = [];
for (const hashComments of [true, false]) {
	for (const backslashEscapes of [true, false]) {
		for (const dollarQuotes of [true, false]) {
			LEXER_MODES.push({ hashComments, backslashEscapes, dollarQuotes });
		}
	}
}

const DOLLAR_TAG = /^\$[A-Za-z_]*\$/;

/**
 * Removes SQL comments (block, `--`, `#`) and blanks the content of single-quoted and
 * dollar-quoted string literals, so that patterns only match code. MySQL executable comments
 * (`/*! ... *\/`) keep their content because MySQL runs it.
 */
export function normalizeSql(query: string, mode: LexerMode = { hashComments: true, backslashEscapes: true, dollarQuotes: true }): string {
	let out = '';
	let i = 0;
	while (i < query.length) {
		const ch = query[i];
		const next = query[i + 1];
		if (ch === '\'' || ch === '"' || ch === '`') {
			const end = findLiteralEnd(query, i, mode.backslashEscapes && ch !== '`');
			out += ch === '\'' ? `'${' '.repeat(Math.max(0, end - i - 2))}'` : query.slice(i, end);
			i = end;
		} else if (mode.dollarQuotes && ch === '$' && DOLLAR_TAG.test(query.slice(i, i + 64))) {
			const tag = query.slice(i, i + 64).match(DOLLAR_TAG)![0];
			const close = query.indexOf(tag, i + tag.length);
			const end = close === -1 ? query.length : close + tag.length;
			out += `'${' '.repeat(Math.max(0, end - i - 2))}'`;
			i = end;
		} else if (ch === '/' && next === '*') {
			if (query[i + 2] === '!') {
				// MySQL executable comment: keep the body
				out += ' ';
				i += 3;
				continue;
			}
			const close = query.indexOf('*/', i + 2);
			i = close === -1 ? query.length : close + 2;
			out += ' ';
		} else if (ch === '*' && next === '/') {
			// closing marker of a MySQL executable comment
			out += ' ';
			i += 2;
		} else if ((ch === '-' && next === '-') || (mode.hashComments && ch === '#')) {
			const close = query.indexOf('\n', i);
			i = close === -1 ? query.length : close + 1;
			out += ' ';
		} else {
			out += ch;
			i++;
		}
	}
	return out.trim();
}

function findLiteralEnd(query: string, start: number, backslashEscapes: boolean): number {
	const quote = query[start];
	let i = start + 1;
	while (i < query.length) {
		if (backslashEscapes && query[i] === '\\') {
			i += 2;
			continue;
		}
		if (query[i] === quote) {
			if (query[i + 1] === quote) {
				i += 2;
				continue;
			}
			return i + 1;
		}
		i++;
	}
	return query.length;
}

/** True when normalized code holds more than one statement (a `;` that is not trailing). */
export function hasStackedStatements(code: string): boolean {
	return code.replace(/[\s;]+$/, '').includes(';');
}

function getRedisVerb(query: string): string {
	const text = query.trim();
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed) && parsed.length > 0) {
			return String(parsed[0]).trim().toUpperCase();
		}
	} catch {
		// not a JSON array command, fall through to plain-string parsing
	}
	const match = text.match(/^["'\[\s]*([^\s"',\]]+)/);
	return match ? match[1].toUpperCase() : '';
}

function validateRedis(query: string, allowWrites: boolean): QueryValidationResult {
	const verb = getRedisVerb(query);
	if (!verb) {
		return { allowed: false, warning: 'Query blocked: empty command' };
	}
	if (REDIS_ALWAYS_BLOCKED.has(verb)) {
		return { allowed: false, warning: `Query blocked: ${verb} is not allowed via MCP` };
	}
	if (REDIS_READ_VERBS.has(verb)) {
		return { allowed: true };
	}
	if (!allowWrites) {
		return { allowed: false, destructive: true, warning: `Query blocked: ${verb} writes data and MCP is read-only (enable Devdb.mcp.allowWrites)` };
	}
	return { allowed: true, destructive: true, warning: `Warning: ${verb} writes data` };
}

const MONGO_READ_OPERATIONS = new Set(['find', 'aggregate', 'count']);
const MONGO_BLOCKED_KEYS = new Set(['$out', '$merge', '$function', '$where', '$accumulator']);

function hasMongoKey(value: unknown, keys: Set<string>): boolean {
	if (Array.isArray(value)) {
		return value.some(item => hasMongoKey(item, keys));
	}
	if (value && typeof value === 'object') {
		return Object.entries(value).some(([key, item]) => keys.has(key) || hasMongoKey(item, keys));
	}
	return false;
}

/** MongoDB queries are JSON `{ collection, operation, query }`. `$out`/`$merge` stages write data. */
function validateMongo(query: string): QueryValidationResult {
	let parsed: any;
	try {
		parsed = JSON.parse(query);
	} catch {
		return { allowed: false, warning: 'Query blocked: MongoDB query must be JSON { collection, operation, query }' };
	}
	if (!parsed || !MONGO_READ_OPERATIONS.has(parsed.operation)) {
		return { allowed: false, warning: `Query blocked: MongoDB operation ${String(parsed?.operation)} is not allowed via MCP` };
	}
	if (hasMongoKey(parsed.query, MONGO_BLOCKED_KEYS)) {
		return { allowed: false, warning: 'Query blocked: $out, $merge and server-side JavaScript are not allowed via MCP' };
	}
	return { allowed: true };
}

/** DynamoDB PartiQL statements that write items. */
const PARTIQL_WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE']);

/**
 * DynamoDB accepts PartiQL through ExecuteStatement: SELECT reads; INSERT, UPDATE and DELETE
 * write one item each and need writes enabled. Anything else (EXISTS, transactions, DDL) is blocked.
 */
function validateDynamodb(query: string, allowWrites: boolean): QueryValidationResult {
	const code = normalizeSql(query, { hashComments: false, backslashEscapes: false, dollarQuotes: false }).replace(/[\s;]+$/, '');
	if (!code) {
		return { allowed: false, warning: 'Query blocked: empty statement' };
	}
	if (hasStackedStatements(code)) {
		return { allowed: false, warning: 'Query blocked: multiple statements are not allowed via MCP' };
	}

	const keyword = getQueryType(code);
	if (keyword === 'SELECT') {
		return { allowed: true };
	}
	if (!PARTIQL_WRITE_KEYWORDS.has(keyword)) {
		return { allowed: false, warning: `Query blocked: DynamoDB accepts PartiQL SELECT, INSERT, UPDATE and DELETE only, not ${keyword}` };
	}
	if (!allowWrites) {
		return { allowed: false, destructive: true, warning: `Query blocked: ${keyword} writes data and MCP is read-only (enable Devdb.mcp.allowWrites)` };
	}
	return { allowed: true, destructive: true, warning: `Warning: ${keyword} writes data` };
}

function validateSqlInMode(query: string, allowWrites: boolean, mode: LexerMode): QueryValidationResult {
	const normalized = normalizeSql(query, mode);
	if (!normalized) {
		return { allowed: false, warning: 'Query blocked: empty query' };
	}

	if (hasStackedStatements(normalized)) {
		return { allowed: false, warning: 'Query blocked: multiple statements are not allowed via MCP' };
	}

	const code = normalized.replace(/[\s;]+$/, '');

	for (const { pattern, label } of SQL_ALWAYS_BLOCKED) {
		if (pattern.test(code)) {
			return { allowed: false, warning: `Query blocked: ${label} is not allowed via MCP` };
		}
	}

	const firstKeyword = getQueryType(code);
	const isRead = SQL_READ_KEYWORDS.has(firstKeyword)
		&& !((firstKeyword === 'WITH' || firstKeyword === 'EXPLAIN') && EMBEDDED_WRITE.test(code))
		&& !/^SELECT\b[\s\S]*\bINTO\b/i.test(code);

	const destructive = SQL_DESTRUCTIVE.find(entry => entry.pattern.test(code));

	if (isRead && !destructive) {
		return { allowed: true };
	}

	const what = destructive?.label ?? `${firstKeyword} statement`;
	if (!allowWrites) {
		return { allowed: false, destructive: true, warning: `Query blocked: ${what} is not allowed because MCP is read-only (enable Devdb.mcp.allowWrites)` };
	}
	return { allowed: true, destructive: true, warning: `Warning: ${what} detected` };
}

function restrictiveness(result: QueryValidationResult): number {
	if (!result.allowed) {
		return 2;
	}
	return result.destructive ? 1 : 0;
}

function validateSql(query: string, allowWrites: boolean): QueryValidationResult {
	let worst = validateSqlInMode(query, allowWrites, LEXER_MODES[0]);
	for (const mode of LEXER_MODES.slice(1)) {
		if (!worst.allowed) {
			break;
		}
		const result = validateSqlInMode(query, allowWrites, mode);
		if (restrictiveness(result) > restrictiveness(worst)) {
			worst = result;
		}
	}
	return worst;
}

export function validateQuery(query: string, engineType?: string, options: QueryValidationOptions = {}): QueryValidationResult {
	const allowWrites = options.allowWrites === true;
	if (typeof query !== 'string' || !query.trim()) {
		return { allowed: false, warning: 'Query blocked: empty query' };
	}

	if (engineType === 'redis') {
		return validateRedis(query, allowWrites);
	}

	if (engineType === 'mongodb') {
		return validateMongo(query);
	}

	if (engineType === 'dynamodb') {
		return validateDynamodb(query, allowWrites);
	}

	if (!engineType) {
		// Unknown engine: apply the Redis deny list too.
		const redis = validateRedis(query, true);
		if (!redis.allowed) {
			return redis;
		}
	}

	return validateSql(query, allowWrites);
}

export function getQueryType(query: string): string {
	const match = String(query ?? '').trim().match(/^\s*(\w+)/);
	return match ? match[1].toUpperCase() : 'UNKNOWN';
}
