import '../vscode-stub'
import * as assert from 'assert'
import { join, resolve } from 'path'
import { connectionKey, interpolate, parseConnectionUrl, resolveSqlitePath } from '../../../providers/zero-config/detected-datastore'
import { DatabaseUrlSource } from '../../../providers/env/database-url-source'
import { parsePrismaConfig, parsePrismaDatasource, PrismaSource } from '../../../providers/prisma/prisma-source'
import { DrizzleSource, evaluateExpression, parseDrizzleConfig } from '../../../providers/drizzle/drizzle-source'
import { DockerComposeSource, engineForImage, environmentOf, mergeServices, publishedPorts } from '../../../providers/docker-compose/compose-source'
import { LaravelDatastoresSource } from '../../../providers/laravel/laravel-datastores-source'
import { collectDetections, createZeroConfigProvider } from '../../../providers/zero-config/zero-config-provider'
import { setProLicenseChecker } from '../../../services/pro-gate'

const FIXTURES = resolve(__dirname, '../../fixtures/zeroconfig')
const fixture = (name: string) => join(FIXTURES, name)

describe('Zero-config: connection URL parsing', () => {
	it('parses postgres URLs and maps sslmode=require to TLS without certificate verification', () => {
		assert.deepStrictEqual(parseConnectionUrl('postgresql://app:s%40cret@db.internal:6543/appdb?sslmode=require', 'DATABASE_URL'), {
			engine: 'postgres', source: 'DATABASE_URL', host: 'db.internal', port: 6543, username: 'app', password: 's@cret', database: 'appdb',
			ssl: true, allowUnauthorizedCertificate: true,
		})
		assert.strictEqual(parseConnectionUrl('postgres://u:p@h/db?sslmode=verify-full', 's')?.allowUnauthorizedCertificate, false)
		assert.strictEqual(parseConnectionUrl('postgres://u:p@h/db?sslmode=disable', 's')?.ssl, undefined)
		assert.strictEqual(parseConnectionUrl('postgres://u:p@h', 's')?.database, 'u')
	})

	it('parses mysql and mariadb URLs', () => {
		const detection = parseConnectionUrl('mariadb://root:pw@127.0.0.1/shop?ssl-mode=REQUIRED', 's')
		assert.strictEqual(detection?.engine, 'mysql')
		assert.strictEqual(detection?.port, 3306)
		assert.strictEqual(detection?.database, 'shop')
		assert.strictEqual(detection?.ssl, true)
	})

	it('parses sqlserver URLs in Prisma, URL and ADO.NET forms', () => {
		const prisma = parseConnectionUrl('sqlserver://localhost:1433;database=shop;user=sa;password=Pass@word1;trustServerCertificate=true', 's')
		assert.deepStrictEqual(
			[prisma?.engine, prisma?.host, prisma?.port, prisma?.database, prisma?.username, prisma?.password, prisma?.trustServerCertificate],
			['mssql', 'localhost', 1433, 'shop', 'sa', 'Pass@word1', true],
		)

		const url = parseConnectionUrl('mssql://sa:pw@sql.example.com:1500/app', 's')
		assert.deepStrictEqual([url?.host, url?.port, url?.database, url?.username, url?.trustServerCertificate], ['sql.example.com', 1500, 'app', 'sa', false])

		const ado = parseConnectionUrl('Data Source=(local);Initial Catalog=Orders;uid=sa;pwd={a;b}', 's')
		assert.deepStrictEqual([ado?.engine, ado?.host, ado?.port, ado?.database, ado?.password], ['mssql', 'localhost', 1433, 'Orders', '{a'])
	})

	it('parses mongodb, redis and clickhouse URLs', () => {
		const mongo = parseConnectionUrl('mongodb+srv://u:p@cluster0.example.net/blog', 's')
		assert.deepStrictEqual([mongo?.engine, mongo?.database, mongo?.connectionString], ['mongodb', 'blog', 'mongodb+srv://u:p@cluster0.example.net/blog'])
		assert.strictEqual(parseConnectionUrl('mongodb://localhost', 's')?.database, 'test')

		const redis = parseConnectionUrl('rediss://:pw@cache:6380/3', 's')
		assert.deepStrictEqual([redis?.engine, redis?.tls, redis?.database, redis?.password], ['redis', true, '3', 'pw'])

		assert.strictEqual(parseConnectionUrl('http://localhost:8123', 's', { variableName: 'DATABASE_URL' }), undefined)
		const clickhouse = parseConnectionUrl('https://ch.example.com/events', 's', { variableName: 'CLICKHOUSE_URL' })
		assert.deepStrictEqual([clickhouse?.engine, clickhouse?.protocol, clickhouse?.port, clickhouse?.database, clickhouse?.username], ['clickhouse', 'https', 8443, 'events', 'default'])
	})

	it('leaves libSQL, Neon and Supabase URLs to their own providers', () => {
		assert.strictEqual(parseConnectionUrl('libsql://db.turso.io', 's'), undefined)
		assert.strictEqual(parseConnectionUrl('postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db', 's'), undefined)
		assert.strictEqual(parseConnectionUrl('postgresql://u:p@db.abc.supabase.co/db', 's'), undefined)
	})

	it('resolves SQLite URLs against a base directory', () => {
		assert.strictEqual(resolveSqlitePath('file:./dev.db', '/app/prisma'), '/app/prisma/dev.db')
		assert.strictEqual(resolveSqlitePath('file:dev.db?connection_limit=1', '/app'), '/app/dev.db')
		assert.strictEqual(resolveSqlitePath('sqlite:///var/data/app.db', '/app'), '/var/data/app.db')
		assert.strictEqual(resolveSqlitePath('file:///var/data/app.db', '/app'), '/var/data/app.db')
		assert.strictEqual(resolveSqlitePath(':memory:', '/app'), undefined)
	})

	it('interpolates docker-compose variables', () => {
		const vars: Record<string, string> = { SET: 'x', EMPTY: '' }
		const lookup = (name: string) => vars[name]
		assert.strictEqual(interpolate('${SET}-${MISSING:-d}-${EMPTY:-e}-${EMPTY-f}-$SET-$$', lookup), 'x-d-e--x-$')
		assert.strictEqual(interpolate('${MISSING:-${SET}}', lookup), 'x')
	})

	it('treats the same host, port and database as one connection', () => {
		const a = parseConnectionUrl('postgres://a:a@localhost:5433/vectors', 'one')!
		const b = parseConnectionUrl('postgres://b:b@127.0.0.1:5433/vectors', 'two')!
		assert.strictEqual(connectionKey(a), connectionKey(b))
	})
})

