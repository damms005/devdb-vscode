import { createFakeExtensionContext, shownMessages } from '../vscode-stub';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { createRemoteEngine, setCloudflareApiBaseForTests, testRemoteConnection } from '../../../services/connection-tester';
import { remoteConnectionStorageService } from '../../../services/remote-connection-storage-service';
import { remoteCredentialService } from '../../../services/remote-credential-service';
import { setProLicenseChecker } from '../../../services/pro-gate';
import { D1Mock, startD1Mock } from '../engines/d1-mock-server';
import { TursoProvider, tursoConnectionFromDrizzleConfig, tursoConnectionFromEnv } from '../../../providers/sqlite/turso-provider';

describe('Edge SQL connections (Cloudflare D1, Turso)', () => {
	let licensed = true;

	before(() => {
		const fake = createFakeExtensionContext();
		remoteCredentialService.setExtensionContext(fake.context);
		remoteConnectionStorageService.setExtensionContext(fake.context);
		setProLicenseChecker(() => licensed);
	});

	beforeEach(() => {
		licensed = true;
		shownMessages.length = 0;
	});

	describe('Cloudflare D1 remote connection (mock API)', () => {
		let mock: D1Mock;

		before(async () => {
			mock = await startD1Mock();
			await mock.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
			setCloudflareApiBaseForTests(mock.apiBase);
		});

		after(async () => {
			setCloudflareApiBaseForTests(undefined);
			await mock.close();
		});

		const form = () => ({ connectionType: 'cloudflare-d1' as const, connectionName: 'd1', accountId: mock.accountId, databaseId: mock.databaseId, dbPassword: mock.token });

		it('tests a connection with account id, database id and API token', async () => {
			assert.deepStrictEqual(await testRemoteConnection(form()), { success: true, message: 'Connection successful' });
			assert.strictEqual(mock.requests[mock.requests.length - 1].authorization, `Bearer ${mock.token}`);
		});

		it('opens a d1 engine for a saved connection', async () => {
			const { connection, update } = await remoteConnectionStorageService.prepareFromForm(form());
			const saved = await remoteConnectionStorageService.save(connection, update);
			const result = await createRemoteEngine(saved, await remoteConnectionStorageService.getSecrets(saved));
			assert.ok(result.engine, result.error);
			assert.strictEqual(result.engine.getType(), 'd1');
			assert.deepStrictEqual(await result.engine.getTables(), ['notes']);
		});

		it('reports a wrong token without leaking it', async () => {
			const result = await testRemoteConnection({ ...form(), dbPassword: 'wrong-token-xyz' });
			assert.strictEqual(result.success, false);
			assert.match(result.message, /^Failed to connect to Cloudflare D1: Cloudflare D1 error \(HTTP 401\): Authentication error/);
			assert.ok(!result.message.includes('wrong-token-xyz'));
		});

		it('asks for the token when it is missing', async () => {
			const result = await testRemoteConnection({ ...form(), dbPassword: '' });
			assert.deepStrictEqual(result, { success: false, message: 'The API token for "d1" was not found. Edit the connection and enter the token again.' });
		});

		it('refuses without a Pro license', async () => {
			licensed = false;
			const before = mock.requests.length;
			const result = await testRemoteConnection(form());
			assert.deepStrictEqual(result, { success: false, message: 'DevDb Pro required: Cloudflare D1 (remote) is a DevDb Pro feature. Activate a DevDb Pro license to use it.' });
			assert.strictEqual(mock.requests.length, before);
		});
	});

	describe('Turso / libSQL (live sqld)', () => {
		let container: StartedTestContainer | undefined;
		let url: string;

		before(async function () {
			this.timeout(180000);
			url = process.env.LIBSQL_TEST_URL ?? '';
			if (!url) {
				container = await new GenericContainer('ghcr.io/tursodatabase/libsql-server:latest')
					.withName('devdb-test-container-libsql')
					.withExposedPorts(8080)
					.withWaitStrategy(Wait.forHttp('/health', 8080))
					.withReuse()
					.start();
				url = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
			}
		});

		it('tests a remote connection', async () => {
			assert.deepStrictEqual(await testRemoteConnection({ connectionType: 'turso', connectionName: 't', libsqlUrl: url, dbPassword: 'any' }), { success: true, message: 'Connection successful' });
		});

		it('rejects a URL that is not libSQL', async () => {
			const result = await testRemoteConnection({ connectionType: 'turso', connectionName: 't', libsqlUrl: 'postgres://x' });
			assert.deepStrictEqual(result, { success: false, message: 'Turso / libSQL needs a libsql://, https:// or http:// URL' });
		});

		it('reports an unreachable server', async () => {
			const result = await testRemoteConnection({ connectionType: 'turso', connectionName: 't', libsqlUrl: 'http://127.0.0.1:1' });
			assert.strictEqual(result.success, false);
			assert.match(result.message, /^Failed to connect to Turso \/ libSQL: /);
		});

		it('refuses without a Pro license', async () => {
			licensed = false;
			const result = await testRemoteConnection({ connectionType: 'turso', connectionName: 't', libsqlUrl: url });
			assert.match(result.message, /DevDb Pro required: Turso \/ libSQL/);
		});

		describe('workspace provider', () => {
			let root: string;

			beforeEach(() => {
				root = mkdtempSync(join(tmpdir(), 'devdb-turso-'));
				(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: root } }];
			});

			afterEach(() => {
				(vscode.workspace as any).workspaceFolders = undefined;
				rmSync(root, { recursive: true, force: true });
			});

			it('connects from TURSO_DATABASE_URL in .env when licensed', async () => {
				writeFileSync(join(root, '.env'), `TURSO_DATABASE_URL=${url}\nTURSO_AUTH_TOKEN=tok\n`);
				await TursoProvider.boot!();
				assert.strictEqual(await TursoProvider.canBeUsedInCurrentWorkspace(), true);
				const engine = await TursoProvider.getDatabaseEngine();
				assert.strictEqual(engine?.getType(), 'libsql');
				assert.strictEqual(TursoProvider.description, `${url.replace(/\/$/, '')} (from .env)`);
				await engine?.disconnect();
			});

			it('is listed without a license (locked row) but sends no request', async () => {
				licensed = false;
				writeFileSync(join(root, '.env'), 'TURSO_DATABASE_URL=http://127.0.0.1:1\n');
				await TursoProvider.boot!();
				assert.strictEqual(await TursoProvider.canBeUsedInCurrentWorkspace(), true);
				assert.strictEqual((TursoProvider as { engine?: unknown }).engine, undefined);
			});

			it('is not offered without a libSQL URL', async () => {
				writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://u:p@localhost/db\n');
				await TursoProvider.boot!();
				assert.strictEqual(await TursoProvider.canBeUsedInCurrentWorkspace(), false);
			});
		});
	});

	describe('Turso detection', () => {
		it('reads TURSO_* variables, and DATABASE_URL only when it is libsql://', () => {
			assert.deepStrictEqual(tursoConnectionFromEnv({ TURSO_DATABASE_URL: 'libsql://app-org.turso.io', TURSO_AUTH_TOKEN: 'tok' }), { url: 'libsql://app-org.turso.io', authToken: 'tok' });
			assert.deepStrictEqual(tursoConnectionFromEnv({ DATABASE_URL: 'libsql://a.turso.io', DATABASE_AUTH_TOKEN: 't' }), { url: 'libsql://a.turso.io', authToken: 't' });
			assert.strictEqual(tursoConnectionFromEnv({ DATABASE_URL: 'https://example.com' }), undefined);
			assert.strictEqual(tursoConnectionFromEnv({ TURSO_DATABASE_URL: 'file:local.db' }), undefined);
		});

		it('reads drizzle.config with dialect turso', () => {
			const config = `import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './src/schema.ts',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env['TURSO_AUTH_TOKEN'],
  },
});`;
			assert.deepStrictEqual(tursoConnectionFromDrizzleConfig(config, { TURSO_DATABASE_URL: 'libsql://d.turso.io', TURSO_AUTH_TOKEN: 'tok' }), { url: 'libsql://d.turso.io', authToken: 'tok' });
			assert.deepStrictEqual(tursoConnectionFromDrizzleConfig(config.replace("process.env.TURSO_DATABASE_URL!", "'http://127.0.0.1:8081'"), {}), { url: 'http://127.0.0.1:8081', authToken: undefined });
			assert.strictEqual(tursoConnectionFromDrizzleConfig(config.replace("'turso'", "'sqlite'"), { TURSO_DATABASE_URL: 'libsql://d.turso.io' }), undefined);
		});
	});
});
