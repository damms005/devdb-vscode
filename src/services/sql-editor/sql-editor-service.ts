import type * as vscode from 'vscode'
import { DatabaseEngine } from '../../types'
import { classifyStatement, EditorStatementInfo } from './statement-classifier'
import { splitStatements } from './statement-splitter'
import { EditorResult, toEditorResult } from './result-normalizer'

export type EditorRunRequest = {
	runId: string
	code: string
	/** The user confirmed the writes the host listed in `needsConfirmation`. */
	confirmed?: boolean
}

export type EditorRunResponse = {
	runId: string
	/** Writes that need the user's confirmation. Nothing ran. */
	needsConfirmation?: EditorStatementInfo[]
	results?: EditorResult[]
	/** Tables, collections or keys that confirmed writes changed. */
	tablesWritten?: string[]
	/** True when a write ran, so open table views must reload. */
	wroteData?: boolean
	/** True when DDL ran, so the table list must reload. */
	schemaChanged?: boolean
	error?: string
}

/**
 * Runs editor text statement by statement. Reads run in the engine's read-only mode.
 * Writes run only when the request says the user confirmed them; otherwise the response
 * lists them and nothing runs. The run stops at the first error.
 */
export async function runEditorQuery(engine: DatabaseEngine, request: EditorRunRequest, signal?: AbortSignal): Promise<EditorRunResponse> {
	const runId = String(request?.runId ?? '')
	const code = typeof request?.code === 'string' ? request.code : ''
	const engineType = engine.getType()

	const statements = splitStatements(code, engineType).map(range => classifyStatement(range.text, engineType))
	if (!statements.length) {
		return { runId, error: 'Nothing to run' }
	}

	const writes = statements.filter(statement => statement.kind === 'write')
	if (writes.length && request.confirmed !== true) {
		return { runId, needsConfirmation: writes }
	}

	const results: EditorResult[] = []
	const tablesWritten = new Set<string>()
	let wroteData = false
	let schemaChanged = false

	for (const statement of statements) {
		if (signal?.aborted) {
			results.push(failedResult(statement.text, 0, 'Query cancelled'))
			break
		}

		const started = performance.now()
		try {
			const raw = await untilAborted(engine.rawQuery(statement.text, { readOnly: statement.kind === 'read', signal, withMeta: true, quiet: true }), signal)
			results.push(toEditorResult(raw, statement.text, Math.round(performance.now() - started)))
		} catch (error) {
			const message = signal?.aborted ? 'Query cancelled' : errorText(error)
			results.push(failedResult(statement.text, Math.round(performance.now() - started), message))
			break
		} finally {
			if (statement.kind === 'write') {
				wroteData = true
				schemaChanged ||= statement.changesSchema
				if (statement.target) tablesWritten.add(statement.target)
			}
		}
	}

	return { runId, results, tablesWritten: [...tablesWritten], wroteData, schemaChanged }
}

/**
 * Table and column names for editor autocompletion. Reads at most {@link SCHEMA_TABLE_LIMIT}
 * tables and gives up on columns after {@link SCHEMA_TIMEOUT_MS}, so a large database
 * still opens the editor fast.
 */
export async function getEditorSchema(engine: DatabaseEngine): Promise<{ tables: Record<string, string[]> }> {
	const tables = await engine.getTables()
	const schema: Record<string, string[]> = Object.fromEntries(tables.map(table => [table, []]))

	if (['redis', 'mongodb', 'dynamodb'].includes(engine.getType())) {
		return { tables: schema }
	}

	const queue = tables.slice(0, SCHEMA_TABLE_LIMIT)
	const deadline = Date.now() + SCHEMA_TIMEOUT_MS
	const worker = async () => {
		while (queue.length && Date.now() < deadline) {
			const table = queue.shift()!
			try {
				schema[table] = (await engine.getColumns(table)).map(column => column.name)
			} catch {
				// Columns are a convenience: the table name still completes.
			}
		}
	}
	await Promise.all(Array.from({ length: 6 }, worker))

	return { tables: schema }
}

