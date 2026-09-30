import { shownMessages } from '../vscode-stub';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
	d1ObjectDirectory,
	durableObjectIdFromName,
	findWranglerConfigFiles,
	localD1FileName,
	parseD1FromJsonc,
	parseD1FromToml,
	persistRootsFor,
	resolveLocalD1Databases,
	stripJsonc,
} from '../../../providers/cloudflare/wrangler-config';
import { CloudflareD1LocalProvider, discoverLocalD1Options, missingD1FileMessage } from '../../../providers/sqlite/cloudflare-d1-local-provider';
import { findD1Suggestions } from '../../../providers/cloudflare/d1-suggestions';
import { D1LocalSqliteEngine } from '../../../database-engines/d1-local-sqlite-engine';
import { SqliteEngine } from '../../../database-engines/sqlite-engine';

async function createSqlite(file: string, sql: string): Promise<void> {
	mkdirSync(join(file, '..'), { recursive: true });
	const engine = new SqliteEngine(file);
	for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) {
		await engine.rawQuery(statement);
	}
	await engine.disconnect();
}

describe('Cloudflare D1 (local) provider', () => {
	describe('local file names (Miniflare Durable Object ids)', () => {
		/**
		 * Recorded from wrangler 4.145.0: `wrangler d1 execute <db> --local` wrote these files for
		 * a wrangler.jsonc with bindings DB (database_id only), ANALYTICS (database_id and
		 * preview_database_id "prev-1111") and NOID (no ids).
		 */
		it('matches the files wrangler wrote', () => {
			assert.strictEqual(localD1FileName({ binding: 'DB', databaseId: '4b1c6a0e-2f7d-4c1e-9d6a-8a3f5e2b7c91' }), '285ec869a673db37f488aefade4a3953aa3e4724a48cf491d78235a55d3c762a.sqlite');
			assert.strictEqual(localD1FileName({ binding: 'ANALYTICS', databaseId: '9d2f7e1a-3c4b-4d5e-8f6a-1b2c3d4e5f60', previewDatabaseId: 'prev-1111' }), 'fda220db12ce1538fbca5fbeb86f70f5b2b52c28227a6ba7b7e94cd9833dbb06.sqlite');
			assert.strictEqual(localD1FileName({ binding: 'NOID' }), '4352776c43bd0755e466d0f7c7a1f4b761c294a796aa48768ba01c743affd068.sqlite');
		});

		it('derives 32-byte ids from the namespace key', () => {
			assert.match(durableObjectIdFromName('miniflare-D1DatabaseObject', 'x'), /^[0-9a-f]{64}$/);
			assert.notStrictEqual(durableObjectIdFromName('miniflare-D1DatabaseObject', 'x'), durableObjectIdFromName('miniflare-KVNamespaceObject', 'x'));
		});
	});

	describe('wrangler config parsing', () => {
		it('reads wrangler.jsonc with comments and trailing commas', () => {
			const text = `{
				// line comment
				"name": "demo", /* block */
				"routes": ["https://example.com/*"],
				"d1_databases": [
					{ "binding": "DB", "database_name": "db // not a comment", "database_id": "id-1", "migrations_dir": "db/migrations", },
				],
			}`;
			assert.deepStrictEqual(parseD1FromJsonc(text), [{ binding: 'DB', database_name: 'db // not a comment', database_id: 'id-1', migrations_dir: 'db/migrations' }]);
			assert.strictEqual(stripJsonc('{"a": "x,}"}'), '{"a": "x,}"}');
		});

		it('reads [[d1_databases]] tables and ignores [env.*] entries', () => {
			const text = `name = "demo"
main = "src/index.ts"

[[d1_databases]]
binding = "DB" # the main database
database_name = "prod-db"
database_id = "id-1"
migrations_dir = 'migrations'

[vars]
database_id = "not-a-d1-field"

[[d1_databases]]
binding = "ANALYTICS"
database_name = "analytics"
database_id = "id-2"
preview_database_id = "id-2-preview"

[[env.staging.d1_databases]]
binding = "DB"
database_id = "staging-id"
`;
			assert.deepStrictEqual(parseD1FromToml(text), [
				{ binding: 'DB', database_name: 'prod-db', database_id: 'id-1', migrations_dir: 'migrations' },
				{ binding: 'ANALYTICS', database_name: 'analytics', database_id: 'id-2', preview_database_id: 'id-2-preview' },
			]);
		});

		it('reads an inline d1_databases array', () => {
			const text = `name = "demo"
d1_databases = [
  { binding = "DB", database_name = "a", database_id = "id-a" },
  { binding = "B", database_name = "b", database_id = "id-b" }
]
`;
			assert.deepStrictEqual(parseD1FromToml(text).map(entry => entry.binding), ['DB', 'B']);
		});
	});

	describe('workspace discovery', () => {
		let root: string;

		beforeEach(() => {
			root = mkdtempSync(join(tmpdir(), 'devdb-d1-'));
			shownMessages.length = 0;
		});

		afterEach(() => {
			rmSync(root, { recursive: true, force: true });
		});

		function writeWorker(dir: string, config: string, packageJson?: object) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'wrangler.jsonc'), config);
			if (packageJson) writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson));
		}

		const twoBindings = `{
			"d1_databases": [
				{ "binding": "DB", "database_name": "app-db", "database_id": "4b1c6a0e-2f7d-4c1e-9d6a-8a3f5e2b7c91" },
				{ "binding": "CACHE", "database_name": "cache-db", "database_id": "cache-id" },
			],
		}`;

		it('finds wrangler configs in the root and in nested workers, not in node_modules', () => {
			writeWorker(root, twoBindings);
			writeWorker(join(root, 'apps', 'api'), twoBindings);
			writeWorker(join(root, 'node_modules', 'pkg'), twoBindings);
			assert.deepStrictEqual(findWranglerConfigFiles(root), [join(root, 'wrangler.jsonc'), join(root, 'apps', 'api', 'wrangler.jsonc')]);
		});

		it('prefers --persist-to dirs from package.json scripts, then .wrangler/state', () => {
			writeWorker(root, twoBindings, { scripts: { dev: 'wrangler dev --persist-to ./state', migrate: 'wrangler d1 migrations apply app-db --local --persist-to=../shared-state' } });
			assert.deepStrictEqual(persistRootsFor(join(root, 'wrangler.jsonc')), [join(root, 'state'), join(root, '..', 'shared-state'), join(root, '.wrangler', 'state')]);
		});

		it('maps bindings to files, flags missing ones and lists unmapped files with their tables', async () => {
			writeWorker(root, twoBindings);
			const objects = d1ObjectDirectory(join(root, '.wrangler', 'state'));
			await createSqlite(join(objects, '285ec869a673db37f488aefade4a3953aa3e4724a48cf491d78235a55d3c762a.sqlite'), 'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await createSqlite(join(objects, `${'ab'.repeat(32)}.sqlite`), 'CREATE TABLE legacy (id INTEGER); CREATE TABLE notes (id INTEGER)');
			await createSqlite(join(objects, 'metadata.sqlite'), 'CREATE TABLE _cf_ALARM (actor_id TEXT)');

			const { cache, pending } = await discoverLocalD1Options(root);

			assert.deepStrictEqual(cache.map(option => [option.description, option.details]), [
				['Cloudflare D1 (local) — DB binding', 'app-db · .wrangler/state/v3/d1/miniflare-D1DatabaseObject/285ec869a673db37f488aefade4a3953aa3e4724a48cf491d78235a55d3c762a.sqlite'],
				['Cloudflare D1 (local) — CACHE binding', 'Not created yet — run wrangler d1 migrations apply cache-db --local (wrangler.jsonc)'],
				['Cloudflare D1 (local) — unmapped file abababab…', `Tables: legacy, notes · .wrangler/state/v3/d1/miniflare-D1DatabaseObject/${'ab'.repeat(32)}.sqlite`],
			]);
			assert.deepStrictEqual([...pending.values()].map(db => db.binding), ['CACHE']);
			assert.deepStrictEqual(cache.map(option => option.engine.getType()), ['sqlite', 'sqlite', 'sqlite']);
			assert.deepStrictEqual(await cache[0].engine.getTables(), ['users']);
			await Promise.all(cache.map(option => option.engine.disconnect()));
		});

		it('uses a --persist-to dir when the file lives there', async () => {
			writeWorker(root, twoBindings, { scripts: { dev: 'wrangler dev --persist-to .state' } });
			await createSqlite(join(d1ObjectDirectory(join(root, '.state')), '285ec869a673db37f488aefade4a3953aa3e4724a48cf491d78235a55d3c762a.sqlite'), 'CREATE TABLE t (id INTEGER)');

			const [db] = resolveLocalD1Databases(join(root, 'wrangler.jsonc'));
			assert.strictEqual(db.exists, true);
			assert.strictEqual(db.file, join(root, '.state', 'v3', 'd1', 'miniflare-D1DatabaseObject', '285ec869a673db37f488aefade4a3953aa3e4724a48cf491d78235a55d3c762a.sqlite'));
		});

		it('shows the wrangler hint for a binding without a file and never creates it', async () => {
			writeWorker(root, twoBindings);
			(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: root } }];
			try {
				await CloudflareD1LocalProvider.boot!();
				assert.strictEqual(await CloudflareD1LocalProvider.canBeUsedInCurrentWorkspace(), true);

				const cacheOption = CloudflareD1LocalProvider.cache!.find(option => option.description.includes('CACHE'))!;
				const engine = await CloudflareD1LocalProvider.getDatabaseEngine({ provider: 'cloudflare-d1-local', option: { id: cacheOption.id, description: cacheOption.description } });

				assert.strictEqual(engine, undefined);
				assert.deepStrictEqual(shownMessages, [missingD1FileMessage({ binding: 'CACHE', databaseName: 'cache-db' })]);
				assert.match(shownMessages[0], /Run `wrangler d1 migrations apply cache-db --local` or `wrangler dev` first/);
				assert.strictEqual(existsSync(join(root, '.wrangler')), false);
			} finally {
				(vscode.workspace as any).workspaceFolders = undefined;
			}
		});

		it('is not offered without a wrangler config', async () => {
			assert.deepStrictEqual((await discoverLocalD1Options(root)).cache, []);
		});

		it('offers database ids for the remote D1 dialog', () => {
			writeWorker(root, twoBindings);
			writeWorker(join(root, 'workers', 'no-id'), '{ "d1_databases": [ { "binding": "LOCAL_ONLY", "database_name": "x" } ] }');
			assert.deepStrictEqual(findD1Suggestions(root), [
				{ binding: 'DB', databaseName: 'app-db', databaseId: '4b1c6a0e-2f7d-4c1e-9d6a-8a3f5e2b7c91', configFile: 'wrangler.jsonc' },
				{ binding: 'CACHE', databaseName: 'cache-db', databaseId: 'cache-id', configFile: 'wrangler.jsonc' },
			]);
		});
	});

	it('hides D1 internal tables in the local engine', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'devdb-d1-engine-'));
		try {
			const file = join(dir, 'x.sqlite');
			await createSqlite(file, 'CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB); CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE posts (id INTEGER)');
			const engine = new D1LocalSqliteEngine(file);
			assert.deepStrictEqual(await engine.getTables(), ['d1_migrations', 'posts']);
			await engine.disconnect();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
