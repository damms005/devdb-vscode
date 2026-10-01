import { editorDialect } from './statement-splitter'
import { EMBEDDED_WRITE, getQueryType, getRedisVerb, normalizeSql, REDIS_READ_VERBS } from '../mcp/query-validator'

/**
 * What the SQL Editor knows about one statement before it runs it. Reads run at once in
 * the engine's read-only mode; writes run only after the user confirms them.
 */
export type EditorStatementInfo = {
	text: string
	kind: 'read' | 'write'
	/** e.g. `SELECT`, `UPDATE`, `DROP TABLE`, `FLUSHALL`, `aggregate`. */
	verb: string
	/** Table, collection or key the statement writes to, without quotes. */
	target?: string
	/** Shown in amber in the confirmation, e.g. "No WHERE clause: this changes every row." */
	warning?: string
	/** True for DDL (CREATE, DROP, ALTER, RENAME), so the table list must reload. */
	changesSchema: boolean
}

/**
 * First keywords each engine accepts in its read-only mode. A statement that starts with
 * any other keyword is a write and needs confirmation.
 */
const READ_KEYWORDS: Record<string, string[]> = {
	postgres: ['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'TABLE', 'VALUES'],
	mysql: ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'TABLE', 'VALUES'],
	mssql: ['SELECT', 'WITH'],
	sqlite: ['SELECT', 'WITH', 'EXPLAIN', 'VALUES', 'PRAGMA'],
	d1: ['SELECT', 'WITH', 'EXPLAIN', 'VALUES', 'PRAGMA'],
	libsql: ['SELECT', 'WITH', 'EXPLAIN', 'VALUES', 'PRAGMA'],
	duckdb: ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE', 'SUMMARIZE', 'FROM', 'PIVOT', 'UNPIVOT'],
	clickhouse: ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'EXISTS'],
	dynamodb: ['SELECT'],
}

const DEFAULT_READ_KEYWORDS = ['SELECT', 'WITH', 'EXPLAIN', 'VALUES']

const SCHEMA_KEYWORDS = new Set(['CREATE', 'DROP', 'ALTER', 'RENAME'])

const OBJECT_TYPES = ['MATERIALIZED VIEW', 'TABLE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE', 'TRIGGER', 'FUNCTION', 'PROCEDURE', 'SEQUENCE', 'TYPE', 'EXTENSION', 'DICTIONARY', 'USER', 'ROLE', 'COLLECTION']

const IDENTIFIER = String.raw`((?:[\x60"\[]?[\w$-]+[\x60"\]]?)(?:\s*\.\s*[\x60"\[]?[\w$-]+[\x60"\]]?)*)`

