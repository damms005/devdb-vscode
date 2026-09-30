import * as assert from 'assert';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { LibsqlEngine, toHttpLibsqlUrl } from '../../../database-engines/libsql-engine';
import { SerializedMutation } from '../../../types';

/**
 * Live tests against sqld (the libSQL server Turso runs). Set LIBSQL_TEST_URL (e.g. the local
 * stack's http://127.0.0.1:8081) to use a running server instead of a container.
 */
const dockerImage = 'ghcr.io/tursodatabase/libsql-server:latest';

const SEED = [
	'DROP TABLE IF EXISTS t_posts',
	'DROP TABLE IF EXISTS t_authors',
	'CREATE TABLE t_authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT)',
	'CREATE TABLE t_posts (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES t_authors(id), title TEXT NOT NULL, views INTEGER DEFAULT 0)',
	"INSERT INTO t_authors (id, name, country) VALUES (1, 'Ada Lovelace', 'UK'), (2, 'Grace Hopper', 'US')",
	"INSERT INTO t_posts (id, author_id, title, views) VALUES (1, 1, 'Analytical Engine', 1843), (2, 2, 'First compiler', 1952), (3, 1, 'Bernoulli numbers', 42)",
];

describe('Turso / libSQL engine (live sqld)', () => {
	let container: StartedTestContainer | undefined;
	let engine: LibsqlEngine;
	let url: string;

	before(async function () {
		this.timeout(180000);
		url = process.env.LIBSQL_TEST_URL ?? '';
		if (!url) {
			container = await new GenericContainer(dockerImage)
				.withName('devdb-test-container-libsql')
				.withExposedPorts(8080)
				.withWaitStrategy(Wait.forHttp('/health', 8080))
				.withReuse()
				.start();
			url = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
		}

		engine = new LibsqlEngine({ url });
	});

	after(async () => {
		await engine?.rawQuery('DROP TABLE IF EXISTS t_posts').catch(() => undefined);
		await engine?.rawQuery('DROP TABLE IF EXISTS t_authors').catch(() => undefined);
		await engine?.disconnect();
	});

	beforeEach(async () => {
		for (const statement of SEED) {
			await engine.rawQuery(statement);
		}
	});

	it('maps ws(s):// URLs to the HTTP transport', () => {
		assert.strictEqual(toHttpLibsqlUrl('wss://db-org.turso.io'), 'https://db-org.turso.io');
		assert.strictEqual(toHttpLibsqlUrl('ws://127.0.0.1:8081'), 'http://127.0.0.1:8081');
		assert.strictEqual(toHttpLibsqlUrl('libsql://db-org.turso.io'), 'libsql://db-org.turso.io');
	});

	it('reports type libsql, a healthy connection and the SQLite version', async () => {
		assert.strictEqual(engine.getType(), 'libsql');
		assert.strictEqual(await engine.isOkay(), true);
		assert.match(await engine.getVersion() ?? '', /^3\.\d+/);
	});

	it('lists tables and columns', async () => {
		const tables = await engine.getTables();
		assert.ok(tables.includes('t_authors') && tables.includes('t_posts'), tables.join(','));

		const columns = await engine.getColumns('t_posts');
		assert.deepStrictEqual(columns.map(c => [c.name, c.type, c.isPrimaryKey]), [
			['id', 'INTEGER', true], ['author_id', 'INTEGER', false], ['title', 'TEXT', false], ['views', 'INTEGER', false],
		]);
		assert.deepStrictEqual(columns[1].foreignKey, { table: 't_authors', column: 'id' });
	});

	it('pages, counts and filters rows with parameters', async () => {
		const columns = await engine.getColumns('t_posts');
		assert.deepStrictEqual((await engine.getRows('t_posts', columns, 2, 1))?.rows.map(r => r.id), [2, 3]);
		assert.strictEqual(await engine.getTotalRows('t_posts', columns), 3);
		assert.deepStrictEqual((await engine.getRows('t_posts', columns, 10, 0, { title: 'engine' }))?.rows.map(r => r.id), [1]);
		assert.strictEqual(await engine.getTotalRows('t_posts', columns, { author_id: 1 }), 2);
		assert.deepStrictEqual((await engine.getRows('t_posts', columns, 10, 0, { title: "x' OR '1'='1" }))?.rows, []);
	});

	it('updates and deletes with parameterised statements', async () => {
		const columns = await engine.getColumns('t_authors');
		const update: SerializedMutation = { type: 'cell-update', id: 'm1', tabId: 't', table: 't_authors', column: columns.find(c => c.name === 'country')!, newValue: 'GB', primaryKeyColumn: 'id', primaryKey: 1 };
		await engine.commitChange(update);
		await engine.commitChange({ type: 'row-delete', id: 'm2', tabId: 't', table: 't_posts', primaryKeyColumn: 'id', primaryKey: 3 });

		assert.deepStrictEqual(await engine.rawQuery('SELECT country FROM t_authors WHERE id = 1'), [{ country: 'GB' }]);
		assert.deepStrictEqual(await engine.rawQuery('SELECT COUNT(*) AS n FROM t_posts'), [{ n: 2 }]);
	});

	it('returns write stats for raw writes', async () => {
		assert.deepStrictEqual(await engine.rawQuery("INSERT INTO t_authors (id, name) VALUES (9, 'New')"), { changes: 1, lastID: 9 });
	});

	describe('read-only raw queries', () => {
		it('allows reads', async () => {
			assert.deepStrictEqual(await engine.rawQuery('SELECT name FROM t_authors WHERE id = 2', { readOnly: true }), [{ name: 'Grace Hopper' }]);
		});

		for (const sql of ["INSERT INTO t_authors (name) VALUES ('x')", 'WITH d AS (SELECT 1) DELETE FROM t_posts', 'DROP TABLE t_posts', 'PRAGMA foreign_keys = OFF']) {
			it(`rejects ${sql}`, async () => {
				await assert.rejects(engine.rawQuery(sql, { readOnly: true }), /Read-only mode/);
				assert.deepStrictEqual(await engine.rawQuery('SELECT COUNT(*) AS n FROM t_posts'), [{ n: 3 }]);
			});
		}

		it('never commits, also past the statement check (transaction is rolled back)', async () => {
			const executeRaw = (engine as unknown as { executeRaw(code: string, options: { readOnly: boolean }): Promise<unknown> }).executeRaw.bind(engine);
			await executeRaw('DELETE FROM t_posts', { readOnly: true });
			assert.deepStrictEqual(await engine.rawQuery('SELECT COUNT(*) AS n FROM t_posts'), [{ n: 3 }]);
		});
	});

	it('fails isOkay on an unreachable server', async () => {
		const offline = new LibsqlEngine({ url: 'http://127.0.0.1:1' });
		assert.strictEqual(await offline.isOkay(), false);
		await offline.disconnect();
	});
});