const SCHEMA_TABLE_LIMIT = 300
const SCHEMA_TIMEOUT_MS = 4000

/**
 * Rejects as soon as `signal` aborts, so the editor stops waiting on engines that cannot
 * interrupt a running query. Engines that can interrupt get the same signal.
 */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise
	if (signal.aborted) return Promise.reject(new Error('Query cancelled'))
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error('Query cancelled'))
		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
	})
}

function failedResult(statement: string, durationMs: number, error: string): EditorResult {
	return { statement, kind: 'empty', columns: [], rows: [], rowCount: 0, moreRowsExist: false, durationMs, error }
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

export type EditorHistoryEntry = {
	code: string
	ranAt: number
	ok: boolean
	/** The user cancelled the run. */
	cancelled?: boolean
	durationMs?: number
}

/** Per-connection editor state the webview restores when the editor opens again. */
export type EditorConnectionState = {
	history: EditorHistoryEntry[]
	draft?: string
	/** Height of the editor pane as a fraction of the panel, 0.15 to 0.85. */
	split?: number
	/** Width of the editor panel in percent of the DevDb view, 20 to 85. */
	width?: number
	updatedAt?: number
}

const STATE_KEY = 'devdb.sqlEditor.state'
export const HISTORY_LIMIT = 50
const CONNECTION_LIMIT = 50
const MAX_CODE_LENGTH = 20_000
const MAX_DRAFT_LENGTH = 200_000

/** Stores editor history, draft and pane size per connection in the extension's global state. */
export class SqlEditorStateStore {
	private context: Pick<vscode.ExtensionContext, 'globalState'> | null = null

	setExtensionContext(context: Pick<vscode.ExtensionContext, 'globalState'>): void {
		this.context = context
	}

	get(connectionKey: string): EditorConnectionState {
		const all = this.all()
		return all[String(connectionKey)] ?? { history: [] }
	}

	async save(connectionKey: string, state: Partial<EditorConnectionState>): Promise<EditorConnectionState> {
		if (!this.context || !connectionKey) return { history: [] }

		const clean = sanitizeState(state)
		const all = { ...this.all(), [String(connectionKey)]: clean }
		const kept = Object.entries(all)
			.sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
			.slice(0, CONNECTION_LIMIT)

		await this.context.globalState.update(STATE_KEY, Object.fromEntries(kept))
		return clean
	}

	private all(): Record<string, EditorConnectionState> {
		const stored = this.context?.globalState.get<Record<string, EditorConnectionState>>(STATE_KEY)
		return stored && typeof stored === 'object' ? stored : {}
	}
}

function sanitizeState(state: Partial<EditorConnectionState>): EditorConnectionState {
	const history = (Array.isArray(state?.history) ? state.history : [])
		.filter(entry => entry && typeof entry.code === 'string' && entry.code.trim())
		.slice(0, HISTORY_LIMIT)
		.map(entry => ({
			code: entry.code.slice(0, MAX_CODE_LENGTH),
			ranAt: Number(entry.ranAt) || Date.now(),
			ok: entry.ok !== false,
			...(entry.cancelled === true ? { cancelled: true } : {}),
			...(typeof entry.durationMs === 'number' ? { durationMs: entry.durationMs } : {}),
		}))

	const split = Number(state?.split)
	const width = Number(state?.width)

	return {
		history,
		...(typeof state?.draft === 'string' ? { draft: state.draft.slice(0, MAX_DRAFT_LENGTH) } : {}),
		...(Number.isFinite(split) ? { split: Math.min(0.85, Math.max(0.15, split)) } : {}),
		...(state?.width !== undefined && Number.isFinite(width) ? { width: Math.min(85, Math.max(20, width)) } : {}),
		updatedAt: Date.now(),
	}
}

export const sqlEditorStateStore = new SqlEditorStateStore()