describe('Zero-config: DATABASE_URL source', () => {
	it('reads every known variable; the first env file that defines a variable wins', () => {
		const detections = DatabaseUrlSource.detect(fixture('env-url'))

		assert.deepStrictEqual(detections.map(d => [d.source, d.engine, d.host ?? d.path, d.port, d.database]), [
			['DATABASE_URL', 'postgres', 'db.internal', 6543, 'appdb'],
			['POSTGRES_URL in .env.development', 'sqlite', join(fixture('env-url'), 'local.db'), undefined, undefined],
			['MYSQL_URL', 'mysql', '127.0.0.1', 3307, 'shop'],
			['MONGODB_URI in .env.local', 'mongodb', 'cluster0.example.net', undefined, 'blog'],
			['REDIS_URL in .env.local', 'redis', 'cache.internal', 6380, '2'],
			['CLICKHOUSE_URL in .env.development', 'clickhouse', 'localhost', 8123, 'events'],
		])
		assert.strictEqual(detections[0].ssl, true)
	})

	it('skips Neon, Supabase, libSQL and non-ClickHouse http URLs', () => {
		assert.deepStrictEqual(DatabaseUrlSource.detect(fixture('env-url-cloud')), [])
	})

	it('reads an ADO.NET SQL Server connection string', () => {
		const [detection] = DatabaseUrlSource.detect(fixture('env-url-ado'))
		assert.deepStrictEqual(
			[detection.engine, detection.host, detection.port, detection.database, detection.username, detection.password, detection.trustServerCertificate, detection.encrypt],
			['mssql', 'sql.local', 1444, 'Orders', 'sa', 'Str0ng!', true, true],
		)
	})
})

