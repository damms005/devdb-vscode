import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { parse as parseDotenv } from 'dotenv'
import { isNeonHostname } from '../postgres/neon-connection-helper'

export type DetectedEngine = 'postgres' | 'mysql' | 'mssql' | 'mongodb' | 'redis' | 'clickhouse' | 'sqlite'

/**
 * A datastore found in project files (env vars, ORM config, docker-compose, framework config),
 * before any connection attempt.
 */
export interface DetectedDatastore {
	engine: DetectedEngine
	/**
	 * Shown in the row label, e.g. `DATABASE_URL`, `Prisma`, `docker-compose: cache`.
	 */
	source: string
	host?: string
	port?: number
	username?: string
	password?: string
	database?: string
	/**
	 * Postgres/MySQL TLS.
	 */
	ssl?: boolean
	/**
	 * Postgres/MySQL: accept a certificate that does not verify (libpq `sslmode=require`).
	 */
	allowUnauthorizedCertificate?: boolean
	/**
	 * MSSQL: trust a self-signed server certificate.
	 */
	trustServerCertificate?: boolean
	/**
	 * MSSQL: encrypt the connection.
	 */
	encrypt?: boolean
	/**
	 * Redis TLS (`rediss://`).
	 */
	tls?: boolean
	/**
	 * ClickHouse HTTP protocol.
	 */
	protocol?: 'http' | 'https'
	/**
	 * Full URI for engines that connect best with one (MongoDB, Redis).
	 */
	connectionString?: string
	/**
	 * Absolute path of a SQLite file.
	 */
	path?: string
}

/**
 * Finds datastores in one workspace folder. Must not open connections.
 */
export interface ZeroConfigSource {
	name: string
	detect(root: string): DetectedDatastore[]
}

export const ENGINE_LABELS: Record<DetectedEngine, string> = {
	postgres: 'Postgres',
	mysql: 'MySQL',
	mssql: 'MSSQL',
	mongodb: 'MongoDB',
	redis: 'Redis',
	clickhouse: 'ClickHouse',
	sqlite: 'SQLite',
}

export const DEFAULT_PORTS: Record<Exclude<DetectedEngine, 'sqlite'>, number> = {
	postgres: 5432,
	mysql: 3306,
	mssql: 1433,
	mongodb: 27017,
	redis: 6379,
	clickhouse: 8123,
}

/**
 * `.env` files read for connection variables, in priority order: the first file that
 * defines a variable wins.
 */
export const ENV_FILES = ['.env', '.env.local', '.env.development'] as const

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'host.docker.internal']

export function isLocalHost(host: string | undefined): boolean {
	return !host || LOCAL_HOSTS.includes(host.toLowerCase())
}

/**
 * Hosts owned by the dedicated Neon / Supabase providers.
 */
export function isManagedCloudHost(host: string | undefined): boolean {
	const value = String(host ?? '').toLowerCase().replace(/\.$/, '')

	return isNeonHostname(value) || value === 'supabase.co' || value.endsWith('.supabase.co')
}

/**
 * Identity of the database a detection points at. Two detections with the same key open the
 * same data, so only one row is shown.
 */
export function connectionKey(datastore: DetectedDatastore): string {
	if (datastore.engine === 'sqlite') return `sqlite:${datastore.path}`

	const host = isLocalHost(datastore.host) ? 'localhost' : String(datastore.host).toLowerCase()
	const port = datastore.port ?? DEFAULT_PORTS[datastore.engine]

	return `${datastore.engine}://${host}:${port}/${datastore.database ?? ''}`
}

export function readTextFile(...segments: string[]): string | undefined {
	const filePath = join(...segments)
	if (!existsSync(filePath)) return undefined

	try {
		return readFileSync(filePath, 'utf8')
	} catch {
		return undefined
	}
}

/**
 * Variables from {@link ENV_FILES} in `dir`. For each variable the first file that defines it
 * wins. `${VAR}` references are expanded.
 */
