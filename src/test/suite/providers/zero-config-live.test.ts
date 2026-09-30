import '../vscode-stub'
import * as assert from 'assert'
import * as net from 'net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { MongoClient } from 'mongodb'
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers'
import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql'
import { MSSQLServerContainer, StartedMSSQLServerContainer } from '@testcontainers/mssqlserver'
import { DockerComposeSource } from '../../../providers/docker-compose/compose-source'
import { PrismaSource } from '../../../providers/prisma/prisma-source'
import { DatabaseUrlSource } from '../../../providers/env/database-url-source'
import { collectDetections, createZeroConfigProvider, ZeroConfigProvider } from '../../../providers/zero-config/zero-config-provider'
import { ZeroConfigSource } from '../../../providers/zero-config/detected-datastore'
import { SqliteEngine } from '../../../database-engines/sqlite-engine'
import { setProLicenseChecker } from '../../../services/pro-gate'

const LOCAL_STACK = resolve(__dirname, '../../fixtures/zeroconfig/live-local-stack')

function isPortOpen(port: number): Promise<boolean> {
	return new Promise(resolvePort => {
		const socket = net.connect({ host: '127.0.0.1', port })
		socket.setTimeout(1000)
		socket.once('connect', () => { socket.destroy(); resolvePort(true) })
		socket.once('error', () => resolvePort(false))
		socket.once('timeout', () => { socket.destroy(); resolvePort(false) })
	})
}

function providersIn(root: string, sources: ZeroConfigSource[]): ZeroConfigProvider[] {
	return collectDetections([root], sources).map(createZeroConfigProvider)
}

async function openProvider(providers: ZeroConfigProvider[], name: string) {
	const provider = providers.find(entry => entry.name === name)
	assert.ok(provider, `no provider row named ${name}; rows: ${providers.map(entry => entry.name).join(', ')}`)
	assert.strictEqual(await provider.canBeUsedInCurrentWorkspace(), true, `${name} did not connect`)

	const engine = await provider.getDatabaseEngine()
	assert.ok(engine)
	return engine
}

function tempProject(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'devdb-zeroconfig-'))
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(join(root, file, '..'), { recursive: true })
		writeFileSync(join(root, file), content)
	}
	return root
}