describe('Zero-config: Prisma source', () => {
	it('parses the datasource block and ignores comments', () => {
		assert.deepStrictEqual(parsePrismaDatasource('datasource db {\n provider = "mysql" // x\n url = env("DB")\n}'), { provider: 'mysql', url: { env: 'DB' } })
		assert.deepStrictEqual(parsePrismaDatasource('// datasource db { provider = "x" }\ndatasource db {\nprovider = "sqlite"\nurl = "file:./a.db"\n}'), { provider: 'sqlite', url: { literal: 'file:./a.db' } })
	})

	it('parses the Prisma 7 config url forms', () => {
		assert.deepStrictEqual(parsePrismaConfig("export default { datasource: { url: process.env.DB_URL } }"), { schema: undefined, url: { env: 'DB_URL' } })
		assert.deepStrictEqual(parsePrismaConfig("defineConfig({ schema: 'db/schema.prisma', datasource: { url: 'file:./x.db' } })"), { schema: 'db/schema.prisma', url: { literal: 'file:./x.db' } })
	})

	it('resolves env("DATABASE_URL") from .env', () => {
		assert.deepStrictEqual(PrismaSource.detect(fixture('prisma-postgres')).map(d => [d.source, d.engine, d.host, d.port, d.username, d.database]), [
			['Prisma', 'postgres', 'localhost', 5433, 'devdb', 'vectors'],
		])
	})

	it('resolves a SQLite file relative to the schema directory', () => {
		assert.deepStrictEqual(PrismaSource.detect(fixture('prisma-sqlite')), [
			{ engine: 'sqlite', source: 'Prisma', path: join(fixture('prisma-sqlite'), 'prisma', 'dev.db') },
		])
	})

	it('reads the url from prisma.config.ts when the schema has none (Prisma 7)', () => {
		const [detection] = PrismaSource.detect(fixture('prisma7'))
		assert.deepStrictEqual([detection.engine, detection.host, detection.database, detection.password], ['mssql', 'localhost', 'shop', 'Pass@word1'])
	})

	it('finds the datasource in a multi-file schema folder', () => {
		const [detection] = PrismaSource.detect(fixture('prisma-multifile'))
		assert.deepStrictEqual([detection.engine, detection.database], ['mongodb', 'blog'])
	})
})

describe('Zero-config: Drizzle source', () => {
	it('evaluates env, fallback and wrapper expressions', () => {
		const env = { A: 'a', N: '42' }
		assert.strictEqual(evaluateExpression('process.env.A!', env), 'a')
		assert.strictEqual(evaluateExpression("process.env.MISSING ?? 'dflt'", env), 'dflt')
		assert.strictEqual(evaluateExpression('Number(process.env.N)', env), 42)
		assert.strictEqual(evaluateExpression('`x-${process.env.A}`', env), 'x-a')
		assert.strictEqual(evaluateExpression('getUrl()', env), undefined)
	})

	it('parses dialect and dbCredentials without running the file', () => {
		const config = parseDrizzleConfig("export default { dialect: 'postgresql', dbCredentials: { host: 'h', port: 5, ssl: 'require' } }", {})
		assert.deepStrictEqual(config, { dialect: 'postgresql', driver: undefined, credentials: { host: 'h', port: 5, ssl: 'require' } })
	})

	it('reads dbCredentials.url from process.env', () => {
		assert.deepStrictEqual(DrizzleSource.detect(fixture('drizzle-url')).map(d => [d.source, d.engine, d.host, d.port, d.database]), [
			['Drizzle', 'postgres', 'localhost', 5433, 'vectors'],
		])
	})

	it('reads host/port/user/password/database and the dotenv path named in the config', () => {
		assert.deepStrictEqual(DrizzleSource.detect(fixture('drizzle-credentials')), [{
			engine: 'mysql', source: 'Drizzle', host: '127.0.0.1', port: 3310, username: 'shopper', password: 'p@ss', database: 'shop',
			ssl: true, allowUnauthorizedCertificate: true,
		}])
	})

	it('reads a SQLite url and skips turso', () => {
		assert.deepStrictEqual(DrizzleSource.detect(fixture('drizzle-sqlite')), [{ engine: 'sqlite', source: 'Drizzle', path: join(fixture('drizzle-sqlite'), 'sqlite.db') }])
		assert.deepStrictEqual(DrizzleSource.detect(fixture('drizzle-turso')), [])
	})
})

