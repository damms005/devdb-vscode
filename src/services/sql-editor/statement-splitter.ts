/**
 * Splits editor text into statements on `;` outside string literals, quoted identifiers,
 * comments and Postgres dollar-quoted bodies. SQLite triggers keep their `BEGIN ... END;` body.
 */

export type StatementRange = {
	text: string
	from: number
	to: number
}

type LexerOptions = {
	hashComments: boolean
	backslashEscapes: boolean
	dollarQuotes: boolean
}

/** Engines that take one statement per request and are not split on `;`. */
const SINGLE_STATEMENT_ENGINES = new Set(['mongodb', 'redis'])

/** Engine type as the editor uses it: the MySQL engine reports its driver name, `mysql2`. */
export function editorDialect(engineType?: string): string | undefined {
	return engineType === 'mysql2' ? 'mysql' : engineType
}

function lexerOptionsFor(engineType?: string): LexerOptions {
	return {
		hashComments: engineType === 'mysql' || engineType === 'clickhouse',
		backslashEscapes: engineType === 'mysql' || engineType === 'clickhouse',
		dollarQuotes: engineType === 'postgres',
	}
}

export function splitStatements(code: string, engineType?: string): StatementRange[] {
	engineType = editorDialect(engineType)
	if (SINGLE_STATEMENT_ENGINES.has(engineType ?? '')) {
		const range = trimRange(code, 0, code.length)
		return range ? [range] : []
	}

	const options = lexerOptionsFor(engineType)
	const ranges: StatementRange[] = []
	let start = 0
	let i = 0

	while (i < code.length) {
		const ch = code[i]
		const next = code[i + 1]

		if (ch === '\'' || ch === '"' || ch === '`') {
			i = literalEnd(code, i, options.backslashEscapes && ch === '\'')
		} else if (ch === '[' && engineType === 'mssql') {
			const close = code.indexOf(']', i + 1)
			i = close === -1 ? code.length : close + 1
		} else if (options.dollarQuotes && ch === '$' && /^\$[A-Za-z_]*\$/.test(code.slice(i, i + 64))) {
			const tag = code.slice(i, i + 64).match(/^\$[A-Za-z_]*\$/)![0]
			const close = code.indexOf(tag, i + tag.length)
			i = close === -1 ? code.length : close + tag.length
		} else if ((ch === '-' && next === '-') || (options.hashComments && ch === '#')) {
			const close = code.indexOf('\n', i)
			i = close === -1 ? code.length : close + 1
		} else if (ch === '/' && next === '*') {
			const close = code.indexOf('*/', i + 2)
			i = close === -1 ? code.length : close + 2
		} else if (ch === ';') {
			if (isInsideTriggerBody(code.slice(start, i))) {
				i++
				continue
			}
			const range = trimRange(code, start, i)
			if (range) ranges.push(range)
			i++
			start = i
		} else {
			i++
		}
	}

	const last = trimRange(code, start, code.length)
	if (last) ranges.push(last)

	return ranges
}

function literalEnd(code: string, start: number, backslashEscapes: boolean): number {
	const quote = code[start]
	let i = start + 1
	while (i < code.length) {
		if (backslashEscapes && code[i] === '\\') {
			i += 2
			continue
		}
		if (code[i] === quote) {
			if (code[i + 1] === quote) {
				i += 2
				continue
			}
			return i + 1
		}
		i++
	}
	return code.length
}

/** A `;` inside `CREATE TRIGGER ... BEGIN ... END` does not end the statement until `END`. */
function isInsideTriggerBody(statementSoFar: string): boolean {
	if (!/^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(stripComments(statementSoFar))) {
		return false
	}
	return !/\bEND\s*$/i.test(statementSoFar)
}

/** Trims whitespace. Returns undefined when nothing but whitespace and comments remain. */
function trimRange(code: string, from: number, to: number): StatementRange | undefined {
	const slice = code.slice(from, to)
	const leading = slice.length - slice.trimStart().length
	const text = slice.trim()
	if (!text || !stripComments(text).trim()) return undefined

	return { text, from: from + leading, to: from + leading + text.length }
}

function stripComments(text: string): string {
	return text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}
