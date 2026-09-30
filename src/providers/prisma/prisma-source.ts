import { existsSync, readdirSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { DetectedDatastore, DetectedEngine, ENV_FILES, parseConnectionUrl, readEnvFiles, readTextFile, ZeroConfigSource } from '../zero-config/detected-datastore'

const PRISMA_CONFIG_FILES = ['prisma.config.ts', 'prisma.config.mts', 'prisma.config.js', 'prisma.config.mjs', 'prisma.config.cjs']

const PROVIDER_ENGINES: Record<string, DetectedEngine> = {
	postgresql: 'postgres',
	postgres: 'postgres',
	cockroachdb: 'postgres',
	mysql: 'mysql',
	sqlserver: 'mssql',
	mongodb: 'mongodb',
	sqlite: 'sqlite',
}

/**
 * A url expression: a literal, or the name of an environment variable.
 */
export type UrlExpression = { literal: string } | { env: string }

export interface PrismaDatasource {
	provider: string
	url?: UrlExpression
}

function stripLineComments(text: string): string {
	return text.replace(/(^|[^:"'])\/\/.*$/gm, '$1')
}

/**
 * Reads the `datasource <name> { provider = "...", url = env("X") }` block of a Prisma schema.
 */
export function parsePrismaDatasource(schema: string): PrismaDatasource | undefined {
	const block = stripLineComments(schema).match(/datasource\s+\w+\s*\{([^}]*)\}/)?.[1]
	if (!block) return undefined

	const provider = block.match(/\bprovider\s*=\s*"([^"]+)"/)?.[1]
	if (!provider) return undefined

	const envUrl = block.match(/\burl\s*=\s*env\(\s*"([^"]+)"\s*\)/)?.[1]
	const literalUrl = block.match(/\burl\s*=\s*"([^"]+)"/)?.[1]

	return {
		provider,
		url: envUrl ? { env: envUrl } : literalUrl ? { literal: literalUrl } : undefined,
	}
}

/**
 * Reads `schema` and `datasource.url` from a Prisma 7 `prisma.config.ts`. The url can be
 * `env('X')`, `process.env.X` or a string literal.
 */
export function parsePrismaConfig(config: string): { schema?: string, url?: UrlExpression } {
	const text = stripLineComments(config)
	const schema = text.match(/\bschema\s*:\s*['"`]([^'"`]+)['"`]/)?.[1]
	const datasource = text.match(/\bdatasource\s*:\s*\{([^}]*)\}/)?.[1] ?? ''
	const urlMatch = datasource.match(/\burl\s*:\s*(env\(\s*['"`](\w+)['"`]\s*\)|process\.env\.(\w+)|process\.env\[\s*['"`](\w+)['"`]\s*\]|['"`]([^'"`$]+)['"`])/)

	const envName = urlMatch?.[2] ?? urlMatch?.[3] ?? urlMatch?.[4]
	const url: UrlExpression | undefined = envName ? { env: envName } : urlMatch?.[5] ? { literal: urlMatch[5] } : undefined

	return { schema, url }
}

function schemaFilesIn(path: string): string[] {
	if (!existsSync(path)) return []

	if (statSync(path).isDirectory()) {
		return readdirSync(path)
			.filter(file => file.endsWith('.prisma'))
			.sort()
			.map(file => join(path, file))
	}

	return [path]
}

function findDatasource(schemaPaths: string[]): { datasource: PrismaDatasource, schemaDir: string } | undefined {
	for (const schemaPath of schemaPaths) {
		for (const file of schemaFilesIn(schemaPath)) {
			const content = readTextFile(file)
			const datasource = content ? parsePrismaDatasource(content) : undefined
			if (datasource) return { datasource, schemaDir: dirname(file) }
		}
	}

	return undefined
}

function packageJsonSchemaPath(root: string): string | undefined {
	try {
		const schema = JSON.parse(readTextFile(root, 'package.json') ?? '{}')?.prisma?.schema
		return typeof schema === 'string' ? schema : undefined
	} catch {
		return undefined
	}
}

/**
 * Prisma: `datasource db { provider, url = env("DATABASE_URL") }` in `prisma/schema.prisma`,
 * `schema.prisma`, `prisma/schema/*.prisma`, or the Prisma 7 `prisma.config.ts` url.
 */
export const PrismaSource: ZeroConfigSource = {
	name: 'Prisma',

	detect(root: string): DetectedDatastore[] {
		const configFile = PRISMA_CONFIG_FILES.find(file => existsSync(join(root, file)))
		const config = configFile ? parsePrismaConfig(readTextFile(root, configFile) ?? '') : {}

		const candidates = [
			config.schema,
			packageJsonSchemaPath(root),
			'prisma/schema.prisma',
			'schema.prisma',
			'prisma/schema',
		].filter((path): path is string => Boolean(path)).map(path => resolve(root, path))

		const found = findDatasource(candidates)
		if (!found) return []

		const engine = PROVIDER_ENGINES[found.datasource.provider.toLowerCase()]
		if (!engine) return []

		const urlFromConfig = !found.datasource.url && config.url
		const url = found.datasource.url ?? config.url
		if (!url) return []

		let value: string | undefined
		if ('literal' in url) {
			value = url.literal
		} else {
			value = readEnvFiles(root, ENV_FILES).values[url.env]
				?? readEnvFiles(found.schemaDir, ['.env']).values[url.env]
		}
		if (!value) return []

		const baseDir = urlFromConfig ? root : found.schemaDir
		const detection = parseConnectionUrl(value, 'Prisma', { engine, baseDir })
		if (!detection || detection.engine !== engine) return []

		return [detection]
	},
}
