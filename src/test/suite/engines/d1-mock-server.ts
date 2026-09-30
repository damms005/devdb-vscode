import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { Database } from '@vscode/sqlite3';

/**
 * Local mock of the Cloudflare D1 REST API, backed by an in-memory SQLite database.
 *
 * Mocked shape (https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
 * and .../methods/raw/):
 *
 *   POST /client/v4/accounts/{account_id}/d1/database/{database_id}/query
 *   POST /client/v4/accounts/{account_id}/d1/database/{database_id}/raw
 *   Authorization: Bearer <API token>
 *   Content-Type: application/json
 *   { "sql": "SELECT * FROM t WHERE id = ?", "params": [1] }
 *
 *   200 /query -> { "success": true, "errors": [], "messages": [],
 *                   "result": [ { "success": true, "results": [ { "id": 1, ... } ], "meta": { ... } } ] }
 *   200 /raw   -> { "success": true, "errors": [], "messages": [],
 *                   "result": [ { "success": true, "results": { "columns": ["id", ...], "rows": [[1, ...]] }, "meta": { ... } } ] }
 *   meta      -> { served_by, duration, changes, last_row_id, changed_db, size_after, rows_read, rows_written }
 *
 *   401 -> { "success": false, "errors": [ { "code": 10000, "message": "Authentication error" } ], "messages": [], "result": null }
 *   404 -> { "success": false, "errors": [ { "code": 7404, "message": "The database <id> could not be found" } ], ... }
 *   400 -> { "success": false, "errors": [ { "code": 7500, "message": "<SQLite error>: SQLITE_ERROR" } ], ... }
 *
 * One result entry per statement; several `;`-separated statements are allowed without params.
 */
export type D1MockRequest = { endpoint: 'query' | 'raw', path: string, authorization?: string, contentType?: string, body: { sql: string, params?: unknown[] } };

export type D1Mock = {
	apiBase: string
	accountId: string
	databaseId: string
	token: string
	requests: D1MockRequest[]
	db: Database
	exec(sql: string): Promise<void>
	close(): Promise<void>
}

const READ_STATEMENT = /^\s*(SELECT|PRAGMA|WITH|VALUES|EXPLAIN)\b/i;

function splitStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = '';
	let quote: string | null = null;
	for (const ch of sql) {
		if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === '\'' || ch === '"') {
			quote = ch;
		} else if (ch === ';') {
			if (current.trim()) statements.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) statements.push(current.trim());

	return statements;
}

type Executed = { rows: Record<string, any>[], changes: number, lastRowId: number };

function run(db: Database, sql: string, params: unknown[]): Promise<Executed> {
	return new Promise((resolve, reject) => {
		if (READ_STATEMENT.test(sql)) {
			db.all(sql, params, (err, rows: Record<string, any>[]) => err ? reject(err) : resolve({ rows, changes: 0, lastRowId: 0 }));
			return;
		}

		db.run(sql, params, function (err) {
			if (err) {
				reject(err);
				return;
			}
			resolve({ rows: [], changes: this.changes, lastRowId: this.lastID });
		});
	});
}

function send(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

function failure(code: number, message: string) {
	return { success: false, errors: [{ code, message }], messages: [], result: null };
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

export async function startD1Mock(options: { accountId?: string, databaseId?: string, token?: string } = {}): Promise<D1Mock> {
	const accountId = options.accountId ?? '023e105f4ecef8ad9ca31a8372d0c353';
	const databaseId = options.databaseId ?? 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx';
	const token = options.token ?? 'd1-test-token';
	const db = new Database(':memory:');
	const requests: D1MockRequest[] = [];

	const server: Server = createServer(async (req, res) => {
		const match = req.url?.match(/^\/client\/v4\/accounts\/([^/]+)\/d1\/database\/([^/]+)\/(query|raw)$/);
		if (req.method !== 'POST' || !match) {
			send(res, 404, failure(7000, 'No route for that URI'));
			return;
		}

		let body: { sql: string, params?: unknown[] };
		try {
			body = JSON.parse(await readBody(req));
		} catch {
			send(res, 400, failure(7400, 'Invalid JSON body'));
			return;
		}

		const endpoint = match[3] as 'query' | 'raw';
		requests.push({ endpoint, path: req.url!, authorization: req.headers.authorization, contentType: req.headers['content-type'], body });

		if (req.headers.authorization !== `Bearer ${token}`) {
			send(res, 401, failure(10000, 'Authentication error'));
			return;
		}

		if (decodeURIComponent(match[1]) !== accountId || decodeURIComponent(match[2]) !== databaseId) {
			send(res, 404, failure(7404, `The database ${decodeURIComponent(match[2])} could not be found`));
			return;
		}

		const statements = body.params?.length ? [body.sql] : splitStatements(body.sql);
		const result: unknown[] = [];
		try {
			for (const statement of statements) {
				const started = Date.now();
				const executed = await run(db, statement, body.params ?? []);
				const meta = {
					served_by: 'mock-d1',
					duration: Date.now() - started,
					changes: executed.changes,
					last_row_id: executed.lastRowId,
					changed_db: executed.changes > 0,
					size_after: 8192,
					rows_read: executed.rows.length,
					rows_written: executed.changes,
				};
				const columns = executed.rows.length ? Object.keys(executed.rows[0]) : [];
				result.push({
					success: true,
					meta,
					results: endpoint === 'raw'
						? { columns, rows: executed.rows.map(row => columns.map(column => row[column])) }
						: executed.rows,
				});
			}
		} catch (error) {
			const message = String((error as Error).message).replace(/^SQLITE_ERROR: /, '');
			send(res, 400, failure(7500, `${message}: SQLITE_ERROR`));
			return;
		}

		send(res, 200, { success: true, errors: [], messages: [], result });
	});

	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const port = (server.address() as AddressInfo).port;

	return {
		apiBase: `http://127.0.0.1:${port}/client/v4`,
		accountId,
		databaseId,
		token,
		requests,
		db,
		exec: (sql: string) => new Promise((resolve, reject) => db.exec(sql, err => err ? reject(err) : resolve())),
		close: async () => {
			await new Promise<void>(resolve => server.close(() => resolve()));
			await new Promise<void>(resolve => db.close(() => resolve()));
		},
	};
}