const TARGET_PATTERNS: RegExp[] = [
	new RegExp(String.raw`^(?:INSERT|REPLACE|UPSERT)(?:\s+OR\s+\w+)?\s+INTO\s+(?:TABLE\s+)?${IDENTIFIER}`, 'i'),
	new RegExp(String.raw`^UPDATE(?:\s+OR\s+\w+)?\s+(?:ONLY\s+)?${IDENTIFIER}`, 'i'),
	new RegExp(String.raw`^DELETE\s+FROM\s+(?:ONLY\s+)?${IDENTIFIER}`, 'i'),
	new RegExp(String.raw`^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?${IDENTIFIER}`, 'i'),
	new RegExp(String.raw`^MERGE\s+INTO\s+${IDENTIFIER}`, 'i'),
	new RegExp(String.raw`^DROP\s+(?:MATERIALIZED\s+)?\w+\s+(?:IF\s+EXISTS\s+)?${IDENTIFIER}`, 'i'),
	new RegExp(String.raw`^ALTER\s+\w+\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENTIFIER}`, 'i'),
	new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY|UNIQUE|MATERIALIZED|VIRTUAL)\s+)*\w+\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}`, 'i'),
	new RegExp(String.raw`^RENAME\s+TABLE\s+${IDENTIFIER}`, 'i'),
]

export function classifyStatement(text: string, engineType?: string): EditorStatementInfo {
	switch (engineType = editorDialect(engineType)) {
		case 'redis':
			return classifyRedis(text)
		case 'mongodb':
			return classifyMongo(text)
		default:
			return classifySql(text, engineType)
	}
}

function classifySql(text: string, engineType?: string): EditorStatementInfo {
	const code = normalizeSql(text, {
		hashComments: engineType === 'mysql' || engineType === 'clickhouse',
		backslashEscapes: engineType === 'mysql' || engineType === 'clickhouse',
		dollarQuotes: engineType === 'postgres',
	}).replace(/[\s;]+$/, '')
	const keyword = getQueryType(code)

	const isRead = (READ_KEYWORDS[engineType ?? ''] ?? DEFAULT_READ_KEYWORDS).includes(keyword)
		&& !((keyword === 'WITH' || keyword === 'EXPLAIN') && EMBEDDED_WRITE.test(code))
		&& !(keyword === 'SELECT' && /\bINTO\b/i.test(code) && !/\bINTO\s+@/i.test(code))
		&& !(keyword === 'PRAGMA' && /=|\(\s*\w+\s*,/.test(code))

	if (isRead) {
		return { text, kind: 'read', verb: keyword, changesSchema: false }
	}

	const verb = writeVerb(code, keyword)
	const target = writeTarget(code)

	return {
		text,
		kind: 'write',
		verb,
		target,
		warning: writeWarning(code, keyword, verb),
		changesSchema: SCHEMA_KEYWORDS.has(keyword),
	}
}

function writeVerb(code: string, keyword: string): string {
	if (!SCHEMA_KEYWORDS.has(keyword)) {
		return keyword
	}
	const rest = code.slice(keyword.length).trim()
		.replace(/^OR\s+REPLACE\s+/i, '')
		.replace(/^((TEMP|TEMPORARY|UNIQUE|VIRTUAL)\s+)+/i, '')
		.toUpperCase()
	const objectType = OBJECT_TYPES.find(type => rest.startsWith(`${type} `) || rest === type)
	return objectType ? `${keyword} ${objectType}` : keyword
}

function writeTarget(code: string): string | undefined {
	for (const pattern of TARGET_PATTERNS) {
		const match = code.match(pattern)
		if (match) {
			return unquoteIdentifier(match[1])
		}
	}
	return undefined
}

function unquoteIdentifier(identifier: string): string {
	return identifier
		.split('.')
		.map(part => part.trim().replace(/^[`"[]|[`"\]]$/g, ''))
		.join('.')
}

function writeWarning(code: string, keyword: string, verb: string): string | undefined {
	const hasWhere = /\bWHERE\b/i.test(code)
	if (keyword === 'UPDATE' && !hasWhere) return 'No WHERE clause: this changes every row.'
	if (keyword === 'DELETE' && !hasWhere) return 'No WHERE clause: this deletes every row.'
	if (keyword === 'TRUNCATE') return 'This deletes every row.'
	if (keyword === 'DROP') return `You cannot undo ${verb}.`
	return undefined
}

function classifyRedis(text: string): EditorStatementInfo {
	const verb = getRedisVerb(text)
	if (REDIS_READ_VERBS.has(verb)) {
		return { text, kind: 'read', verb, changesSchema: false }
	}

	const target = text.trim().split(/\s+/)[1]
	const warning = verb === 'FLUSHALL' || verb === 'FLUSHDB' ? 'This deletes every key.' : undefined
	return { text, kind: 'write', verb, target: warning ? undefined : target, warning, changesSchema: false }
}

/** MongoDB queries are JSON `{ collection, operation, query }`; `$out` and `$merge` stages write. */
function classifyMongo(text: string): EditorStatementInfo {
	let parsed: any
	try {
		parsed = JSON.parse(text)
	} catch {
		// The engine reports the parse error when it runs the read.
		return { text, kind: 'read', verb: 'query', changesSchema: false }
	}

	const operation = String(parsed?.operation ?? 'query')
	const pipeline = Array.isArray(parsed?.query?.pipeline) ? parsed.query.pipeline : []
	const writeStage = pipeline.find((stage: unknown) => stage && typeof stage === 'object' && ('$out' in stage || '$merge' in stage))

	if (!writeStage) {
		return { text, kind: 'read', verb: operation, changesSchema: false }
	}

	const destination = writeStage.$out ?? writeStage.$merge?.into ?? writeStage.$merge
	return {
		text,
		kind: 'write',
		verb: operation,
		target: typeof destination === 'string' ? destination : parsed?.collection,
		warning: 'This writes the result to a collection.',
		changesSchema: false,
	}
}