describe('Zero-config live: local datastore stack', function () {
	this.timeout(60000)

	before(async function () {
		const ports = await Promise.all([5433, 6379, 6380, 8123].map(isPortOpen))
		if (ports.includes(false)) {
			console.log('Local datastore stack is not running (.claude/skills/run-devdb/local-datastores/up.sh); skipping')
			this.skip()
		}
		setProLicenseChecker(() => true)
	})

	after(() => setProLicenseChecker(() => false))

	it('connects to pgvector from a docker-compose service', async () => {
		const engine = await openProvider(providersIn(LOCAL_STACK, [DockerComposeSource]), 'Postgres (docker-compose: pgvector)')
		assert.ok((await engine.getTables()).includes('items'))
		await engine.disconnect()
	})

	it('connects to Redis and to password-protected Valkey from docker-compose services', async () => {
		const providers = providersIn(LOCAL_STACK, [DockerComposeSource])

		const redis = await openProvider(providers, 'Redis (docker-compose: redis)')
		assert.strictEqual(redis.getType(), 'redis')
		await redis.disconnect()

		const valkey = await openProvider(providers, 'Redis (docker-compose: valkey)')
		assert.strictEqual(valkey.getType(), 'redis')
		await valkey.disconnect()
	})

	it('connects to ClickHouse from a docker-compose service', async () => {
		const engine = await openProvider(providersIn(LOCAL_STACK, [DockerComposeSource]), 'ClickHouse (docker-compose: clickhouse)')
		assert.ok((await engine.getTables()).includes('events'))
		await engine.disconnect()
	})

	it('connects to pgvector from DATABASE_URL and REDIS_URL', async () => {
		const root = tempProject({ '.env': 'DATABASE_URL=postgres://devdb:devdb@localhost:5433/vectors?sslmode=disable\nREDIS_URL=redis://localhost:6379/0\n' })
		try {
			const providers = providersIn(root, [DatabaseUrlSource])
			const postgres = await openProvider(providers, 'Postgres (DATABASE_URL)')
			assert.ok((await postgres.getTables()).includes('items'))
			await postgres.disconnect()

			const redis = await openProvider(providers, 'Redis (REDIS_URL)')
			await redis.disconnect()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it('does not list a compose service that is not answering', async () => {
		const root = tempProject({ 'compose.yaml': 'services:\n  db:\n    image: postgres:16\n    ports: ["1:5432"]\n' })
		try {
			const [provider] = providersIn(root, [DockerComposeSource])
			assert.strictEqual(await provider.canBeUsedInCurrentWorkspace(), false)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

describe('Zero-config live: SQLite from Prisma', () => {
	it('opens the file named by the Prisma datasource', async () => {
		const root = tempProject({ 'prisma/schema.prisma': 'datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\n', '.env': 'DATABASE_URL="file:./dev.db"\n' })
		try {
			const seed = new SqliteEngine(join(root, 'prisma', 'dev.db'))
			await seed.rawQuery('CREATE TABLE posts (id INTEGER PRIMARY KEY)')
			await seed.disconnect()

			const engine = await openProvider(providersIn(root, [PrismaSource]), 'SQLite (Prisma)')
			assert.deepStrictEqual(await engine.getTables(), ['posts'])
			await engine.disconnect()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

describe('Zero-config live: MySQL, MSSQL and MongoDB compose services (testcontainers)', function () {
	this.timeout(180000)

	let mysql: StartedMySqlContainer
	let mssql: StartedMSSQLServerContainer
	let mongo: StartedTestContainer
	let root: string

	before(async () => {
		;[mysql, mssql, mongo] = await Promise.all([
			new MySqlContainer('mysql:8.0.31').withName('devdb-test-container-mysql').withReuse().start(),
			new MSSQLServerContainer('mcr.microsoft.com/mssql/server:2022-CU13-ubuntu-22.04')
				.withName('devdb-test-container-mssql')
				.acceptLicense()
				.withPassword('yourStrong(!)Password')
				.withReuse()
				.start(),
			new GenericContainer('mongo:7.0.14-jammy')
				.withName('devdb-test-container-mongodb')
				.withEnvironment({ MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'example' })
				.withExposedPorts(27017)
				.withReuse()
				.withWaitStrategy(Wait.forLogMessage(/Waiting for connections/, 2))
				.start(),
		])

		const client = new MongoClient(`mongodb://root:example@127.0.0.1:${mongo.getMappedPort(27017)}/?authSource=admin`)
		await client.connect()
		await client.db('test').collection('zeroconfig_posts').insertOne({ title: 'hello' })
		await client.close()

		root = tempProject({
			'.env': `MYSQL_PORT=${mysql.getPort()}\n`,
			'docker-compose.yml': [
				'services:',
				'  mysql:',
				'    image: mysql:8.0.31',
				'    environment:',
				'      MYSQL_USER: test',
				'      MYSQL_PASSWORD: test',
				'      MYSQL_DATABASE: test',
				'    ports:',
				'      - "${MYSQL_PORT:-3306}:3306"',
				'  sqlserver:',
				'    image: mcr.microsoft.com/mssql/server:2022-CU13-ubuntu-22.04',
				'    environment:',
				'      - ACCEPT_EULA=Y',
				'      - MSSQL_SA_PASSWORD=yourStrong(!)Password',
				'    ports:',
				`      - target: 1433`,
				`        published: ${mssql.getMappedPort(1433)}`,
				'  mongo:',
				'    image: mongo:7',
				'    environment:',
				'      MONGO_INITDB_ROOT_USERNAME: root',
				'      MONGO_INITDB_ROOT_PASSWORD: example',
				`    ports: ["${mongo.getMappedPort(27017)}:27017"]`,
			].join('\n'),
		})
	})

	after(() => {
		if (root) rmSync(root, { recursive: true, force: true })
	})

	it('connects to MySQL', async () => {
		const engine = await openProvider(providersIn(root, [DockerComposeSource]), 'MySQL (docker-compose: mysql)')
		assert.strictEqual(engine.getType(), 'mysql2')
		await engine.disconnect()
	})

	it('connects to MSSQL', async () => {
		const engine = await openProvider(providersIn(root, [DockerComposeSource]), 'MSSQL (docker-compose: sqlserver)')
		assert.strictEqual(engine.getType(), 'mssql')
		await engine.disconnect()
	})

	it('connects to MongoDB', async () => {
		const engine = await openProvider(providersIn(root, [DockerComposeSource]), 'MongoDB (docker-compose: mongo)')
		assert.ok((await engine.getTables()).includes('zeroconfig_posts'))
		await engine.disconnect()
	})
})
