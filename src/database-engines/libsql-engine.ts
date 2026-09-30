import type { Client, Config, InValue, ResultSet } from '@libsql/client/http' with { 'resolution-mode': 'import' };
import { KnexClient, RawQueryOptions } from '../types';
import { RemoteSqliteEngine, SqlValue, StatementResult } from './remote-sqlite-engine';

/**
 * The HTTP entry point is pure JavaScript. The package root (`@libsql/client`) loads the
 * native `libsql` addon for file: URLs, so it must not be imported. The package ships CommonJS
 * next to its ESM typings, so it is loaded with `require`.
 */
const { createClient } = require('@libsql/client/http') as { createClient: (config: Config) => Client };

export type LibsqlConfig = {
	/** libsql://, https://, http:// (ws:// and wss:// are sent over HTTP too). */
	url: string
	authToken?: string
}

/**
 * The HTTP client speaks Hrana over HTTP. `libsql://` means TLS; `ws(s)://` URLs point at the
 * same server, so they are sent to the matching HTTP scheme.
 */
export function toHttpLibsqlUrl(url: string): string {
	return url.trim()
		.replace(/^wss:\/\//i, 'https://')
		.replace(/^ws:\/\//i, 'http://');
}

/**
 * Turso / libSQL (sqld) over HTTP with `@libsql/client/http`. Read-only raw queries pass the
 * statement check first, then run in a transaction that is always rolled back, so nothing they
 * do is ever committed. (sqld runs writes inside a `read` transaction and rejects
 * `PRAGMA query_only`, so neither is a guarantee on its own.)
 */
export class LibsqlEngine extends RemoteSqliteEngine {
	private client: Client | null = null;

	constructor(private readonly config: LibsqlConfig) {
		super();
	}

	getType(): KnexClient {
		return 'libsql';
	}

	private getClient(): Client {
		if (!this.client) {
			this.client = createClient({
				url: toHttpLibsqlUrl(this.config.url),
				authToken: this.config.authToken || undefined,
				intMode: 'number',
			});
		}

		return this.client;
	}

	async disconnect(): Promise<void> {
		this.client?.close();
		this.client = null;
	}

	protected async execute(sql: string, params: SqlValue[] = []): Promise<StatementResult> {
		return fromResultSet(await this.getClient().execute({ sql, args: params as InValue[] }));
	}

	protected async executeRaw(code: string, options: RawQueryOptions): Promise<any> {
		const client = this.getClient();

		if (options.readOnly) {
			const transaction = await client.transaction('read');
			try {
				return fromResultSet(await transaction.execute(code)).rows;
			} finally {
				await transaction.rollback().catch(() => undefined);
				transaction.close();
			}
		}

		const result = fromResultSet(await client.execute(code));
		if (result.columns.length === 0) {
			return { changes: result.changes ?? 0, lastID: result.lastRowId };
		}

		return result.rows;
	}
}

function fromResultSet(result: ResultSet): StatementResult {
	const rows = result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, plainValue(row[index])])));

	return {
		columns: [...result.columns],
		rows,
		changes: result.rowsAffected,
		lastRowId: result.lastInsertRowid === undefined ? undefined : plainValue(result.lastInsertRowid) as number | string,
	};
}

function plainValue(value: unknown): unknown {
	if (typeof value === 'bigint') {
		return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
	}
	if (value instanceof ArrayBuffer) {
		return Buffer.from(value);
	}

	return value;
}