export function readEnvFiles(dir: string, files: readonly string[] = ENV_FILES): { values: Record<string, string>, fileOf: Record<string, string> } {
	const values: Record<string, string> = {}
	const fileOf: Record<string, string> = {}

	for (const file of files) {
		const content = readTextFile(dir, file)
		if (content === undefined) continue

		const parsed = parseDotenv(content)
		for (const [key, value] of Object.entries(parsed)) {
			if (key in values) continue
			values[key] = value
			fileOf[key] = file
		}
	}

	for (const key of Object.keys(values)) {
		values[key] = interpolate(values[key], name => values[name])
	}

	return { values, fileOf }
}

/**
 * Expands `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:?error}` and `$VAR`, with `$$`
 * as a literal `$` (docker-compose rules).
 */
export function interpolate(value: string, lookup: (name: string) => string | undefined): string {
	return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])((?:[^{}]|\{[^{}]*\})*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name?: string, operator?: string, operand?: string, bareName?: string) => {
		if (match === '$$') return '$'
		if (bareName) return lookup(bareName) ?? ''

		const current = lookup(name as string)
		const isUnset = current === undefined
		const isEmpty = isUnset || current === ''
		const inner = (text: string) => interpolate(text, lookup)

		switch (operator) {
			case ':-': return isEmpty ? inner(operand ?? '') : current as string
			case '-': return isUnset ? inner(operand ?? '') : current as string
			case ':+': return isEmpty ? '' : inner(operand ?? '')
			case '+': return isUnset ? '' : inner(operand ?? '')
			default: return current ?? ''
		}
	})
}

/**
 * Resolves a SQLite URL or path (`file:./dev.db`, `sqlite:///abs.db`, `./dev.db`) against `baseDir`.
 */
export function resolveSqlitePath(value: string, baseDir: string): string | undefined {
	let path = value.trim()
	if (!path || path === ':memory:') return undefined

	path = path.replace(/^(?:file|sqlite3?):(?:\/\/(?=\/))?/i, '')
	if (/^\/\/[^/]/.test(path)) path = path.substring(2)
	path = path.split('?')[0]
	if (!path || path === ':memory:') return undefined

	try {
		path = decodeURIComponent(path)
	} catch {
		// keep the raw path
	}

	return isAbsolute(path) ? path : resolve(baseDir, path)
}

