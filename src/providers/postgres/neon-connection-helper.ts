import knexlib from "knex";

/**
 * Hostname marker that uniquely identifies a Neon Postgres endpoint.
 */
export const NEON_HOST_MARKER = 'neon.tech';

/**
 * Default port used by Neon's pooled (PgBouncer) endpoint.
 */
export const NEON_DEFAULT_PORT = 5432;

export interface NeonConnectionDetails {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

/**
 * Returns true if the given connection string points at a Neon Postgres endpoint.
 */
export function isNeonConnectionString(url: string | undefined): boolean {
	if (!url) {
		return false;
	}

	return url.includes(NEON_HOST_MARKER);
}

/**
 * Extracts a raw `DATABASE_URL` value from the contents of a `.env` file.
 *
 * Unlike Laravel's `getEnvFileValue`, this preserves the full connection string
 * (scheme, port, query string) which is required to build a Neon connection.
 */
export function extractDatabaseUrlFromEnv(envFileContents: string | undefined): string | undefined {
	if (!envFileContents) {
		return undefined;
	}

	const line = envFileContents
		.split('\n')
		.map((entry) => entry.trim())
		.find((entry) => entry.startsWith('DATABASE_URL='));

	if (!line) {
		return undefined;
	}

	const rawValue = line.substring(line.indexOf('=') + 1).trim();

	return stripSurroundingQuotes(rawValue);
}

/**
 * Finds the first Neon connection string embedded in an arbitrary blob of text,
 * e.g. the raw contents of a `.devdbrc` file.
 */
export function findNeonConnectionStringIn(contents: string | undefined): string | undefined {
	if (!contents) {
		return undefined;
	}

	const match = contents.match(/postgres(?:ql)?:\/\/[^\s"'`]+neon\.tech[^\s"'`]*/i);

	return match ? stripSurroundingQuotes(match[0]) : undefined;
}

/**
 * Rewrites a Neon host to its pooled (`-pooler`) variant so connections go
 * through PgBouncer. Direct hosts look like `ep-xxx.region.aws.neon.tech`;
 * pooled hosts look like `ep-xxx-pooler.region.aws.neon.tech`.
 */
export function toPooledNeonHost(host: string): string {
	if (host.includes('-pooler.')) {
		return host;
	}

	return host.replace(/^(ep-[^.]+?)\./, '$1-pooler.');
}

/**
 * Parses a Neon connection string into discrete, pooler-aware connection details.
 * Returns undefined when the string is not a Neon endpoint or cannot be parsed.
 */
export function parseNeonConnectionString(url: string | undefined): NeonConnectionDetails | undefined {
	if (!isNeonConnectionString(url)) {
		return undefined;
	}

	let parsed: URL;
	try {
		parsed = new URL(url as string);
	} catch {
		return undefined;
	}

	const database = parsed.pathname.replace(/^\//, '');
	if (!database) {
		return undefined;
	}

	return {
		host: toPooledNeonHost(parsed.hostname),
		port: parsed.port ? Number(parsed.port) : NEON_DEFAULT_PORT,
		user: decodeURIComponent(parsed.username),
		password: decodeURIComponent(parsed.password),
		database,
	};
}

/**
 * Builds a Knex Postgres connection for Neon with SSL enforced.
 *
 * Neon rejects non-TLS connections (`sslmode=require`), so SSL is always on.
 * `rejectUnauthorized` is disabled to tolerate proxies/self-signed chains the
 * same way GUI clients do; Neon itself serves a valid certificate.
 */
export function buildNeonKnexConnection(details: NeonConnectionDetails): knexlib.Knex {
	return knexlib({
		client: 'postgres',
		connection: {
			host: details.host,
			port: details.port,
			user: details.user,
			password: details.password,
			database: details.database,
			ssl: { rejectUnauthorized: false },
		},
	});
}

/**
 * Resolves a Neon connection string straight into a Knex connection.
 * Returns undefined when the string is not a parseable Neon endpoint.
 */
export function buildNeonConnectionFromString(url: string | undefined): knexlib.Knex | undefined {
	const details = parseNeonConnectionString(url);
	if (!details) {
		return undefined;
	}

	return buildNeonKnexConnection(details);
}

function stripSurroundingQuotes(value: string): string {
	return value.replace(/^["']|["']$/g, '');
}
