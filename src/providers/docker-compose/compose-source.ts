import { existsSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import { DEFAULT_PORTS, DetectedDatastore, DetectedEngine, interpolate, readEnvFiles, readTextFile, ZeroConfigSource } from '../zero-config/detected-datastore'

/**
 * Compose file names in Docker Compose's own lookup order.
 */
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']

type ServerEngine = Exclude<DetectedEngine, 'sqlite'>

type Environment = Record<string, string>

export interface ComposeService {
	image?: string
	ports?: unknown[]
	environment?: unknown
	command?: unknown
	network_mode?: string
	[key: string]: unknown
}

const IMAGE_RULES: Array<{ engine: ServerEngine, names: RegExp }> = [
	{ engine: 'postgres', names: /^(postgres|postgresql|pgvector|postgis|timescaledb|timescaledb-ha|timescaledb-postgis|postgresql-repmgr|cloudnative-pg|pg_vectors?)$/ },
	{ engine: 'mysql', names: /^(mysql|mysql-server|mariadb|percona|percona-server|percona-server-mysql)$/ },
	{ engine: 'mssql', names: /^(mssql-server-linux|azure-sql-edge)$/ },
	{ engine: 'mongodb', names: /^(mongo|mongodb|mongodb-community-server|mongodb-enterprise-server)$/ },
	{ engine: 'redis', names: /^(redis|redis-stack|redis-stack-server|valkey|keydb|dragonfly)$/ },
	{ engine: 'clickhouse', names: /^(clickhouse|clickhouse-server)$/ },
]

/**
 * Maps an image reference (`docker.io/bitnami/postgresql:16`, `mcr.microsoft.com/mssql/server:2022-latest`)
 * to an engine.
 */
export function engineForImage(image: string | undefined): ServerEngine | undefined {
	if (!image) return undefined

	const repository = image.toLowerCase().split('@')[0].replace(/:[^/]*$/, '')
	const segments = repository.split('/')
	const name = segments[segments.length - 1]

	if (name === 'server' && segments.includes('mssql')) return 'mssql'

	return IMAGE_RULES.find(rule => rule.names.test(name))?.engine
}

/**
 * Normalizes the list and map forms of `environment` into a map, with `${VAR}` interpolated.
 */
export function environmentOf(environment: unknown, lookup: (name: string) => string | undefined): Environment {
	const result: Environment = {}

	if (Array.isArray(environment)) {
		for (const entry of environment) {
			const text = String(entry)
			const index = text.indexOf('=')
			if (index < 0) {
				const value = lookup(text)
				if (value !== undefined) result[text] = value
				continue
			}
			result[text.substring(0, index)] = interpolate(text.substring(index + 1), lookup)
		}
	} else if (environment && typeof environment === 'object') {
		for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
			if (value === null || value === undefined) {
				const fromEnv = lookup(key)
				if (fromEnv !== undefined) result[key] = fromEnv
				continue
			}
			result[key] = interpolate(String(value), lookup)
		}
	}

	return result
}

interface PublishedPort {
	hostIp?: string
	published: number
	target: number
}

/**
 * Published ports of a service, from the short (`"127.0.0.1:5433:5432/tcp"`) and long
 * (`{ target, published, host_ip }`) syntaxes. Ports without a fixed host port are left out.
 */
export function publishedPorts(ports: unknown[] | undefined, lookup: (name: string) => string | undefined): PublishedPort[] {
	const result: PublishedPort[] = []

	for (const entry of ports ?? []) {
		if (entry && typeof entry === 'object') {
			const long = entry as Record<string, unknown>
			const target = Number(interpolate(String(long.target ?? ''), lookup))
			const publishedText = interpolate(String(long.published ?? ''), lookup)
			const published = Number(publishedText.split('-')[0])
			if (target && published) {
				result.push({ hostIp: long.host_ip ? interpolate(String(long.host_ip), lookup) : undefined, published, target })
			}
			continue
		}

		let text = interpolate(String(entry), lookup).replace(/\/(tcp|udp)$/i, '')
		let hostIp: string | undefined
		const ipv6 = text.match(/^\[([^\]]+)\]:(.*)$/)
		if (ipv6) {
			hostIp = ipv6[1]
			text = ipv6[2]
		}

		const parts = text.split(':')
		if (parts.length === 3 && !hostIp) hostIp = parts.shift()
		if (parts.length !== 2) continue

		const published = Number(parts[0].split('-')[0])
		const target = Number(parts[1].split('-')[0])
		if (!published || !target) continue

		result.push({ hostIp, published, target })
	}

	return result
}

function hostFor(hostIp: string | undefined): string {
	if (!hostIp || hostIp === '0.0.0.0' || hostIp === '::') return '127.0.0.1'
	return hostIp
}

function commandText(command: unknown): string {
	return Array.isArray(command) ? command.map(String).join(' ') : String(command ?? '')
}

function redisPasswordOf(env: Environment, command: string): string | undefined {
	const fromCommand = command.match(/--requirepass(?:\s+|=)(?:"([^"]*)"|'([^']*)'|(\S+))/)
	if (fromCommand) return fromCommand[1] ?? fromCommand[2] ?? fromCommand[3]

	return env.REDIS_PASSWORD || env.VALKEY_PASSWORD || env.KEYDB_PASSWORD || undefined
}

