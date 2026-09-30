import * as assert from 'assert';
import { existsSync, mkdtempSync, openSync, readdirSync, rmSync, writeSync, closeSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Module = require('module');
import { WasmDatabase } from '../../../database-engines/sqlite-backend';

type Row = Record<string, any>;

function open(file: string): Promise<WasmDatabase> {
	return new Promise((resolve, reject) => {
		const db: WasmDatabase = new WasmDatabase(file, (err) => err ? reject(err) : resolve(db));
	});
}

const all = (db: WasmDatabase, sql: string, params: any[] = []) => new Promise<Row[]>((resolve, reject) => db.all(sql, params, (err: Error | null, rows?: Row[]) => err ? reject(err) : resolve(rows!)));
const run = (db: WasmDatabase, sql: string) => new Promise<{ changes: number, lastID: number }>((resolve, reject) => db.run(sql, function (this: any, err: Error | null) { err ? reject(err) : resolve({ changes: this.changes, lastID: this.lastID }); }));
const close = (db: WasmDatabase) => new Promise<void>((resolve, reject) => db.close((err) => err ? reject(err) : resolve()));

/**
 * Marks a rollback-journal database as WAL (file format bytes 18-19 = 2), as `PRAGMA journal_mode=WAL` does.
 */
function markAsWal(file: string): void {
	const fd = openSync(file, 'r+');
	writeSync(fd, Buffer.from([2, 2]), 0, 2, 18);
	closeSync(fd);
}

describe('SQLite WASM backend', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'devdb-sqlite-wasm-'));
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it('reads and writes the database file in place', async () => {
		const file = join(dir, 'app.sqlite');
		const db = await open(file);
		await run(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
		assert.deepStrictEqual(await run(db, "INSERT INTO t (v) VALUES ('a')"), { changes: 1, lastID: 1 });
		await close(db);

		const again = await open(file);
		assert.deepStrictEqual(await all(again, 'SELECT v FROM t WHERE id = ?', [1]), [{ v: 'a' }]);
		await close(again);
		assert.deepStrictEqual(readdirSync(dir), ['app.sqlite']);
	});

	it('opens WAL databases read-only and sees the committed data', async () => {
		const file = join(dir, 'wal.sqlite');
		const setup = await open(file);
		await run(setup, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
		await run(setup, "INSERT INTO t (v) VALUES ('a')");
		await close(setup);
		markAsWal(file);

		const db = await open(file);
		assert.deepStrictEqual(await all(db, 'SELECT v FROM t'), [{ v: 'a' }]);
		await run(db, 'PRAGMA query_only = ON');
		await assert.rejects(run(db, "INSERT INTO t (v) VALUES ('b')"), /read-only/);
		await close(db);
		assert.deepStrictEqual(readdirSync(dir), ['wal.sqlite']);
	});

	it('reads uncheckpointed WAL data written by the native driver while it is open', async function () {
		let native: typeof import('@vscode/sqlite3');
		try {
			native = require('@vscode/sqlite3');
		} catch {
			this.skip();
		}

		const file = join(dir, 'app.sqlite');
		const app = new native!.Database(file);
		const exec = (sql: string) => new Promise<void>((resolve, reject) => app.run(sql, (err) => err ? reject(err) : resolve()));
		await exec('PRAGMA journal_mode = WAL');
		await exec('PRAGMA wal_autocheckpoint = 0');
		await exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
		await exec("INSERT INTO t (v) VALUES ('a')");
		assert.ok(existsSync(`${file}-wal`));

		const db = await open(file);
		assert.deepStrictEqual(await all(db, 'SELECT v FROM t'), [{ v: 'a' }]);
		await exec("INSERT INTO t (v) VALUES ('b')");
		assert.deepStrictEqual(await all(db, 'SELECT v FROM t ORDER BY id'), [{ v: 'a' }, { v: 'b' }]);
		await close(db);

		await exec("INSERT INTO t (v) VALUES ('c')");
		await new Promise<void>((resolve) => app.close(() => resolve()));
	});

	it('falls back to WASM when the native binary fails to load', () => {
		const backendPath = require.resolve('../../../database-engines/sqlite-backend');
		const moduleWithLoad = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
		const load = moduleWithLoad._load;
		const cached = require.cache[backendPath];
		const forced = process.env.DEVDB_FORCE_SQLITE_WASM;
		delete process.env.DEVDB_FORCE_SQLITE_WASM;
		delete require.cache[backendPath];
		moduleWithLoad._load = function (request: string, ...rest: unknown[]) {
			if (request === '@vscode/sqlite3') {
				throw new Error('vscode-sqlite3.node: wrong ELF class');
			}
			return load.call(this, request, ...rest);
		};

		try {
			const fresh = require(backendPath);
			assert.strictEqual(fresh.getSqliteBackend().name, 'wasm');
			assert.strictEqual(fresh.getSqliteBackend().Database, fresh.WasmDatabase);
		} finally {
			moduleWithLoad._load = load;
			require.cache[backendPath] = cached;
			if (forced !== undefined) {
				process.env.DEVDB_FORCE_SQLITE_WASM = forced;
			}
		}
	});
});
