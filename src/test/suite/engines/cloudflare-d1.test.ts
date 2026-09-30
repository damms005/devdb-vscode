import * as assert from 'assert';
import { CloudflareD1Engine } from '../../../database-engines/cloudflare-d1-engine';
import { SerializedMutation } from '../../../types';
import { D1Mock, startD1Mock } from './d1-mock-server';

const SEED = `
	DROP TABLE IF EXISTS posts;
	DROP TABLE IF EXISTS authors;
	DROP TABLE IF EXISTS _cf_KV;
	CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
	CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT);
	CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(id), title TEXT NOT NULL, views INTEGER DEFAULT 0);
	INSERT INTO authors (id, name, country) VALUES (1, 'Ada Lovelace', 'UK'), (2, 'Grace Hopper', 'US'), (3, 'Chinua Achebe', 'NG');
	INSERT INTO posts (id, author_id, title, views) VALUES (1, 1, 'Analytical Engine', 1843), (2, 2, 'First compiler', 1952), (3, 3, 'Things Fall Apart', 1958), (4, 1, 'Bernoulli numbers', 42);
`;

describe('Cloudflare D1 (remote) engine against a mock D1 API', () => {
	let mock: D1Mock;
	let engine: CloudflareD1Engine;

	before(async () => {
		mock = await startD1Mock();
		engine = new CloudflareD1Engine({ accountId: mock.accountId, databaseId: mock.databaseId, apiToken: mock.token, apiBase: mock.apiBase });
	});

	after(async () => {
		await engine.disconnect();
		await mock.close();
	});

	beforeEach(async () => {
		await mock.exec(SEED);
		mock.requests.length = 0;
	});

	it('reports type d1 and a healthy connection', async () => {
		assert.strictEqual(engine.getType(), 'd1');
		assert.strictEqual(await engine.isOkay(), true);
	});

	it('sends the documented request shape', async () => {
		await engine.getRows('authors', await engine.getColumns('authors'), 1, 0, { name: 'Ada' });

		const request = mock.requests[mock.requests.length - 1];
		assert.strictEqual(request.endpoint, 'raw');
		assert.strictEqual(request.path, `/client/v4/accounts/${mock.accountId}/d1/database/${mock.databaseId}/raw`);
		assert.strictEqual(request.authorization, `Bearer ${mock.token}`);
		assert.strictEqual(request.contentType, 'application/json');
		assert.deepStrictEqual(request.body, { sql: 'SELECT "id", "name", "country" FROM "authors" WHERE "name" LIKE ? LIMIT ? OFFSET ?', params: ['%Ada%', 1, 0] });
	});

	it('lists tables from sqlite_master without D1 internal tables', async () => {
		assert.deepStrictEqual(await engine.getTables(), ['authors', 'posts']);
	});

	it('reads columns with PRAGMA table_info, including keys', async () => {
		const columns = await engine.getColumns('posts');
		assert.deepStrictEqual(columns.map(c => [c.name, c.type, c.isPrimaryKey, c.isNullable]), [
			['id', 'INTEGER', true, true],
			['author_id', 'INTEGER', false, true],
			['title', 'TEXT', false, false],
			['views', 'INTEGER', false, true],
		]);
		assert.deepStrictEqual(columns.find(c => c.name === 'author_id')?.foreignKey, { table: 'authors', column: 'id' });
		assert.strictEqual(columns.find(c => c.name === 'views')?.isNumeric, true);
	});

	it('returns the table creation SQL', async () => {
		assert.match(await engine.getTableCreationSql('authors'), /CREATE TABLE\s+authors/i);
	});

	it('pages rows with LIMIT/OFFSET and counts them', async () => {
		const columns = await engine.getColumns('posts');
		const page = await engine.getRows('posts', columns, 2, 2);
		assert.deepStrictEqual(page?.rows.map(r => r.id), [3, 4]);
		assert.strictEqual(await engine.getTotalRows('posts', columns), 4);
	});

	it('filters with parameters (text LIKE, numeric =)', async () => {
		const columns = await engine.getColumns('posts');
		const byTitle = await engine.getRows('posts', columns, 10, 0, { title: 'engine' });
		assert.deepStrictEqual(byTitle?.rows.map(r => r.id), [1]);

		const byViews = await engine.getRows('posts', columns, 10, 0, { views: 42 });
		assert.deepStrictEqual(byViews?.rows.map(r => r.title), ['Bernoulli numbers']);
		assert.strictEqual(await engine.getTotalRows('posts', columns, { author_id: 1 }), 2);
	});

	it('does not inject SQL through filter values', async () => {
		const columns = await engine.getColumns('authors');
		const rows = await engine.getRows('authors', columns, 10, 0, { name: "x' OR '1'='1" });
		assert.deepStrictEqual(rows?.rows, []);
	});

	it('updates a cell and deletes a row with parameterised statements', async () => {
		const columns = await engine.getColumns('authors');
		const update: SerializedMutation = { type: 'cell-update', id: 'm1', tabId: 't', table: 'authors', column: columns.find(c => c.name === 'country')!, newValue: 'GB', primaryKeyColumn: 'id', primaryKey: 1 };
		await engine.commitChange(update);
		const deletion: SerializedMutation = { type: 'row-delete', id: 'm2', tabId: 't', table: 'posts', primaryKeyColumn: 'id', primaryKey: 4 };
		await engine.commitChange(deletion);

		assert.deepStrictEqual(await engine.rawQuery('SELECT country FROM authors WHERE id = 1'), [{ country: 'GB' }]);
		assert.deepStrictEqual(await engine.rawQuery('SELECT COUNT(*) AS n FROM posts'), [{ n: 3 }]);
		const writes = mock.requests.filter(r => /^(UPDATE|DELETE)/.test(r.body.sql)).map(r => r.body);
		assert.deepStrictEqual(writes, [
			{ sql: 'UPDATE "authors" SET "country" = ? WHERE "id" = ?', params: ['GB', 1] },
			{ sql: 'DELETE FROM "posts" WHERE "id" = ?', params: [4] },
		]);
	});

	it('runs raw queries through /query and returns write stats', async () => {
		assert.deepStrictEqual(await engine.rawQuery('SELECT name FROM authors ORDER BY id LIMIT 1'), [{ name: 'Ada Lovelace' }]);
		assert.deepStrictEqual(await engine.rawQuery("INSERT INTO authors (name) VALUES ('New')"), { changes: 1, lastID: 4 });
		assert.strictEqual(mock.requests[0].endpoint, 'query');
	});

	describe('read-only raw queries', () => {
		it('allows reads', async () => {
			assert.deepStrictEqual(await engine.rawQuery('WITH a AS (SELECT 1 AS x) SELECT x FROM a', { readOnly: true }), [{ x: 1 }]);
			assert.strictEqual((await engine.rawQuery('PRAGMA table_info(authors)', { readOnly: true })).length, 3);
		});

		for (const sql of [
			"INSERT INTO authors (name) VALUES ('x')",
			'DELETE FROM posts',
			'WITH doomed AS (SELECT id FROM posts) DELETE FROM posts WHERE id IN (SELECT id FROM doomed)',
			"REPLACE INTO authors (id, name) VALUES (1, 'x')",
			'DROP TABLE posts',
			'PRAGMA foreign_keys = OFF',
			'PRAGMA writable_schema',
			'SELECT 1; DELETE FROM posts',
			"ATTACH DATABASE 'x.db' AS x",
		]) {
			it(`rejects ${sql} before sending it`, async () => {
				await assert.rejects(engine.rawQuery(sql, { readOnly: true }), /Read-only mode/);
				assert.strictEqual(mock.requests.length, 0);
			});
		}

		it('keeps the replace() string function usable', async () => {
			assert.deepStrictEqual(await engine.rawQuery("SELECT replace(name, 'Ada', 'A.') AS n FROM authors WHERE id = 1", { readOnly: true }), [{ n: 'A. Lovelace' }]);
		});
	});

	describe('errors', () => {
		it('surfaces the D1 error message', async () => {
			await assert.rejects(engine.rawQuery('SELECT * FROM missing'), /Cloudflare D1 error \(HTTP 400\): no such table: missing: SQLITE_ERROR \(7500\)/);
		});

		it('reports a bad token without leaking it', async () => {
			const bad = new CloudflareD1Engine({ accountId: mock.accountId, databaseId: mock.databaseId, apiToken: 'wrong-token-123', apiBase: mock.apiBase });
			assert.strictEqual(await bad.isOkay(), false);
			await assert.rejects(bad.getTables(), (error: Error) => /HTTP 401\): Authentication error \(10000\)/.test(error.message) && !error.message.includes('wrong-token-123'));
		});

		it('reports an unknown database', async () => {
			const missing = new CloudflareD1Engine({ accountId: mock.accountId, databaseId: 'nope', apiToken: mock.token, apiBase: mock.apiBase });
			await assert.rejects(missing.getTables(), /HTTP 404\): The database nope could not be found/);
		});

		it('reports an unreachable API', async () => {
			const offline = new CloudflareD1Engine({ accountId: 'a', databaseId: 'b', apiToken: 't', apiBase: 'http://127.0.0.1:1/client/v4' });
			await assert.rejects(offline.getTables(), /Cloudflare D1 request failed/);
		});

		it('honours an abort signal', async () => {
			const controller = new AbortController();
			controller.abort();
			await assert.rejects(engine.getRows('posts', [], 10, 0, undefined, controller.signal), /Cloudflare D1 request failed/);
		});
	});
});