function credentialsFor(engine: ServerEngine, env: Environment, command: string): Pick<DetectedDatastore, 'username' | 'password' | 'database'> {
	switch (engine) {
		case 'postgres': {
			const username = env.POSTGRES_USER || env.POSTGRESQL_USERNAME || 'postgres'
			return {
				username,
				password: env.POSTGRES_PASSWORD ?? env.POSTGRESQL_PASSWORD ?? '',
				database: env.POSTGRES_DB || env.POSTGRESQL_DATABASE || username,
			}
		}

		case 'mysql': {
			const appUser = env.MYSQL_USER || env.MARIADB_USER
			const appPassword = env.MYSQL_PASSWORD ?? env.MARIADB_PASSWORD
			const rootPassword = env.MYSQL_ROOT_PASSWORD ?? env.MARIADB_ROOT_PASSWORD
			const database = env.MYSQL_DATABASE || env.MARIADB_DATABASE || undefined
			const useAppUser = appUser && appPassword !== undefined && (rootPassword === undefined || appUser !== 'root')

			return useAppUser
				? { username: appUser, password: appPassword, database }
				: { username: 'root', password: rootPassword ?? '', database }
		}

		case 'mssql':
			return {
				username: 'sa',
				password: env.MSSQL_SA_PASSWORD ?? env.SA_PASSWORD ?? '',
				database: 'master',
			}

		case 'mongodb': {
			const username = env.MONGO_INITDB_ROOT_USERNAME || (env.MONGODB_ROOT_PASSWORD ? env.MONGODB_ROOT_USER || 'root' : undefined)
			return {
				username,
				password: env.MONGO_INITDB_ROOT_PASSWORD ?? env.MONGODB_ROOT_PASSWORD,
				database: env.MONGO_INITDB_DATABASE || 'test',
			}
		}

		case 'redis':
			return { password: redisPasswordOf(env, command), database: '0' }

		case 'clickhouse':
			return {
				username: env.CLICKHOUSE_USER || env.CLICKHOUSE_ADMIN_USER || 'default',
				password: env.CLICKHOUSE_PASSWORD ?? env.CLICKHOUSE_ADMIN_PASSWORD ?? '',
				database: env.CLICKHOUSE_DB || 'default',
			}
	}
}

function asEnvironmentMap(environment: unknown): Record<string, unknown> {
	if (Array.isArray(environment)) {
		const map: Record<string, unknown> = {}
		for (const entry of environment) {
			const text = String(entry)
			const index = text.indexOf('=')
			map[index < 0 ? text : text.substring(0, index)] = index < 0 ? null : text.substring(index + 1)
		}
		return map
	}

	return environment && typeof environment === 'object' ? environment as Record<string, unknown> : {}
}

/**
 * Applies an override file the way Docker Compose does: scalars replace, `environment` merges,
 * `ports` append.
 */
export function mergeServices(base: Record<string, ComposeService>, override: Record<string, ComposeService>): Record<string, ComposeService> {
	const merged: Record<string, ComposeService> = { ...base }

	for (const [name, service] of Object.entries(override ?? {})) {
		const current = merged[name] ?? {}
		merged[name] = {
			...current,
			...service,
			environment: { ...asEnvironmentMap(current.environment), ...asEnvironmentMap(service?.environment) },
			ports: [...(current.ports ?? []), ...(service?.ports ?? [])],
		}
	}

	return merged
}

function loadServices(root: string, file: string): Record<string, ComposeService> {
	const content = readTextFile(root, file)
	if (!content) return {}

	try {
		const parsed = parseYaml(content, { merge: true })
		return parsed && typeof parsed.services === 'object' && parsed.services ? parsed.services : {}
	} catch {
		return {}
	}
}

function overrideFileFor(file: string): string {
	return file.replace(/\.(ya?ml)$/, '.override.$1')
}

/**
 * Datastore services in `compose.yaml` / `docker-compose.yml` (plus the `.override` file), with
 * credentials from `environment` and `${VAR:-default}` resolved from the project `.env`.
 */
export const DockerComposeSource: ZeroConfigSource = {
	name: 'docker-compose',

	detect(root: string): DetectedDatastore[] {
		const file = COMPOSE_FILES.find(candidate => existsSync(join(root, candidate)))
		if (!file) return []

		let services = loadServices(root, file)
		const override = [overrideFileFor(file), ...COMPOSE_FILES.map(overrideFileFor)].find(candidate => existsSync(join(root, candidate)))
		if (override) services = mergeServices(services, loadServices(root, override))

		const dotenv = readEnvFiles(root, ['.env']).values
		const lookup = (name: string) => dotenv[name]

		/**
		 * Laravel (incl. Sail) MySQL/Postgres services are already covered by the Laravel providers.
		 */
		const isLaravel = existsSync(join(root, 'artisan'))

		const detections: DetectedDatastore[] = []
		for (const [serviceName, service] of Object.entries(services)) {
			if (!service || typeof service !== 'object') continue

			const engine = engineForImage(service.image ? interpolate(String(service.image), lookup) : undefined)
			if (!engine) continue
			if (isLaravel && (engine === 'mysql' || engine === 'postgres')) continue

			const defaultPort = DEFAULT_PORTS[engine]
			let host = '127.0.0.1'
			let port: number | undefined

			if (service.network_mode === 'host') {
				port = defaultPort
			} else {
				const ports = publishedPorts(service.ports, lookup)
				const mapping = ports.find(entry => entry.target === defaultPort) ?? (engine !== 'clickhouse' && ports.length === 1 ? ports[0] : undefined)
				if (!mapping) continue

				host = hostFor(mapping.hostIp)
				port = mapping.published
			}

			const env = environmentOf(service.environment, lookup)
			const credentials = credentialsFor(engine, env, commandText(service.command))

			detections.push({
				engine,
				source: `docker-compose: ${serviceName}`,
				host,
				port,
				...credentials,
				...(engine === 'mssql' ? { encrypt: true, trustServerCertificate: true } : {}),
				...(engine === 'clickhouse' ? { protocol: 'http' as const } : {}),
			})
		}

		return detections
	},
}
