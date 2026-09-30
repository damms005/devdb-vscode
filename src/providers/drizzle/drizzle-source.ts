import { existsSync } from 'fs'
import { join } from 'path'
import { DEFAULT_PORTS, DetectedDatastore, DetectedEngine, ENV_FILES, isManagedCloudHost, parseConnectionUrl, readEnvFiles, readTextFile, resolveSqlitePath, ZeroConfigSource } from '../zero-config/detected-datastore'

const DRIZZLE_CONFIG_FILES = ['drizzle.config.ts', 'drizzle.config.mts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.cjs']

/**
 * drizzle-kit `dialect` (and legacy `driver`) values. `turso`, `d1-http`, `pglite`, `expo` and
 * the like are left out on purpose.
 */
const DIALECT_ENGINES: Record<string, DetectedEngine> = {
	postgresql: 'postgres',
	pg: 'postgres',
	mysql: 'mysql',
	mysql2: 'mysql',
	singlestore: 'mysql',
	sqlite: 'sqlite',
	'better-sqlite': 'sqlite',
	libsql: 'sqlite',
}

const SKIPPED_DRIVERS = ['turso', 'd1-http', 'd1', 'pglite', 'expo', 'durable-sqlite', 'aws-data-api', 'sqlite-cloud']

export interface DrizzleConfig {
	dialect?: string
	driver?: string
	credentials: Record<string, string | number | boolean | undefined>
}

function stripComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1')
}

/**
 * Returns the text between the braces that follow `key:`, or undefined.
 */
function objectBodyAfter(text: string, key: string): string | undefined {
	const match = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(text)
	if (!match) return undefined

	let depth = 1
	const start = match.index + match[0].length
	for (let index = start; index < text.length; index++) {
		const char = text[index]
		if (char === '{') depth++
		if (char === '}') depth--
		if (depth === 0) return text.substring(start, index)
	}

	return undefined
}

/**
 * Splits an object body on top-level commas.
 */
function topLevelEntries(body: string): string[] {
	const entries: string[] = []
	let depth = 0
	let quote: string | null = null
	let current = ''

	for (let index = 0; index < body.length; index++) {
		const char = body[index]
		if (quote) {
			if (char === quote && body[index - 1] !== '\\') quote = null
		} else if (char === '"' || char === "'" || char === '`') {
			quote = char
		} else if ('{[('.includes(char)) {
			depth++
		} else if ('}])'.includes(char)) {
			depth--
		} else if (char === ',' && depth === 0) {
			entries.push(current)
			current = ''
			continue
		}
		current += char
	}
	if (current.trim()) entries.push(current)

	return entries
}

/**
 * Evaluates the small set of expressions drizzle configs use for credentials: literals,
 * `process.env.X`, `env.X`, `a ?? b`, `a || b`, `Number(...)`, `parseInt(...)` and `x!`.
 */
