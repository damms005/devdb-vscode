import { openSync, readSync, closeSync } from 'fs';
import type { Database } from '@vscode/sqlite3';

export type SqliteBackendName = 'native' | 'wasm';

type Callback<T = any> = (this: any, err: Error | null, result?: T) => void;

/**
 * The subset of the `@vscode/sqlite3` `Database` API that `SqliteEngine` uses.
 */
export type SqliteDatabaseConstructor = new (filename: string, callback?: (err: Error | null) => void) => Database;

type WasmModule = typeof import('node-sqlite3-wasm');
type WasmConnection = InstanceType<WasmModule['Database']>;

let backend: { name: SqliteBackendName, Database: SqliteDatabaseConstructor } | undefined;

/**
 * Loads `@vscode/sqlite3` (native) and falls back to `node-sqlite3-wasm` when the native
 * binary cannot load: e.g. the universal VSIX (Open VSX) ships only a linux-x64 binary, and
 * the native build needs glibc 2.29. `DEVDB_FORCE_SQLITE_WASM=1` forces the WASM backend.
 */
export function getSqliteBackend(): { name: SqliteBackendName, Database: SqliteDatabaseConstructor } {
	if (backend) {
		return backend;
	}

	let reason = 'DEVDB_FORCE_SQLITE_WASM=1';
	if (process.env.DEVDB_FORCE_SQLITE_WASM !== '1') {
		try {
			backend = { name: 'native', Database: require('@vscode/sqlite3').Database };
			logBackend('SQLite backend: native');
			return backend;
		} catch (error) {
			reason = `native binary failed to load: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	backend = { name: 'wasm', Database: WasmDatabase as unknown as SqliteDatabaseConstructor };
	logBackend(`SQLite backend: wasm (${reason})`);
	return backend;
}

function logBackend(message: string): void {
	try {
		require('../services/output-service').logToOutput(message, 'SQLite');
	} catch {
		// No `vscode` module outside the extension host (tests).
	}
}

/**
 * True when the SQLite header says the file uses WAL (write-ahead log) journaling.
 * https://www.sqlite.org/fileformat.html#file_format_version_numbers
 */
function isWalDatabase(filename: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(filename, 'r');
		const header = Buffer.alloc(20);
		return readSync(fd, header, 0, 20, 0) === 20
			&& header.toString('latin1', 0, 15) === 'SQLite format 3'
			&& header[18] === 2 && header[19] === 2;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			closeSync(fd);
		}
	}
}

/**
 * Callback adapter over the synchronous `node-sqlite3-wasm` API, shaped like `@vscode/sqlite3`.
 *
 * The WASM file system cannot share WAL memory (`-shm`) with other processes. So a WAL
 * database opens read-only: each statement uses a fresh read-only connection in EXCLUSIVE
 * locking mode (a private WAL index), which sees all committed data and never changes the files.
 */
export class WasmDatabase {
	private connection: WasmConnection | null = null;
	private readonly walReadOnly: boolean;

	constructor(private readonly filename: string, callback?: (err: Error | null) => void) {
		this.walReadOnly = filename !== ':memory:' && isWalDatabase(filename);
		let error: Error | null = null;
		try {
			if (!this.walReadOnly) {
				this.connection = new (wasm().Database)(filename);
			}
		} catch (err) {
			error = toError(err);
		}
		if (callback) {
			setImmediate(() => callback(error));
		} else if (error) {
			throw error;
		}
	}

	get(sql: string, ...args: any[]): this {
		const [params, callback] = splitArgs(args);
		this.execute(callback, db => normalizeRow(db.get(sql, params)) ?? undefined);
		return this;
	}

	all(sql: string, ...args: any[]): this {
		const [params, callback] = splitArgs(args);
		this.execute(callback, db => db.all(sql, params).map(normalizeRow));
		return this;
	}

	run(sql: string, ...args: any[]): this {
		const [params, callback] = splitArgs(args);
		let result = { changes: 0, lastID: 0 };
		this.execute(function (this: any, err: Error | null) {
			callback?.call(result, err);
		}, db => {
			if (this.walReadOnly) {
				if (/^\s*PRAGMA\s+query_only\b/i.test(sql)) {
					return;
				}
				throw new Error('SQLite WASM backend opens WAL-mode databases read-only. Install the DevDb build for your platform to edit this database.');
			}
			const { changes, lastInsertRowid } = db.run(sql, params);
			result = { changes, lastID: Number(lastInsertRowid) };
		});
		return this;
	}

	close(callback?: (err: Error | null) => void): void {
		let error: Error | null = null;
		try {
			this.connection?.close();
			this.connection = null;
		} catch (err) {
			error = toError(err);
		}
		setImmediate(() => callback?.(error));
	}

	private execute(callback: Callback | undefined, work: (db: WasmConnection) => any): void {
		let error: Error | null = null;
		let result: any;
		try {
			if (this.walReadOnly) {
				const db = new (wasm().Database)(this.filename, { readOnly: true, fileMustExist: true });
				try {
					db.exec('PRAGMA locking_mode = EXCLUSIVE');
					result = work(db);
				} finally {
					db.close();
				}
			} else {
				if (!this.connection) {
					throw new Error('SQLite database is closed');
				}
				result = work(this.connection);
			}
		} catch (err) {
			error = toError(err);
		}
		setImmediate(() => callback?.call(this, error, result));
	}
}

let wasmModule: WasmModule | undefined;

function wasm(): WasmModule {
	wasmModule ??= require('node-sqlite3-wasm') as WasmModule;
	return wasmModule;
}

function splitArgs(args: any[]): [any[] | undefined, Callback | undefined] {
	const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
	const params = args.length === 0 ? undefined : (args.length === 1 && (Array.isArray(args[0]) || typeof args[0] === 'object') ? args[0] : args);
	return [params, callback];
}

/**
 * Matches native values: integers outside the safe range become (lossy) numbers, and BLOBs become Buffers.
 */
function normalizeRow(row: Record<string, any> | null): Record<string, any> | null {
	if (!row) {
		return row;
	}
	for (const key of Object.keys(row)) {
		const value = row[key];
		if (typeof value === 'bigint') {
			row[key] = Number(value);
		} else if (value instanceof Uint8Array) {
			row[key] = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
		}
	}
	return row;
}

function toError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}
