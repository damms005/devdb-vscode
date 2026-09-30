import { KnexClient, RawQueryOptions } from '../types';
import { RemoteSqliteEngine, SqlValue, StatementResult } from './remote-sqlite-engine';

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export type CloudflareD1Config = {
	accountId: string
	databaseId: string
	apiToken: string
	/** Overrides the Cloudflare API base URL (tests use a local mock). */
	apiBase?: string
	timeoutMs?: number
}

/**
 * Envelope of every Cloudflare v4 API response.
 * @see https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
 */
type CloudflareEnvelope<T> = {
	success: boolean
	errors?: { code?: number, message?: string }[]
	messages?: unknown[]
	result?: T
}

type D1Meta = {
	changes?: number
	last_row_id?: number
	rows_read?: number
	rows_written?: number
	duration?: number
	changed_db?: boolean
}

/** One element of `result` from `POST .../query`: rows as objects. */
type D1QueryResult = { success: boolean, results?: Record<string, any>[], meta?: D1Meta }

/** One element of `result` from `POST .../raw`: rows as arrays, with column names. */
type D1RawResult = { success: boolean, results?: { columns?: string[], rows?: any[][] }, meta?: D1Meta }

/**
 * Cloudflare D1 over the REST API (`/accounts/{account_id}/d1/database/{database_id}/query`
 * and `/raw`), authenticated with an API token. The API has no transactions or sessions, so
 * each statement is its own request and read-only mode is enforced by statement checks
 * ({@link assertReadOnlySqliteStatement}). A token with only the "D1 Read" permission adds a
 * server-side guarantee.
 */
export class CloudflareD1Engine extends RemoteSqliteEngine {
	private readonly baseUrl: string;

	constructor(private readonly config: CloudflareD1Config) {
		super();
		const apiBase = (config.apiBase ?? CLOUDFLARE_API_BASE).replace(/\/+$/, '');
		this.baseUrl = `${apiBase}/accounts/${encodeURIComponent(config.accountId)}/d1/database/${encodeURIComponent(config.databaseId)}`;
	}

	getType(): KnexClient {
		return 'd1';
	}

	async disconnect(): Promise<void> { }

	protected async execute(sql: string, params: SqlValue[] = [], signal?: AbortSignal): Promise<StatementResult> {
		const results = await this.post<D1RawResult[]>('raw', { sql, params: params.map(serializeParam) }, signal);
		return fromRawResult(results[results.length - 1]);
	}

	/**
	 * Returns the rows of the last statement, or `{ changes, lastID }` when it returned none
	 * and wrote data (the shape the SQLite engine returns).
	 */
	protected async executeRaw(code: string, options: RawQueryOptions): Promise<any> {
		const results = await this.post<D1QueryResult[]>('query', { sql: code }, options.signal);
		const last = results[results.length - 1];
		const rows = last?.results ?? [];

		if (rows.length === 0 && last?.meta?.changed_db) {
			return { changes: last.meta.changes ?? 0, lastID: last.meta.last_row_id };
		}

		return rows;
	}

	private async post<T>(endpoint: 'query' | 'raw', body: { sql: string, params?: SqlValue[] }, signal?: AbortSignal): Promise<T> {
		const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 30000);
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}/${endpoint}`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.config.apiToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch (error) {
			throw new Error(`Cloudflare D1 request failed: ${describeFetchError(error)}`);
		}

		let envelope: CloudflareEnvelope<T> | undefined;
		try {
			envelope = await response.json() as CloudflareEnvelope<T>;
		} catch {
			envelope = undefined;
		}

		if (!response.ok || !envelope?.success) {
			const reason = envelope?.errors?.map(error => error.code ? `${error.message} (${error.code})` : error.message).filter(Boolean).join('; ');
			throw new Error(`Cloudflare D1 error (HTTP ${response.status}): ${reason || response.statusText || 'unknown error'}`);
		}

		return (envelope.result ?? []) as T;
	}
}

/**
 * `fetch` rejects with "fetch failed" and keeps the reason (e.g. ECONNREFUSED) in `cause`.
 * The token is only ever in a header, so it is never part of these messages.
 */
function describeFetchError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = (error as Error & { cause?: unknown }).cause;
	const reason = cause instanceof Error ? cause.message : undefined;

	return reason ? `${error.message} (${reason})` : error.message;
}

function serializeParam(value: SqlValue): SqlValue {
	return Buffer.isBuffer(value) ? value.toString('base64') : value;
}

function fromRawResult(result: D1RawResult | undefined): StatementResult {
	const columns = result?.results?.columns ?? [];
	const rows = (result?.results?.rows ?? []).map(values => Object.fromEntries(columns.map((column, index) => [column, values[index]])));

	return { columns, rows, changes: result?.meta?.changes, lastRowId: result?.meta?.last_row_id };
}
