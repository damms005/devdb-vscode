import { RawQueryResultWithMeta } from '../../types'

/** Rows the editor sends to the webview per statement. More rows would make the grid slow. */
export const EDITOR_MAX_ROWS = 1000

export type EditorCell = string | number | boolean | null

export type EditorResult = {
	statement: string
	kind: 'rows' | 'affected' | 'text' | 'empty'
	columns: string[]
	rows: Record<string, EditorCell>[]
	/** Rows the engine returned. Can be more than `rows.length`. */
	rowCount: number
	/** True when the engine stopped reading at its own row cap, so more rows exist. */
	moreRowsExist: boolean
	affectedRows?: number
	/** Plain-text reply (Redis). */
	text?: string
	durationMs: number
	error?: string
}

/** Turns what an engine's `rawQuery` returns into one editor result. */
export function toEditorResult(raw: unknown, statement: string, durationMs: number): EditorResult {
	const base = { statement, durationMs, columns: [], rows: [], rowCount: 0, moreRowsExist: false }

	if (raw === null || raw === undefined) {
		return { ...base, kind: 'empty' }
	}

	if (typeof raw === 'string') {
		try {
			return toEditorResult(JSON.parse(raw), statement, durationMs)
		} catch {
			return { ...base, kind: 'text', text: raw }
		}
	}

	if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean') {
		return rowsResult([{ result: raw }], statement, durationMs)
	}

	if (Array.isArray(raw)) {
		// Several statements in one call give one row list per statement: show the last.
		if (raw.length && raw.every(Array.isArray)) {
			return toEditorResult(raw[raw.length - 1], statement, durationMs)
		}
		const rows = raw.map(item => (isRecord(item) ? item : { value: item }))
		return rowsResult(rows, statement, durationMs, [], Boolean((raw as { truncated?: boolean }).truncated))
	}

	if (isMeta(raw)) {
		if (raw.rows.length === 0 && raw.affectedRows !== undefined) {
			return { ...base, kind: 'affected', affectedRows: raw.affectedRows }
		}
		return rowsResult(raw.rows, statement, durationMs, raw.columns)
	}

	if (isRecord(raw)) {
		const affected = raw.affectedRows ?? raw.changes ?? raw.rowsAffected
		if (typeof affected === 'number' || typeof affected === 'bigint') {
			return { ...base, kind: 'affected', affectedRows: Number(affected) }
		}
		return rowsResult([raw], statement, durationMs)
	}

	return { ...base, kind: 'text', text: String(raw) }
}

function rowsResult(rawRows: Record<string, unknown>[], statement: string, durationMs: number, knownColumns: string[] = [], moreRowsExist = false): EditorResult {
	const columns = [...knownColumns]
	const seen = new Set(columns)
	for (const row of rawRows.slice(0, EDITOR_MAX_ROWS)) {
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) {
				seen.add(key)
				columns.push(key)
			}
		}
	}

	const rows = rawRows.slice(0, EDITOR_MAX_ROWS).map(row => {
		const cells: Record<string, EditorCell> = {}
		for (const column of columns) {
			cells[column] = toCell(row[column])
		}
		return cells
	})

	return {
		statement,
		kind: 'rows',
		columns,
		rows,
		rowCount: rawRows.length,
		moreRowsExist,
		durationMs,
	}
}

/** Makes a value safe to post to the webview without losing precision. */
export function toCell(value: unknown): EditorCell {
	if (value === null || value === undefined) return null
	if (typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
	if (typeof value === 'bigint') return value.toString()
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
	if (value instanceof Uint8Array) return binaryPreview(value)
	if (hasOwnToString(value)) return String(value)

	try {
		return JSON.stringify(value, (_key, item) => {
			if (typeof item === 'bigint') return item.toString()
			if (item && typeof item === 'object' && item.type === 'Buffer' && Array.isArray(item.data)) {
				return binaryPreview(Uint8Array.from(item.data))
			}
			return item
		})
	} catch {
		return String(value)
	}
}

function binaryPreview(bytes: Uint8Array): string {
	const shown = Array.from(bytes.subarray(0, 32), byte => byte.toString(16).padStart(2, '0')).join('')
	return `0x${shown}${bytes.length > 32 ? '…' : ''}`
}

/** Class instances such as MongoDB ObjectId or Decimal128 print their value with `toString`. */
function hasOwnToString(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype !== null && prototype !== Object.prototype && typeof (value as object).toString === 'function'
		&& (value as object).toString !== Object.prototype.toString
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Uint8Array)
}

function isMeta(value: unknown): value is RawQueryResultWithMeta {
	return isRecord(value) && Array.isArray(value.rows) && Array.isArray(value.columns)
}