export function evaluateExpression(expression: string, env: Record<string, string>): string | number | boolean | undefined {
	const text = expression.trim().replace(/\s+as\s+[\w.<>[\]| ]+$/, '').replace(/!$/, '').trim()
	if (!text) return undefined

	for (const operator of ['??', '||']) {
		const parts = splitTopLevel(text, operator)
		if (parts.length > 1) {
			for (const part of parts) {
				const value = evaluateExpression(part, env)
				if (value !== undefined && value !== '') return value
			}
			return undefined
		}
	}

	const wrapped = text.match(/^(?:Number|parseInt|parseFloat|String)\(\s*([\s\S]+?)(?:\s*,\s*\d+)?\s*\)$/) ?? text.match(/^\+\s*([\s\S]+)$/)
	if (wrapped) {
		const inner = evaluateExpression(wrapped[1], env)
		return inner === undefined ? undefined : text.startsWith('String') ? String(inner) : Number(inner)
	}

	if (/^\(([\s\S]*)\)$/.test(text)) return evaluateExpression(text.slice(1, -1), env)
	if (text === 'true' || text === 'false') return text === 'true'
	if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)

	const envMatch = text.match(/^(?:process\.env|import\.meta\.env|env)(?:\.(\w+)|\[\s*['"`](\w+)['"`]\s*\])$/)
	if (envMatch) return env[envMatch[1] ?? envMatch[2]]

	const literal = text.match(/^(['"])([\s\S]*)\1$/)
	if (literal) return literal[2]

	const template = text.match(/^`([\s\S]*)`$/)
	if (template) {
		let unresolved = false
		const value = template[1].replace(/\$\{([^}]+)\}/g, (_match, inner: string) => {
			const resolved = evaluateExpression(inner, env)
			if (resolved === undefined) unresolved = true
			return String(resolved ?? '')
		})
		return unresolved ? undefined : value
	}

	return undefined
}

function splitTopLevel(text: string, operator: string): string[] {
	const parts: string[] = []
	let depth = 0
	let quote: string | null = null
	let start = 0

	for (let index = 0; index < text.length; index++) {
		const char = text[index]
		if (quote) {
			if (char === quote && text[index - 1] !== '\\') quote = null
			continue
		}
		if (char === '"' || char === "'" || char === '`') quote = char
		else if ('{[('.includes(char)) depth++
		else if ('}])'.includes(char)) depth--
		else if (depth === 0 && text.startsWith(operator, index)) {
			parts.push(text.substring(start, index))
			start = index + operator.length
			index += operator.length - 1
		}
	}
	parts.push(text.substring(start))

	return parts
}

/**
 * Reads `dialect`, `driver` and `dbCredentials` from a drizzle config without running it.
 */
export function parseDrizzleConfig(source: string, env: Record<string, string>): DrizzleConfig {
	const text = stripComments(source)
	const dialect = text.match(/\bdialect\s*:\s*['"`]([\w-]+)['"`]/)?.[1]
	const driver = text.match(/\bdriver\s*:\s*['"`]([\w-]+)['"`]/)?.[1]

	const credentials: DrizzleConfig['credentials'] = {}
	const body = objectBodyAfter(text, 'dbCredentials')
	if (body !== undefined) {
		for (const entry of topLevelEntries(body)) {
			const match = entry.match(/^\s*['"]?(\w+)['"]?\s*:\s*([\s\S]+)$/)
			if (!match) continue

			const [, key, expression] = match
			credentials[key] = expression.trim().startsWith('{') ? true : evaluateExpression(expression, env)
		}
	}

	return { dialect, driver, credentials }
}

/**
 * Env file named in `config({ path: '.env.local' })` / `dotenv.config({ path: ... })`.
 */
function dotenvPathIn(source: string): string | undefined {
	return source.match(/config\(\s*\{[^}]*\bpath\s*:\s*['"`]([^'"`]+)['"`]/)?.[1]
}

function asString(value: string | number | boolean | undefined): string | undefined {
	return value === undefined || typeof value === 'boolean' ? undefined : String(value)
}

/**
 * Drizzle: `drizzle.config.ts|js|mjs` with `dialect` and `dbCredentials.url` or
 * `dbCredentials.{host, port, user, password, database}`.
 */
export const DrizzleSource: ZeroConfigSource = {
	name: 'Drizzle',

	detect(root: string): DetectedDatastore[] {
		const configFile = DRIZZLE_CONFIG_FILES.find(file => existsSync(join(root, file)))
		if (!configFile) return []

		const source = readTextFile(root, configFile) ?? ''
		const dotenvPath = dotenvPathIn(source)
		const envFiles = dotenvPath ? [dotenvPath, ...ENV_FILES.filter(file => file !== dotenvPath)] : ENV_FILES
		const env = readEnvFiles(root, envFiles).values

		const config = parseDrizzleConfig(source, env)
		if (config.driver && SKIPPED_DRIVERS.includes(config.driver)) return []
		if (config.dialect === 'turso') return []

		const engine = DIALECT_ENGINES[config.dialect ?? ''] ?? DIALECT_ENGINES[config.driver ?? '']
		if (!engine) return []

		const credentials = config.credentials
		const url = asString(credentials.url) ?? asString(credentials.connectionString)

		if (engine === 'sqlite') {
			if (!url || /^(libsql|https?|wss?):/i.test(url)) return []
			const path = resolveSqlitePath(url, root)
			return path ? [{ engine, source: 'Drizzle', path }] : []
		}

		if (url) {
			const detection = parseConnectionUrl(url, 'Drizzle', { baseDir: root })
			return detection && detection.engine === engine ? [detection] : []
		}

		const host = asString(credentials.host)
		if (!host || isManagedCloudHost(host)) return []

		const ssl = credentials.ssl
		const hasSsl = ssl === true || ssl === 'require' || ssl === 'verify-full'

		return [{
			engine,
			source: 'Drizzle',
			host,
			port: credentials.port !== undefined ? Number(credentials.port) : DEFAULT_PORTS[engine],
			username: asString(credentials.user),
			password: asString(credentials.password),
			database: asString(credentials.database),
			...(hasSsl ? { ssl: true, allowUnauthorizedCertificate: ssl !== 'verify-full' } : {}),
		}]
	},
}
