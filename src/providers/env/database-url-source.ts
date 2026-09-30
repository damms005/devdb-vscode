import { DetectedDatastore, ENV_FILES, parseConnectionUrl, readEnvFiles, ZeroConfigSource } from '../zero-config/detected-datastore'

/**
 * Variables that commonly hold a connection URL, in the order rows are listed.
 */
export const DATABASE_URL_VARIABLES = [
	'DATABASE_URL',
	'POSTGRES_URL',
	'MYSQL_URL',
	'MONGODB_URI',
	'MONGO_URL',
	'REDIS_URL',
	'CLICKHOUSE_URL',
] as const

/**
 * Connection URLs in `.env`, `.env.local` and `.env.development`, e.g.
 * `DATABASE_URL=postgres://...`, `REDIS_URL=redis://...`.
 */
export const DatabaseUrlSource: ZeroConfigSource = {
	name: 'Connection URL in .env',

	detect(root: string): DetectedDatastore[] {
		const { values, fileOf } = readEnvFiles(root, ENV_FILES)
		const detections: DetectedDatastore[] = []

		for (const variable of DATABASE_URL_VARIABLES) {
			const value = values[variable]
			if (!value) continue

			const source = fileOf[variable] === '.env' ? variable : `${variable} in ${fileOf[variable]}`
			const detection = parseConnectionUrl(value, source, { variableName: variable, baseDir: root })
			if (detection) detections.push(detection)
		}

		return detections
	},
}
