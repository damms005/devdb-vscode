import * as assert from 'assert';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { createMcpApp, startServerOnAvailablePort, tokensMatch, McpAppDeps } from '../../../services/mcp/http-app';
import { redactSecrets } from '../../../services/mcp/no-vscode/logger';

type Call = { query: string, options?: { readOnly?: boolean } };

function fakeDb(calls: Call[]): any {
	return {
		getType: () => 'postgres',
		getTables: async () => ['users'],
		getTableCreationSql: async () => 'CREATE TABLE users (id int)',
		rawQuery: async (query: string, options?: { readOnly?: boolean }) => {
			calls.push({ query, options });
			return [{ ok: 1 }];
		},
	};
}

function request(port: number, path: string, opts: { method?: string, headers?: Record<string, string>, body?: unknown } = {}): Promise<{ status: number, body: any }> {
	return new Promise((resolve, reject) => {
		const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
		const req = http.request({
			host: '127.0.0.1',
			port,
			path,
			method: opts.method ?? 'GET',
			headers: {
				Host: `127.0.0.1:${port}`,
				...(body ? { 'Content-Type': 'application/json' } : {}),
				...opts.headers,
			},
		}, res => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				let parsed: any = data;
				try { parsed = JSON.parse(data); } catch { /* keep text */ }
				resolve({ status: res.statusCode ?? 0, body: parsed });
			});
		});
		req.on('error', reject);
		if (body) {
			req.write(body);
		}
		req.end();
	});
}

describe('MCP HTTP server security', () => {
	const token = 'a'.repeat(64);
	const auth = { Authorization: `Bearer ${token}` };
	let server: http.Server;
	let port: number;
	let calls: Call[];
	let allowWrites: boolean;
	let confirmAnswer: boolean;
	let confirmations: string[];

	before(async () => {
		const deps: McpAppDeps = {
			token,
			getDatabase: () => fakeDb(calls),
			allowWrites: () => allowWrites,
			confirmDestructive: async (warning: string) => {
				confirmations.push(warning);
				return confirmAnswer;
			},
		};
		const started = await startServerOnAvailablePort(createMcpApp(deps), 52001);
		server = started.server;
		port = started.port;
	});

	after(() => {
		server.close();
	});

	beforeEach(() => {
		calls = [];
		allowWrites = false;
		confirmAnswer = false;
		confirmations = [];
	});

	it('listens on 127.0.0.1 only', () => {
		assert.strictEqual((server.address() as AddressInfo).address, '127.0.0.1');
	});

	it('returns 401 when the token is missing', async () => {
		const res = await request(port, '/tables');
		assert.strictEqual(res.status, 401);
	});

	it('returns 401 when the token is wrong', async () => {
		const res = await request(port, '/tables', { headers: { Authorization: `Bearer ${'b'.repeat(64)}` } });
		assert.strictEqual(res.status, 401);
	});

	it('returns 200 with the correct token', async () => {
		const res = await request(port, '/tables', { headers: auth });
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(res.body, { tables: ['users'] });
	});

	it('returns 403 for a bad Host header (DNS rebinding)', async () => {
		const res = await request(port, '/tables', { headers: { ...auth, Host: `evil.example:${port}` } });
		assert.strictEqual(res.status, 403);
		const wrongPort = await request(port, '/tables', { headers: { ...auth, Host: 'localhost:1' } });
		assert.strictEqual(wrongPort.status, 403);
	});

	it('accepts localhost:<port> as Host', async () => {
		const res = await request(port, '/tables', { headers: { ...auth, Host: `localhost:${port}` } });
		assert.strictEqual(res.status, 200);
	});

	it('returns 403 when an Origin header is present', async () => {
		const res = await request(port, '/tables', { headers: { ...auth, Origin: 'http://evil.example' } });
		assert.strictEqual(res.status, 403);
		const localOrigin = await request(port, '/tables', { headers: { ...auth, Origin: `http://127.0.0.1:${port}` } });
		assert.strictEqual(localOrigin.status, 403);
	});

	it('runs reads with readOnly: true', async () => {
		const res = await request(port, '/query', { method: 'POST', headers: auth, body: { query: 'SELECT 1' } });
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(calls, [{ query: 'SELECT 1', options: { readOnly: true } }]);
	});

	it('blocks writes with 403 when Devdb.mcp.allowWrites is false', async () => {
		const res = await request(port, '/query', { method: 'POST', headers: auth, body: { query: 'DELETE FROM users WHERE id = 1' } });
		assert.strictEqual(res.status, 403);
		assert.strictEqual(calls.length, 0);
		assert.strictEqual(confirmations.length, 0);
	});

	it('asks for confirmation before a write when writes are allowed, and does not run it when declined', async () => {
		allowWrites = true;
		const declined = await request(port, '/query', { method: 'POST', headers: auth, body: { query: 'DROP TABLE users' } });
		assert.strictEqual(declined.status, 403);
		assert.strictEqual(confirmations.length, 1);
		assert.strictEqual(calls.length, 0);

		confirmAnswer = true;
		const accepted = await request(port, '/query', { method: 'POST', headers: auth, body: { query: 'DROP TABLE users' } });
		assert.strictEqual(accepted.status, 200);
		assert.deepStrictEqual(calls, [{ query: 'DROP TABLE users', options: { readOnly: false } }]);
	});

	it('reports allowWrites on /database-type', async () => {
		const res = await request(port, '/database-type', { headers: auth });
		assert.deepStrictEqual(res.body, { type: 'postgres', allowWrites: false });
	});
});

describe('MCP token and log helpers', () => {
	it('tokensMatch compares tokens', () => {
		assert.strictEqual(tokensMatch('abc', 'abc'), true);
		assert.strictEqual(tokensMatch('abc', 'abd'), false);
		assert.strictEqual(tokensMatch('abc', 'abcd'), false);
		assert.strictEqual(tokensMatch('', ''), false);
	});

	it('redactSecrets removes credentials from URIs and bearer tokens', () => {
		assert.strictEqual(redactSecrets('postgres://neondb_owner:npg_secret@host:5432/db'), 'postgres://***:***@host:5432/db');
		assert.strictEqual(redactSecrets('redis://:pass@localhost:6379'), 'redis://***:***@localhost:6379');
		assert.strictEqual(redactSecrets('host=x password=hunter2 user=u'), 'host=x password=*** user=u');
		assert.strictEqual(redactSecrets('Authorization: Bearer abc123'), 'Authorization: Bearer ***');
	});
});