describe('Zero-config: docker-compose source', () => {
	it('maps images to engines', () => {
		const cases: Array<[string, string | undefined]> = [
			['postgres:16-alpine', 'postgres'], ['pgvector/pgvector:pg16', 'postgres'], ['postgis/postgis', 'postgres'], ['timescale/timescaledb-ha:pg16', 'postgres'], ['bitnami/postgresql', 'postgres'],
			['mysql:8', 'mysql'], ['mariadb:11', 'mysql'], ['percona:8', 'mysql'], ['mysql/mysql-server:8.0', 'mysql'],
			['mcr.microsoft.com/mssql/server:2022-latest', 'mssql'], ['mcr.microsoft.com/azure-sql-edge', 'mssql'],
			['mongo:7', 'mongodb'], ['bitnami/mongodb', 'mongodb'], ['mongo-express', undefined],
			['redis:7', 'redis'], ['valkey/valkey:8', 'redis'], ['redis/redis-stack-server', 'redis'], ['bitnami/valkey', 'redis'], ['redis/redisinsight', undefined],
			['clickhouse/clickhouse-server:24.3', 'clickhouse'], ['localhost:5000/postgres', 'postgres'], ['nginx', undefined],
		]
		for (const [image, engine] of cases) assert.strictEqual(engineForImage(image), engine, image)
	})

	it('reads short and long port syntax', () => {
		const lookup = (name: string) => ({ P: '7000' } as Record<string, string>)[name]
		assert.deepStrictEqual(publishedPorts(['5432', '127.0.0.1:5433:5432/tcp', '${P:-1}:80', '[::1]:6000:6379', { target: 3306, published: '3307', host_ip: '0.0.0.0' }, { target: 1 }], lookup), [
			{ hostIp: '127.0.0.1', published: 5433, target: 5432 },
			{ hostIp: undefined, published: 7000, target: 80 },
			{ hostIp: '::1', published: 6000, target: 6379 },
			{ hostIp: '0.0.0.0', published: 3307, target: 3306 },
		])
	})

	it('reads environment in list and map form', () => {
		const lookup = (name: string) => ({ FROM_DOTENV: 'v' } as Record<string, string>)[name]
		assert.deepStrictEqual(environmentOf(['A=1', 'B=${FROM_DOTENV}', 'FROM_DOTENV'], lookup), { A: '1', B: 'v', FROM_DOTENV: 'v' })
		assert.deepStrictEqual(environmentOf({ A: 1, B: '${MISSING:-d}', FROM_DOTENV: null }, lookup), { A: '1', B: 'd', FROM_DOTENV: 'v' })
	})

	it('merges an override file: environment merges, ports append', () => {
		const merged = mergeServices({ db: { image: 'postgres', environment: ['A=1'], ports: ['1:1'] } }, { db: { environment: { B: '2' }, ports: ['2:2'] } })
		assert.deepStrictEqual(merged.db, { image: 'postgres', environment: { A: '1', B: '2' }, ports: ['1:1', '2:2'] })
	})

	it('lists one detection per datastore service with a published port', () => {
		const detections = DockerComposeSource.detect(fixture('compose'))

		assert.deepStrictEqual(detections.map(d => [d.source, d.engine, d.host, d.port, d.username, d.password, d.database]), [
			['docker-compose: db', 'postgres', '127.0.0.1', 5544, 'app', 'overridden', 'vectors'],
			['docker-compose: mysql', 'mysql', '127.0.0.1', 3307, 'root', 'rootpw', 'shop'],
			['docker-compose: mssql', 'mssql', '127.0.0.1', 1434, 'sa', 'Str0ng!Passw0rd', 'master'],
			['docker-compose: mongo', 'mongodb', '127.0.0.1', 27018, 'root', 'example', 'test'],
			['docker-compose: cache', 'redis', '127.0.0.1', 6380, undefined, 'valkeypass', '0'],
			['docker-compose: analytics', 'clickhouse', '127.0.0.1', 8123, 'default', 'devdb', 'devdb'],
			['docker-compose: redis', 'redis', '127.0.0.1', 6390, undefined, 'from-dotenv', '0'],
		])
	})

	it('leaves Laravel MySQL/Postgres services to the Laravel providers', () => {
		assert.deepStrictEqual(DockerComposeSource.detect(fixture('compose-laravel')).map(d => [d.source, d.engine, d.port]), [
			['docker-compose: redis', 'redis', 6379],
		])
	})
})

