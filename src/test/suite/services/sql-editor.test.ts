import { createFakeExtensionContext } from '../vscode-stub';
import * as assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import knexlib from 'knex';
import { StartedPostgreSqlContainer, PostgreSqlContainer } from '@testcontainers/postgresql';
import { SqliteEngine } from '../../../database-engines/sqlite-engine';
import { PostgresEngine } from '../../../database-engines/postgres-engine';
import { DuckDbEngine } from '../../../database-engines/duckdb-engine';
import { splitStatements } from '../../../services/sql-editor/statement-splitter';
import { classifyStatement } from '../../../services/sql-editor/statement-classifier';
import { EDITOR_MAX_ROWS, toEditorResult } from '../../../services/sql-editor/result-normalizer';
import { HISTORY_LIMIT, runEditorQuery, SqlEditorStateStore } from '../../../services/sql-editor/sql-editor-service';
import { handleIncomingMessage, setLicenseChecker } from '../../../services/messenger';

describe('SQL Editor', () => {
	describe('statement splitter', () => {
		it('splits on semicolons outside literals and comments', () => {
			const code = `SELECT 'a;b' AS x; -- note; here\nSELECT "c;d" FROM t /* ; */;\n\n  SELECT 3`
			assert.deepStrictEqual(splitStatements(code, 'sqlite').map(range => range.text), [
				`SELECT 'a;b' AS x`,
				`-- note; here\nSELECT "c;d" FROM t /* ; */`,
				'SELECT 3',
			])
		})

		it('keeps Postgres dollar-quoted bodies and reports offsets', () => {
			const code = `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nSELECT f();`
			const ranges = splitStatements(code, 'postgres')
			assert.strictEqual(ranges.length, 2)
			assert.ok(ranges[0].text.endsWith('LANGUAGE plpgsql'))
			assert.strictEqual(code.slice(ranges[1].from, ranges[1].to), 'SELECT f()')
		})

		it('keeps a SQLite trigger body in one statement', () => {
			const code = `CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; DELETE FROM c; END; SELECT 1;`
			assert.deepStrictEqual(splitStatements(code, 'sqlite').map(range => range.text), [
				'CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; DELETE FROM c; END',
				'SELECT 1',
			])
		})

		it('reads MySQL hash comments and backslash escapes, and MSSQL brackets', () => {
			assert.strictEqual(splitStatements(`SELECT 'it\\'s;'; # x; y\nSELECT 2`, 'mysql2').length, 2)
			assert.strictEqual(splitStatements(`SELECT [a;b] FROM t; SELECT 2`, 'mssql').length, 2)
		})

		it('does not split MongoDB JSON or skip comment-only text', () => {
			assert.strictEqual(splitStatements('{"collection":"a;b","operation":"find"}', 'mongodb').length, 1)
			assert.deepStrictEqual(splitStatements('-- only a comment;\n/* and this */', 'sqlite'), [])
		})
	})

	describe('statement classifier', () => {
		const cases: [string, string, Partial<ReturnType<typeof classifyStatement>>][] = [
			['SELECT * FROM users', 'postgres', { kind: 'read', verb: 'SELECT' }],
			['WITH x AS (SELECT 1) SELECT * FROM x', 'mysql2', { kind: 'read' }],
			['WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone', 'postgres', { kind: 'write' }],
			['SELECT * INTO backup FROM users', 'mssql', { kind: 'write' }],
			['PRAGMA table_info(users)', 'sqlite', { kind: 'read' }],
			['PRAGMA foreign_keys = OFF', 'sqlite', { kind: 'write' }],
			['PRAGMA table_info(users)', 'duckdb', { kind: 'write' }],
			['UPDATE "public"."users" SET name = \'x\'', 'postgres', { kind: 'write', verb: 'UPDATE', target: 'public.users', warning: 'No WHERE clause: this changes every row.' }],
			['UPDATE users SET name = \'x\' WHERE id = 1', 'postgres', { kind: 'write', target: 'users', warning: undefined }],
			['DELETE FROM `orders`', 'mysql2', { kind: 'write', target: 'orders', warning: 'No WHERE clause: this deletes every row.' }],
			['INSERT OR REPLACE INTO kv (k) VALUES (1)', 'sqlite', { kind: 'write', verb: 'INSERT', target: 'kv' }],
			['DROP TABLE IF EXISTS [dbo].[logs]', 'mssql', { kind: 'write', verb: 'DROP TABLE', target: 'dbo.logs', changesSchema: true }],
			['CREATE TABLE IF NOT EXISTS events (id int)', 'sqlite', { kind: 'write', verb: 'CREATE TABLE', target: 'events', changesSchema: true }],
			['ALTER TABLE users ADD COLUMN age int', 'postgres', { kind: 'write', verb: 'ALTER TABLE', target: 'users', changesSchema: true }],
			['TRUNCATE TABLE sessions', 'clickhouse', { kind: 'write', target: 'sessions', warning: 'This deletes every row.' }],
			['SELECT * FROM "Music" WHERE Artist = \'x\'', 'dynamodb', { kind: 'read' }],
			['DELETE FROM "Music" WHERE Artist = \'x\'', 'dynamodb', { kind: 'write', target: 'Music' }],
			['GET user:1', 'redis', { kind: 'read', verb: 'GET' }],
			['FLUSHALL', 'redis', { kind: 'write', verb: 'FLUSHALL', warning: 'This deletes every key.' }],
			['{"collection":"users","operation":"find","query":{}}', 'mongodb', { kind: 'read', verb: 'find' }],
			['{"collection":"users","operation":"aggregate","query":{"pipeline":[{"$out":"copy"}]}}', 'mongodb', { kind: 'write', target: 'copy' }],
		]

		for (const [text, engine, expected] of cases) {
			it(`${engine}: ${text}`, () => {
				const info = classifyStatement(text, engine)
				for (const [key, value] of Object.entries(expected)) {
					assert.deepStrictEqual((info as any)[key], value, `${key} of ${text}`)
				}
			})
		}

		it('ignores keywords inside strings and comments', () => {
			assert.strictEqual(classifyStatement(`SELECT 'DELETE FROM users' -- DROP TABLE x`, 'sqlite').kind, 'read')
		})
	})

	describe('result normalizer', () => {
		it('caps rows and keeps the real row count', () => {
			const rows = Array.from({ length: EDITOR_MAX_ROWS + 500 }, (_, id) => ({ id }))
			const result = toEditorResult(rows, 'SELECT', 3)
			assert.strictEqual(result.rows.length, EDITOR_MAX_ROWS)
			assert.strictEqual(result.rowCount, EDITOR_MAX_ROWS + 500)
			assert.strictEqual(result.moreRowsExist, false)
		})

		it('keeps exact values the webview can receive', () => {
			class ObjectId { constructor(private hex: string) { } toString() { return this.hex } }
			const result = toEditorResult([{
				big: 18446744073709551615n,
				blob: Buffer.from([0xde, 0xad]),
				at: new Date('2026-01-02T03:04:05Z'),
				json: { a: 1n },
				id: new ObjectId('65af'),
				nan: NaN,
			}], 'SELECT', 1)
			assert.deepStrictEqual(result.rows[0], {
				big: '18446744073709551615',
				blob: '0xdead',
				at: '2026-01-02T03:04:05.000Z',
				json: '{"a":"1"}',
				id: '65af',
				nan: 'NaN',
			})
		})

		it('reads each engine shape', () => {
			assert.deepStrictEqual(toEditorResult({ affectedRows: 3, insertId: 0 }, 'UPDATE', 1).affectedRows, 3)
			assert.deepStrictEqual(toEditorResult({ changes: 2, lastID: 9 }, 'DELETE', 1).affectedRows, 2)
			assert.deepStrictEqual(toEditorResult('[{"n":"1"}]', 'SELECT', 1).rows, [{ n: '1' }])
			assert.deepStrictEqual(toEditorResult({ rows: [], columns: ['id', 'name'], command: 'SELECT' }, 'SELECT', 1).columns, ['id', 'name'])
			assert.strictEqual(toEditorResult({ rows: [], columns: [], affectedRows: 4, command: 'UPDATE' }, 'UPDATE', 1).affectedRows, 4)
			assert.deepStrictEqual(toEditorResult(42, 'count', 1).rows, [{ result: 42 }])
			assert.strictEqual(toEditorResult(Object.assign([{ a: 1 }], { truncated: true }), 'SELECT', 1).moreRowsExist, true)
			assert.deepStrictEqual(toEditorResult([{ a: 1 }, { b: 2 }], 'find', 1).columns, ['a', 'b'])
		})
	})

	describe('run against SQLite', () => {
		let dir: string
		let engine: SqliteEngine

		before(async () => {
			dir = mkdtempSync(join(tmpdir(), 'devdb-sql-editor-'))
			engine = new SqliteEngine(join(dir, 'editor.sqlite'))
			await engine.raw('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
			await engine.raw(`INSERT INTO users (name) VALUES ('Ada'), ('Linus'), ('Grace')`)
		})

		after(() => {
			engine.destroy()
			rmSync(dir, { recursive: true, force: true })
		})

		it('runs reads at once', async () => {
			const response = await runEditorQuery(engine, { runId: 'r1', code: 'SELECT name FROM users ORDER BY id; SELECT count(*) AS n FROM users' })
			assert.strictEqual(response.runId, 'r1')
			assert.strictEqual(response.needsConfirmation, undefined)
			assert.deepStrictEqual(response.results?.map(result => result.rows), [[{ name: 'Ada' }, { name: 'Linus' }, { name: 'Grace' }], [{ n: 3 }]])
			assert.strictEqual(response.wroteData, false)
		})

		it('lists writes and runs nothing until the user confirms', async () => {
			const code = `SELECT 1; UPDATE users SET name = 'X'`
			const response = await runEditorQuery(engine, { runId: 'r2', code })
			assert.strictEqual(response.results, undefined)
			assert.deepStrictEqual(response.needsConfirmation?.map(info => [info.verb, info.target, info.warning]), [['UPDATE', 'users', 'No WHERE clause: this changes every row.']])
			assert.deepStrictEqual(await engine.rawQuery(`SELECT count(*) AS n FROM users WHERE name = 'X'`), [{ n: 0 }])
		})

		it('runs confirmed writes and reports what changed', async () => {
			const response = await runEditorQuery(engine, { runId: 'r3', code: `UPDATE users SET name = 'Ada L' WHERE id = 1; CREATE TABLE notes (id INTEGER)`, confirmed: true })
			assert.strictEqual(response.results?.[0].kind, 'affected')
			assert.strictEqual(response.results?.[0].affectedRows, 1)
			assert.deepStrictEqual(response.tablesWritten, ['users', 'notes'])
			assert.strictEqual(response.wroteData, true)
			assert.strictEqual(response.schemaChanged, true)
		})

		it('stops at the first error and keeps earlier results', async () => {
			const response = await runEditorQuery(engine, { runId: 'r4', code: 'SELECT 1 AS one; SELECT * FROM missing_table; SELECT 2' })
			assert.strictEqual(response.results?.length, 2)
			assert.match(response.results![1].error ?? '', /no such table/)
		})

		it('treats engine statements such as ATTACH as writes', async () => {
			const response = await runEditorQuery(engine, { runId: 'r5', code: `SELECT 1; ATTACH DATABASE 'x.db' AS x` })
			assert.ok(response.needsConfirmation?.length, 'ATTACH is a write')
		})

		it('caps a large result at the editor row limit', async () => {
			const response = await runEditorQuery(engine, { runId: 'r6', code: 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500) SELECT i FROM n' })
			assert.strictEqual(response.results?.[0].rows.length, EDITOR_MAX_ROWS)
			assert.strictEqual(response.results?.[0].rowCount, 1500)
		})

		it('stops waiting when the user cancels, also on engines that cannot interrupt a query', async () => {
			const stuck = { getType: () => 'sqlite', rawQuery: () => new Promise(() => undefined) } as unknown as SqliteEngine
			const controller = new AbortController()
			setTimeout(() => controller.abort(), 20)
			const response = await runEditorQuery(stuck, { runId: 'r8', code: 'SELECT 1' }, controller.signal)
			assert.strictEqual(response.results?.[0].error, 'Query cancelled')
		})

		it('says when there is nothing to run', async () => {
			assert.strictEqual((await runEditorQuery(engine, { runId: 'r7', code: ' -- nothing ' })).error, 'Nothing to run')
		})
	})

	describe('run against DuckDB', () => {
		let dbPath: string
		let engine: DuckDbEngine

		before(() => {
			dbPath = join(tmpdir(), `devdb-sql-editor-${Date.now()}.duckdb`)
			engine = new DuckDbEngine(dbPath, { readOnly: false })
		})

		after(async () => {
			await engine.disconnect()
			engine.destroy()
			rmSync(dbPath, { force: true })
		})

		it('reports affected rows and exact decimals', async () => {
			await runEditorQuery(engine, { runId: 'd1', code: 'CREATE TABLE prices (id INTEGER, amount DECIMAL(18,4))', confirmed: true })
			const insert = await runEditorQuery(engine, { runId: 'd2', code: 'INSERT INTO prices VALUES (1, 99999999999999.9999), (2, 1.5)', confirmed: true })
			assert.strictEqual(insert.results?.[0].affectedRows, 2)

			const read = await runEditorQuery(engine, { runId: 'd3', code: 'SELECT amount FROM prices ORDER BY id' })
			assert.strictEqual(read.results?.[0].rows[0].amount, '99999999999999.9999')
		})
	})

	describe('run against Postgres', () => {
		let container: StartedPostgreSqlContainer
		let engine: PostgresEngine

		before(async function () {
			container = await new PostgreSqlContainer('postgres:13.3-alpine')
				.withName('devdb-test-container-postgres')
				.withReuse()
				.start()
			engine = new PostgresEngine(knexlib({
				client: 'postgres',
				connection: {
					host: container.getHost(),
					port: container.getPort(),
					user: container.getUsername(),
					password: container.getPassword(),
					database: container.getDatabase(),
				},
			}))
			await engine.rawQuery('DROP TABLE IF EXISTS editor_items; CREATE TABLE editor_items (id serial PRIMARY KEY, label text)')
		})

		after(async () => {
			await engine.rawQuery('DROP TABLE IF EXISTS editor_items')
			await engine.connection?.destroy()
		})

		it('returns columns for an empty result and affected rows for writes', async () => {
			const empty = await runEditorQuery(engine, { runId: 'p1', code: 'SELECT id, label FROM editor_items' })
			assert.deepStrictEqual(empty.results?.[0].columns, ['id', 'label'])
			assert.strictEqual(empty.results?.[0].rowCount, 0)

			const insert = await runEditorQuery(engine, { runId: 'p2', code: `INSERT INTO editor_items (label) VALUES ('a'), ('b')`, confirmed: true })
			assert.strictEqual(insert.results?.[0].kind, 'affected')
			assert.strictEqual(insert.results?.[0].affectedRows, 2)

			const returning = await runEditorQuery(engine, { runId: 'p3', code: `UPDATE editor_items SET label = 'c' WHERE id = 1 RETURNING label`, confirmed: true })
			assert.deepStrictEqual(returning.results?.[0].rows, [{ label: 'c' }])
		})

		it('runs reads inside a read-only transaction', async () => {
			const response = await runEditorQuery(engine, { runId: 'p4', code: `SELECT nextval('editor_items_id_seq')` })
			assert.strictEqual(response.needsConfirmation, undefined)
			assert.match(response.results?.[0].error ?? '', /read-only transaction/)
		})
	})

	describe('state store', () => {
		it('keeps the last history entries and clamps the pane size', async () => {
			const fake = createFakeExtensionContext()
			const store = new SqlEditorStateStore()
			store.setExtensionContext(fake.context)

			const history = Array.from({ length: HISTORY_LIMIT + 10 }, (_, index) => ({ code: `SELECT ${index}`, ranAt: index, ok: true }))
			await store.save('provider:sqlite', { history: [...history, { code: '   ', ranAt: 1, ok: true }], draft: 'SELECT 1', split: 3 })

			const state = store.get('provider:sqlite')
			assert.strictEqual(state.history.length, HISTORY_LIMIT)
			assert.strictEqual(state.history[0].code, 'SELECT 0')
			assert.strictEqual(state.draft, 'SELECT 1')
			assert.strictEqual(state.split, 0.85)
			assert.deepStrictEqual(store.get('remote:other'), { history: [] })
		})
	})

	describe('Pro gate', () => {
		type Posted = { type: string, value?: any }

		async function send(message: Posted): Promise<Posted> {
			const posted: Posted[] = []
			const webviewView = { webview: { postMessage: async (payload: Posted) => { posted.push(payload) } } }
			await handleIncomingMessage(message, webviewView as any)
			return posted[0]
		}

		after(() => setLicenseChecker(() => false))

		it('refuses the editor without a license', async () => {
			setLicenseChecker(() => false)
			const response = await send({ type: 'request:run-raw-command', value: { runId: 'g1', code: 'SELECT 1' } })
			assert.strictEqual(response.type, 'response:run-raw-command')
			assert.strictEqual(response.value.runId, 'g1')
			assert.match(response.value.error, /SQL Editor is a DevDb Pro feature/)

			const schema = await send({ type: 'request:get-sql-editor-schema' })
			assert.match(schema.value.error, /SQL Editor is a DevDb Pro feature/)
		})

		it('runs the editor with a license', async () => {
			setLicenseChecker(() => true)
			const response = await send({ type: 'request:run-raw-command', value: { runId: 'g2', code: 'SELECT 1' } })
			assert.strictEqual(response.value.error, 'No database selected')
		})
	})
})