function decode(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

function isTrue(value: string | undefined | null): boolean {
	return /^(true|yes|1)$/i.test(String(value ?? '').trim())
}

function firstParam(params: URLSearchParams, ...names: string[]): string | undefined {
	for (const [key, value] of params) {
		if (names.includes(key.toLowerCase())) return value
	}
	return undefined
}

/**
 * Hints that help classify a connection value that has no clear scheme.
 */
export interface UrlParseHints {
	/**
	 * Name of the variable that holds the value. `http(s)://` counts as ClickHouse only when this
	 * name mentions ClickHouse.
	 */
	variableName?: string
	/**
	 * Engine the caller already knows (e.g. Prisma `provider = "sqlserver"`).
	 */
	engine?: DetectedEngine
	/**
	 * Directory relative SQLite paths resolve against.
	 */
	baseDir?: string
}

/**
 * Parses a connection URL (or ADO.NET connection string) into a detection. Returns undefined
 * for unsupported or unparseable values, libSQL/Turso URLs, and Neon/Supabase hosts.
 */
export function parseConnectionUrl(rawValue: string, source: string, hints: UrlParseHints = {}): DetectedDatastore | undefined {
	const value = rawValue.trim()
	if (!value) return undefined

	const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()

	if (!scheme) {
		if (/(^|;)\s*(server|data source|address|addr)\s*=/i.test(value)) return parseAdoConnectionString(value, source)
		if (hints.engine === 'sqlite' && hints.baseDir) return sqliteDetection(value, source, hints.baseDir)
		return undefined
	}

	if (scheme === 'file' || scheme === 'sqlite' || scheme === 'sqlite3') {
		return hints.baseDir ? sqliteDetection(value, source, hints.baseDir) : undefined
	}

	if (scheme === 'sqlserver' || scheme === 'mssql') {
		return parseSqlServerUrl(value, source)
	}

	const isClickhouseVariable = /clickhouse/i.test(hints.variableName ?? '') || hints.engine === 'clickhouse'
	const engine = engineForScheme(scheme, isClickhouseVariable)
	if (!engine) return undefined

	let url: URL
	try {
		url = new URL(value)
	} catch {
		return undefined
	}

	const host = url.hostname.replace(/^\[|\]$/g, '')
	if (isManagedCloudHost(host)) return undefined

	const port = url.port ? Number(url.port) : undefined
	const username = url.username ? decode(url.username) : undefined
	const password = url.password ? decode(url.password) : undefined
	const pathDatabase = decode(url.pathname.replace(/^\//, '').split('/')[0] ?? '') || undefined
	const params = url.searchParams

	switch (engine) {
		case 'postgres': {
			const sslmode = firstParam(params, 'sslmode')?.toLowerCase()
			const ssl = ['require', 'verify-ca', 'verify-full'].includes(sslmode ?? '') || isTrue(firstParam(params, 'ssl'))

			return {
				engine, source, host: host || 'localhost', port: port ?? DEFAULT_PORTS.postgres, username, password,
				database: pathDatabase ?? username ?? 'postgres',
				...(ssl ? { ssl: true, allowUnauthorizedCertificate: sslmode === 'require' || sslmode === undefined } : {}),
			}
		}

		case 'mysql': {
			const sslMode = firstParam(params, 'ssl-mode', 'sslmode')?.toLowerCase() ?? ''
			const sslAccept = firstParam(params, 'sslaccept')?.toLowerCase() ?? ''
			const verify = ['verify_ca', 'verify_identity'].includes(sslMode) || sslAccept === 'strict'
			const ssl = verify || ['required', 'require'].includes(sslMode) || isTrue(firstParam(params, 'ssl', 'tls')) || sslAccept === 'accept_invalid_certs'

			return {
				engine, source, host: host || 'localhost', port: port ?? DEFAULT_PORTS.mysql, username, password,
				database: pathDatabase,
				...(ssl ? { ssl: true, allowUnauthorizedCertificate: !verify } : {}),
			}
		}

		case 'mongodb':
			return {
				engine, source, host, port: scheme === 'mongodb+srv' ? undefined : port ?? DEFAULT_PORTS.mongodb, username, password,
				database: pathDatabase ?? 'test',
				connectionString: value,
			}

		case 'redis': {
			const database = pathDatabase && /^\d+$/.test(pathDatabase) ? pathDatabase : '0'

			return {
				engine, source, host: host || 'localhost', port: port ?? DEFAULT_PORTS.redis, username, password,
				database,
				tls: scheme === 'rediss',
				connectionString: value,
			}
		}

		case 'clickhouse': {
			const protocol: 'http' | 'https' = scheme === 'https' || scheme === 'clickhouses' || isTrue(firstParam(params, 'secure')) ? 'https' : 'http'

			return {
				engine, source, host: host || 'localhost', port: port ?? (protocol === 'https' ? 8443 : DEFAULT_PORTS.clickhouse),
				username: username ?? 'default', password: password ?? '',
				database: pathDatabase ?? firstParam(params, 'database') ?? 'default',
				protocol,
			}
		}
	}

	return undefined
}

function engineForScheme(scheme: string, isClickhouseVariable: boolean): DetectedEngine | undefined {
	if (scheme === 'postgres' || scheme === 'postgresql') return 'postgres'
	if (scheme === 'mysql' || scheme === 'mysql2' || scheme === 'mariadb') return 'mysql'
	if (scheme === 'mongodb' || scheme === 'mongodb+srv') return 'mongodb'
	if (scheme === 'redis' || scheme === 'rediss' || scheme === 'valkey' || scheme === 'valkeys') return 'redis'
	if (scheme === 'clickhouse' || scheme === 'clickhouses') return 'clickhouse'
	if ((scheme === 'http' || scheme === 'https') && isClickhouseVariable) return 'clickhouse'

	return undefined
}

function sqliteDetection(value: string, source: string, baseDir: string): DetectedDatastore | undefined {
	const path = resolveSqlitePath(value, baseDir)
	if (!path) return undefined

	return { engine: 'sqlite', source, path }
}

function mssqlDetection(source: string, fields: Record<string, string>, hostPart: string | undefined): DetectedDatastore | undefined {
	const get = (...names: string[]) => {
		for (const name of names) {
			if (fields[name] !== undefined) return fields[name]
		}
		return undefined
	}

	let host = hostPart ?? get('server', 'data source', 'address', 'addr', 'network address')
	if (!host) return undefined

	host = host.replace(/^tcp:/i, '')
	let port: number | undefined
	const portMatch = host.match(/^(.*?)[,:](\d+)$/)
	if (portMatch) {
		host = portMatch[1]
		port = Number(portMatch[2])
	}
	host = host.split('\\')[0]
	if (host === '.' || host === '(local)') host = 'localhost'
	if (isManagedCloudHost(host)) return undefined

	const encryptValue = get('encrypt')
	const trustValue = get('trustservercertificate', 'trust server certificate')

	return {
		engine: 'mssql',
		source,
		host,
		port: port ?? (get('port') ? Number(get('port')) : DEFAULT_PORTS.mssql),
		username: get('user id', 'userid', 'uid', 'user', 'username'),
		password: get('password', 'pwd'),
		database: get('database', 'initial catalog') ?? 'master',
		encrypt: encryptValue === undefined ? true : isTrue(encryptValue) || /^(mandatory|strict)$/i.test(encryptValue),
		trustServerCertificate: trustValue === undefined ? isLocalHost(host) : isTrue(trustValue),
	}
}

function parseKeyValuePairs(text: string): Record<string, string> {
	const fields: Record<string, string> = {}

	for (const part of text.split(';')) {
		const index = part.indexOf('=')
		if (index < 0) continue

		const key = part.substring(0, index).trim().toLowerCase()
		const rawValue = part.substring(index + 1).trim()
		fields[key] = rawValue.replace(/^\{(.*)\}$/, '$1').replace(/^(["'])(.*)\1$/, '$2')
	}

	return fields
}

/**
 * ADO.NET style: `Server=tcp:host,1433;Database=app;User Id=sa;Password=secret;TrustServerCertificate=True`.
 */
export function parseAdoConnectionString(value: string, source: string): DetectedDatastore | undefined {
	return mssqlDetection(source, parseKeyValuePairs(value), undefined)
}

/**
 * Prisma/JDBC style `sqlserver://host:1433;database=app;user=sa;password=secret`, or URL style
 * `mssql://user:pass@host:1433/app`.
 */
function parseSqlServerUrl(value: string, source: string): DetectedDatastore | undefined {
	const rest = value.replace(/^[a-z]+:\/\//i, '')

	if (rest.includes(';') || !rest.includes('@')) {
		const [hostPart, ...pairs] = rest.split(';')
		return mssqlDetection(source, parseKeyValuePairs(pairs.join(';')), hostPart.replace(/\/$/, '') || undefined)
	}

	let url: URL
	try {
		url = new URL(value.replace(/^[a-z]+:/i, 'mssql:'))
	} catch {
		return undefined
	}

	const fields: Record<string, string> = {}
	for (const [key, paramValue] of url.searchParams) fields[key.toLowerCase()] = paramValue
	if (url.username) fields.user = decode(url.username)
	if (url.password) fields.password = decode(url.password)
	const database = decode(url.pathname.replace(/^\//, ''))
	if (database) fields.database = database

	return mssqlDetection(source, fields, url.port ? `${url.hostname}:${url.port}` : url.hostname)
}