describe('Zero-config: Laravel datastores source', () => {
	it('reads DB_CONNECTION=sqlsrv as MSSQL and ignores unused Redis', () => {
		assert.deepStrictEqual(LaravelDatastoresSource.detect(fixture('laravel-sqlsrv')), [{
			engine: 'mssql', source: 'Laravel .env', host: '127.0.0.1', port: 1433, username: 'sa', password: 'Str0ng!Passw0rd', database: 'laravel',
			encrypt: true, trustServerCertificate: true,
		}])
	})

	it('reads Redis when a driver uses it, and maps a Sail service host to the forwarded port', () => {
		assert.deepStrictEqual(LaravelDatastoresSource.detect(fixture('laravel-redis')), [{
			engine: 'redis', source: 'Laravel .env', host: '127.0.0.1', port: 6390, username: undefined, password: 'secret', database: '1',
		}])
	})

	it('reads MongoDB from mongodb/laravel-mongodb + MONGODB_URI', () => {
		const [detection] = LaravelDatastoresSource.detect(fixture('laravel-mongodb'))
		assert.deepStrictEqual([detection.engine, detection.database, detection.connectionString], ['mongodb', 'laravel_app', 'mongodb://root:example@localhost:27017/?authSource=admin'])
	})

	it('finds nothing extra in a plain MySQL Laravel app', () => {
		assert.deepStrictEqual(LaravelDatastoresSource.detect(fixture('laravel-plain')), [])
	})
})

describe('Zero-config: provider rows', () => {
	afterEach(() => setProLicenseChecker(() => false))

	it('merges detections of the same database and names the row after the first source', () => {
		const merged = collectDetections([fixture('prisma-postgres'), fixture('drizzle-url')], [PrismaSource, DrizzleSource])
		assert.strictEqual(merged.length, 1)

		const provider = createZeroConfigProvider(merged[0])
		assert.strictEqual(provider.name, 'Postgres (Prisma · prisma-postgres)')
		assert.strictEqual(provider.description, 'localhost:5433/vectors · also in Drizzle · drizzle-url')
		assert.ok(!provider.description.includes('devdb:devdb'))
	})

	it('locks Pro engines without a license and never opens them', async () => {
		setProLicenseChecker(() => false)
		const [redis] = collectDetections([fixture('compose')], [DockerComposeSource]).filter(entry => entry.detection.source === 'docker-compose: cache')
		const provider = createZeroConfigProvider(redis)

		assert.strictEqual(provider.name, 'Redis (docker-compose: cache)')
		assert.strictEqual(provider.isProLocked(), true)
		assert.strictEqual(await provider.canBeUsedInCurrentWorkspace(), false)
		assert.strictEqual(await provider.getDatabaseEngine(), undefined)
		assert.strictEqual(provider.engine, undefined)

		setProLicenseChecker(() => true)
		assert.strictEqual(provider.isProLocked(), false)
	})

	it('does not lock free engines', () => {
		setProLicenseChecker(() => false)
		const [postgres] = collectDetections([fixture('compose')], [DockerComposeSource])
		assert.strictEqual(createZeroConfigProvider(postgres).isProLocked(), false)
	})
})
