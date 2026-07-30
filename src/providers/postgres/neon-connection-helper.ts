import knexlib from "knex";

/**
 * Hostname marker that uniquely identifies a Neon Postgres endpoint.
 */
export const NEON_HOST_MARKER = 'neon.tech';

/**
 * Default Postgres port used by Neon endpoints.
 */
export const NEON_DEFAULT_PORT = 5432;

/**
 * Connection timeout (ms) applied to Neon connections. Neon compute autosuspends
 * after inactivity (~300s); the first query after a wake can stall while the
 * endpoint resumes, so we allow generous headroom before failing.
 */
export const NEON_CONNECTION_TIMEOUT_MS = 10000;

/**
 * Environment variable keys, in priority order, that commonly hold a Postgres
 * connection string for Neon / Vercel Postgres deployments.
 */
export const NEON_ENV_URL_KEYS: readonly string[] = [
	'DATABASE_URL',
	'POSTGRES_URL',
	'DATABASE_URL_UNPOOLED',
	'POSTGRES_URL_NON_POOLING',
	'POSTGRES_PRISMA_URL',
];

export interface NeonConnectionDetails {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

/**
 * Options controlling how a Neon/cloud-Postgres SSL connection is built.
 */
export interface NeonConnectionOptions {
	/**
	 * When true, TLS certificate verification is relaxed (`rejectUnauthorized:
	 * false`). Defaults to false: Neon serves a valid public certificate, so the
	 * connection is verified (authenticated) by default. Only opt out for hosts
	 * with self-signed / proxied chains the user explicitly trusts.
	 */
	allowUnauthorizedCertificate?: boolean;

	/**
	 * When true, a direct Neon host is rewritten to its pooled (`-pooler`,
	 * PgBouncer transaction-mode) variant. Defaults to false so the host the user
	 * typed is honoured exactly — PgBouncer transaction pooling breaks core
	 * DB-GUI SQL (SET/RESET, LISTEN/NOTIFY, PREPARE, temp tables, WITH HOLD
	 * cursors, session state), so opt in only when you truly want pooling.
	 */
	usePooler?: boolean;
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
 * Extracts a Postgres connection string from the contents of a `.env` file.
 *
 * Scans the supplied keys (defaulting to {@link NEON_ENV_URL_KEYS}) and, when
 * several are present, prefers a value pointing at a Neon endpoint. Unlike
 * Laravel's `getEnvFileValue`, this preserves the full connection string
 * (scheme, port, query string) required to build a Neon connection.
 */
export function extractDatabaseUrlFromEnv(
	envFileContents: string | undefined,
	keys: readonly string[] = NEON_ENV_URL_KEYS,
): string | undefined {
	if (!envFileContents) {
		return undefined;
	}

	const lines = envFileContents
		.split('\n')
		.map((entry) => entry.trim());

	const values: string[] = [];
	for (const key of keys) {
		const line = lines.find((entry) => entry.startsWith(`${key}=`));
		if (!line) {
			continue;
		}

		const rawValue = stripSurroundingQuotes(line.substring(line.indexOf('=') + 1).trim());
		if (rawValue) {
			values.push(rawValue);
		}
	}

	if (values.length === 0) {
		return undefined;
	}

	return values.find((value) => value.includes(NEON_HOST_MARKER)) ?? values[0];
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
 *
 * This is opt-in only ({@link NeonConnectionOptions.usePooler}); the default
 * connection path honours the host exactly as supplied.
 */
export function toPooledNeonHost(host: string): string {
	if (host.includes('-pooler.')) {
		return host;
	}

	return host.replace(/^(ep-[^.]+?)\./, '$1-pooler.');
}

/**
 * Parses a Neon connection string into discrete connection details.
 *
 * The host is honoured exactly as supplied (a direct host stays direct, a
 * `-pooler` host stays pooled). Pass `{ usePooler: true }` to explicitly opt
 * into PgBouncer pooling. Returns undefined when the string is not a Neon
 * endpoint or cannot be parsed.
 */
export function parseNeonConnectionString(
	url: string | undefined,
	options: NeonConnectionOptions = {},
): NeonConnectionDetails | undefined {
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

	const host = options.usePooler ? toPooledNeonHost(parsed.hostname) : parsed.hostname;

	return {
		host,
		port: parsed.port ? Number(parsed.port) : NEON_DEFAULT_PORT,
		user: decodeURIComponent(parsed.username),
		password: decodeURIComponent(parsed.password),
		database,
	};
}

/**
 * Builds a Knex Postgres connection for Neon over verified TLS.
 *
 * Neon rejects non-TLS connections (`sslmode=require`), so SSL is always on and,
 * by default, its certificate is verified (`rejectUnauthorized: true`) — Neon
 * serves a valid public certificate. Verification is only relaxed when the
 * caller passes {@link NeonConnectionOptions.allowUnauthorizedCertificate}.
 * A generous connection timeout tolerates cold-start compute wake-ups.
 */
export function buildNeonKnexConnection(
	details: NeonConnectionDetails,
	options: NeonConnectionOptions = {},
): knexlib.Knex {
	return knexlib({
		client: 'postgres',
		connection: {
			host: details.host,
			port: details.port,
			user: details.user,
			password: details.password,
			database: details.database,
			ssl: { rejectUnauthorized: options.allowUnauthorizedCertificate !== true },
			connectionTimeoutMillis: NEON_CONNECTION_TIMEOUT_MS,
		},
		pool: {
			min: 0,
			max: 5,
			acquireTimeoutMillis: NEON_CONNECTION_TIMEOUT_MS,
		},
	});
}

/**
 * Builds a verified-TLS Knex Postgres connection from discrete connection
 * details.
 *
 * Reuses {@link buildNeonKnexConnection} so any cloud Postgres that requires TLS
 * (Neon, Supabase, etc.) can connect. The host is honoured exactly as supplied;
 * pass `{ usePooler: true }` to explicitly rewrite a Neon host to its pooled
 * variant.
 */
export function buildSslPostgresKnexConnection(
	details: NeonConnectionDetails,
	options: NeonConnectionOptions = {},
): knexlib.Knex {
	const host = options.usePooler ? toPooledNeonHost(details.host) : details.host;

	return buildNeonKnexConnection({ ...details, host }, options);
}

/**
 * Resolves a Neon connection string straight into a Knex connection.
 * Returns undefined when the string is not a parseable Neon endpoint.
 */
export function buildNeonConnectionFromString(
	url: string | undefined,
	options: NeonConnectionOptions = {},
): knexlib.Knex | undefined {
	const details = parseNeonConnectionString(url, options);
	if (!details) {
		return undefined;
	}

	return buildNeonKnexConnection(details, options);
}

function stripSurroundingQuotes(value: string): string {
	return value.replace(/^["']|["']$/g, '');
}
