import { createFakeExtensionContext } from '../vscode-stub';
import * as assert from 'assert';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { rmSync } from 'fs';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { testRemoteConnection } from '../../../services/connection-tester';
import { remoteConnectionStorageService } from '../../../services/remote-connection-storage-service';
import { remoteCredentialService } from '../../../services/remote-credential-service';
import { setProLicenseChecker } from '../../../services/pro-gate';
import { ConfigFileProvider } from '../../../providers/config-file-provider';
import { DuckDbEngine } from '../../../database-engines/duckdb-engine';

/**
 * Container names/images match the engine suites so `withReuse()` shares the running containers.
 */
const REDIS_IMAGE = 'redis:7-alpine'
const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:24.3-alpine'
const CLICKHOUSE_PASSWORD = 'devdb'
const POSTGRES_IMAGE = 'postgres:13.3-alpine'

describe('Remote connection tester', () => {
	let licensed = true

	before(() => {
		const fake = createFakeExtensionContext()
		remoteCredentialService.setExtensionContext(fake.context)
		remoteConnectionStorageService.setExtensionContext(fake.context)
		setProLicenseChecker(() => licensed)
	})

	beforeEach(() => {
		licensed = true
	})

	describe('Redis', () => {
		let container: StartedRedisContainer

		before(async function () {
			this.timeout(120000)
			container = await new RedisContainer(REDIS_IMAGE)
				.withName('devdb-test-container-redis')
				.withReuse()
				.start()
		})

		it('connects with host/port fields', async () => {
			const result = await testRemoteConnection({ connectionType: 'redis', connectionName: 'r', dbHost: container.getHost(), dbPort: container.getPort() })
			assert.deepStrictEqual(result, { success: true, message: 'Connection successful' })
		})

		it('connects with a connection string', async () => {
			const result = await testRemoteConnection({ connectionType: 'redis', connectionName: 'r', redisConnectionString: container.getConnectionUrl() })
			assert.strictEqual(result.success, true, result.message)
		})

		it('surfaces the driver error without the password', async () => {
			const result = await testRemoteConnection({ connectionType: 'redis', connectionName: 'r', redisConnectionString: `redis://devdb:topsecret@${container.getHost()}:${container.getPort()}` })
			assert.strictEqual(result.success, false)
			assert.match(result.message, /^Failed to connect to Redis: .+/)
			assert.ok(!result.message.includes('topsecret'))
		})

		it('fails fast on an unreachable server', async () => {
			const result = await testRemoteConnection({ connectionType: 'redis', connectionName: 'r', dbHost: '127.0.0.1', dbPort: 1 })
			assert.strictEqual(result.success, false)
			assert.match(result.message, /ECONNREFUSED/)
		})

		it('refuses without a Pro license', async () => {
			licensed = false
			const result = await testRemoteConnection({ connectionType: 'redis', connectionName: 'r', redisConnectionString: container.getConnectionUrl() })
			assert.strictEqual(result.success, false)
			assert.match(result.message, /DevDb Pro required/)
		})
	})

	describe('ClickHouse', () => {
		let container: StartedTestContainer

		before(async function () {
			this.timeout(120000)
			container = await new GenericContainer(CLICKHOUSE_IMAGE)
				.withName('devdb-test-container-clickhouse')
				.withExposedPorts(8123)
				.withEnvironment({ CLICKHOUSE_PASSWORD })
				.withReuse()
				.withWaitStrategy(Wait.forHttp('/ping', 8123).forStatusCode(200))
				.start()
		})

		function form(password: string) {
			return { connectionType: 'clickhouse' as const, connectionName: 'c', dbHost: container.getHost(), dbPort: container.getMappedPort(8123), dbUsername: 'default', dbPassword: password, dbName: 'default', protocol: 'http' as const }
		}

		it('connects with valid credentials', async () => {
			const result = await testRemoteConnection(form(CLICKHOUSE_PASSWORD))
			assert.deepStrictEqual(result, { success: true, message: 'Connection successful' })
		})

		it('rejects a wrong password with the server message', async () => {
			const result = await testRemoteConnection(form('wrong-password'))
			assert.strictEqual(result.success, false)
			assert.match(result.message, /^Failed to connect to ClickHouse: .*Authentication failed/)
		})

		it('refuses without a Pro license', async () => {
			licensed = false
			const result = await testRemoteConnection(form(CLICKHOUSE_PASSWORD))
			assert.match(result.message, /DevDb Pro required/)
		})
	})

	describe('Postgres', () => {
		let container: StartedPostgreSqlContainer

		before(async function () {
			this.timeout(120000)
			container = await new PostgreSqlContainer(POSTGRES_IMAGE)
				.withName('devdb-test-container-postgres')
				.withReuse()
				.start()
		})

		function form(extra: Record<string, unknown> = {}) {
			return {
				connectionType: 'direct' as const,
				dbEngine: 'postgres' as const,
				connectionName: 'p',
				dbHost: container.getHost(),
				dbPort: container.getPort(),
				dbUsername: container.getUsername(),
				dbPassword: container.getPassword(),
				dbName: container.getDatabase(),
				...extra,
			}
		}

		it('connects to Postgres on a non-5432 port', async () => {
			assert.notStrictEqual(container.getPort(), 5432)
			const result = await testRemoteConnection(form())
			assert.deepStrictEqual(result, { success: true, message: 'Connection successful' })
		})

		it('honours the SSL flag', async () => {
			const result = await testRemoteConnection(form({ ssl: true, allowUnauthorizedCertificate: true }))
			assert.strictEqual(result.success, false)
			assert.match(result.message, /SSL/i)
		})

		it('surfaces a wrong password without leaking it', async () => {
			const result = await testRemoteConnection(form({ dbPassword: 'not-the-password' }))
			assert.strictEqual(result.success, false)
			assert.match(result.message, /^Failed to connect to PostgreSQL: .*password/)
			assert.ok(!result.message.includes('not-the-password'))
		})
	})

	describe('.devdbrc DuckDB entries', () => {
		const dbPath = join(tmpdir(), `devdb-config-duckdb-${Date.now()}.duckdb`)

		before(async () => {
			const writer = new DuckDbEngine(dbPath, { readOnly: false })
			await writer.rawQuery('CREATE TABLE t (a INTEGER)')
			await writer.disconnect()
		})

		after(() => {
			rmSync(dbPath, { force: true })
		})

		beforeEach(async () => {
			await ConfigFileProvider.boot!()
		})

		afterEach(async () => {
			for (const cache of ConfigFileProvider.cache ?? []) {
				await cache.engine.disconnect()
			}
		})

		it('is refused without a Pro license', async () => {
			licensed = false
			await ConfigFileProvider.resolveConfiguration!({ type: 'duckdb', path: dbPath })
			assert.strictEqual(ConfigFileProvider.cache?.length, 0)
		})

		it('opens read-only by default', async () => {
			await ConfigFileProvider.resolveConfiguration!({ type: 'duckdb', path: dbPath })
			const engine = ConfigFileProvider.cache![0].engine
			await assert.rejects(() => engine.rawQuery('INSERT INTO t VALUES (1)'))
		})

		it('resolves a relative path against the .devdbrc folder', async () => {
			// Other suites may load a vscode stub whose workspaceFolders is a getter.
			const workspace = require('vscode').workspace
			const previous = Object.getOwnPropertyDescriptor(workspace, 'workspaceFolders')
			Object.defineProperty(workspace, 'workspaceFolders', { value: [{ uri: { fsPath: tmpdir() } }], configurable: true, writable: true })
			try {
				await ConfigFileProvider.resolveConfiguration!({ type: 'duckdb', path: basename(dbPath) })
				assert.strictEqual(ConfigFileProvider.cache?.length, 1)
				assert.strictEqual(ConfigFileProvider.cache![0].id, dbPath)
			} finally {
				if (previous) Object.defineProperty(workspace, 'workspaceFolders', previous)
				else delete workspace.workspaceFolders
			}
		})

		it('opens writable with readOnly: false', async () => {
			await ConfigFileProvider.resolveConfiguration!({ type: 'duckdb', path: dbPath, readOnly: false })
			const engine = ConfigFileProvider.cache![0].engine
			await engine.rawQuery('INSERT INTO t VALUES (1)')
		})
	})
})
