import { existsSync } from 'fs'
import { join } from 'path'
import { DEFAULT_PORTS, DetectedDatastore, isLocalHost, parseConnectionUrl, readEnvFiles, readTextFile, ZeroConfigSource } from '../zero-config/detected-datastore'

const SOURCE = 'Laravel .env'

const MONGODB_PACKAGES = ['mongodb/laravel-mongodb', 'jenssegers/mongodb']

const REDIS_DRIVER_VARIABLES = ['CACHE_STORE', 'CACHE_DRIVER', 'SESSION_DRIVER', 'QUEUE_CONNECTION', 'BROADCAST_CONNECTION', 'BROADCAST_DRIVER']

type Env = Record<string, string>

/**
 * Laravel writes `null` for "no value" in `.env`.
 */
function value(env: Env, name: string): string | undefined {
	const raw = env[name]
	return raw === undefined || raw === '' || raw.toLowerCase() === 'null' ? undefined : raw
}

function composerPackages(root: string): string[] {
	try {
		const composer = JSON.parse(readTextFile(root, 'composer.json') ?? '{}')
		return [...Object.keys(composer.require ?? {}), ...Object.keys(composer['require-dev'] ?? {})]
	} catch {
		return []
	}
}

/**
 * Sail (and similar docker-compose setups) put a service name such as `redis` in `.env`. From
 * the host the service is reachable on its forwarded port on 127.0.0.1.
 */
function hostReachableFromEditor(root: string, host: string | undefined): string {
	if (!host) return '127.0.0.1'
	if (isLocalHost(host) || /^[\d.]+$/.test(host) || host.includes('.')) return host

	const usesCompose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some(file => existsSync(join(root, file)))
	return usesCompose ? '127.0.0.1' : host
}

function mssqlFrom(root: string, env: Env): DetectedDatastore | undefined {
	if (value(env, 'DB_CONNECTION') !== 'sqlsrv') return undefined

	const database = value(env, 'DB_DATABASE')
	if (!database) return undefined

	const host = hostReachableFromEditor(root, value(env, 'DB_HOST'))
	const trust = value(env, 'DB_TRUST_SERVER_CERTIFICATE')
	const encrypt = value(env, 'DB_ENCRYPT')

	return {
		engine: 'mssql',
		source: SOURCE,
		host,
		port: Number(value(env, 'DB_PORT') ?? DEFAULT_PORTS.mssql),
		username: value(env, 'DB_USERNAME'),
		password: value(env, 'DB_PASSWORD') ?? '',
		database,
		encrypt: encrypt === undefined ? true : /^(true|yes|1|mandatory|strict)$/i.test(encrypt),
		trustServerCertificate: trust === undefined ? isLocalHost(host) : /^(true|1)$/i.test(trust),
	}
}

function redisFrom(root: string, env: Env): DetectedDatastore | undefined {
	const usesRedis = REDIS_DRIVER_VARIABLES.some(name => value(env, name) === 'redis') || value(env, 'REDIS_URL') !== undefined
	if (!usesRedis) return undefined

	const url = value(env, 'REDIS_URL')
	if (url) {
		const detection = parseConnectionUrl(url, SOURCE)
		if (detection?.engine === 'redis') return detection
	}

	const configuredHost = value(env, 'REDIS_HOST')
	const host = hostReachableFromEditor(root, configuredHost)
	const forwarded = host !== configuredHost ? value(env, 'FORWARD_REDIS_PORT') : undefined

	return {
		engine: 'redis',
		source: SOURCE,
		host,
		port: Number(forwarded ?? value(env, 'REDIS_PORT') ?? DEFAULT_PORTS.redis),
		username: value(env, 'REDIS_USERNAME'),
		password: value(env, 'REDIS_PASSWORD'),
		database: value(env, 'REDIS_DB') ?? '0',
	}
}

function mongodbFrom(root: string, env: Env): DetectedDatastore | undefined {
	if (!composerPackages(root).some(name => MONGODB_PACKAGES.includes(name))) return undefined

	const uri = value(env, 'MONGODB_URI') ?? value(env, 'DB_URI') ?? value(env, 'DB_DSN')
	if (value(env, 'DB_CONNECTION') !== 'mongodb' && !value(env, 'MONGODB_URI')) return undefined

	const database = value(env, 'MONGODB_DATABASE') ?? value(env, 'DB_DATABASE')

	if (uri) {
		const detection = parseConnectionUrl(uri, SOURCE)
		if (detection?.engine !== 'mongodb') return undefined

		return database ? { ...detection, database } : detection
	}

	return {
		engine: 'mongodb',
		source: SOURCE,
		host: hostReachableFromEditor(root, value(env, 'DB_HOST')),
		port: Number(value(env, 'DB_PORT') ?? DEFAULT_PORTS.mongodb),
		username: value(env, 'DB_USERNAME'),
		password: value(env, 'DB_PASSWORD'),
		database: database ?? 'test',
	}
}

/**
 * Laravel datastores beyond the MySQL/Postgres/SQLite providers: `DB_CONNECTION=sqlsrv`, Redis
 * (when a driver uses it) and MongoDB (`mongodb/laravel-mongodb`).
 */
export const LaravelDatastoresSource: ZeroConfigSource = {
	name: 'Laravel',

	detect(root: string): DetectedDatastore[] {
		if (!existsSync(join(root, 'artisan'))) return []
		if (existsSync(join(root, '.ddev'))) return []

		const env = readEnvFiles(root, ['.env']).values

		return [mssqlFrom(root, env), redisFrom(root, env), mongodbFrom(root, env)]
			.filter((detection): detection is DetectedDatastore => Boolean(detection))
	},
}
