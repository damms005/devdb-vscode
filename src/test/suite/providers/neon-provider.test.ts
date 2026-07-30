import * as assert from 'assert';
import {
	isNeonConnectionString,
	extractDatabaseUrlFromEnv,
	findNeonConnectionStringIn,
	toPooledNeonHost,
	parseNeonConnectionString,
	buildNeonKnexConnection,
	buildSslPostgresKnexConnection,
	NEON_CONNECTION_TIMEOUT_MS,
	NeonConnectionDetails,
} from '../../../providers/postgres/neon-connection-helper';

describe('Neon connection helper', () => {
	const directHost = 'ep-cool-fire-123.us-east-2.aws.neon.tech';
	const pooledHost = 'ep-cool-fire-123-pooler.us-east-2.aws.neon.tech';
	const directUrl = `postgresql://alice:s3cret@${directHost}/appdb?sslmode=require`;
	const pooledUrl = `postgresql://alice:s3cret@${pooledHost}/appdb?sslmode=require`;

	const details: NeonConnectionDetails = {
		host: directHost,
		port: 5432,
		user: 'alice',
		password: 's3cret',
		database: 'appdb',
	};

	describe('isNeonConnectionString', () => {
		it('detects a Neon host', () => {
			assert.strictEqual(isNeonConnectionString(directUrl), true);
		});

		it('rejects a non-Neon host', () => {
			assert.strictEqual(isNeonConnectionString('postgresql://u:p@localhost:5432/db'), false);
		});

		it('rejects undefined', () => {
			assert.strictEqual(isNeonConnectionString(undefined), false);
		});
	});

	describe('extractDatabaseUrlFromEnv', () => {
		it('extracts a quoted DATABASE_URL preserving scheme and query', () => {
			const env = `APP_NAME=Demo\nDATABASE_URL="${directUrl}"\nOTHER=1`;
			assert.strictEqual(extractDatabaseUrlFromEnv(env), directUrl);
		});

		it('extracts an unquoted DATABASE_URL', () => {
			assert.strictEqual(extractDatabaseUrlFromEnv(`DATABASE_URL=${directUrl}`), directUrl);
		});

		it('reads alternative Vercel/Neon keys when DATABASE_URL is absent', () => {
			assert.strictEqual(extractDatabaseUrlFromEnv(`POSTGRES_URL=${directUrl}`), directUrl);
			assert.strictEqual(extractDatabaseUrlFromEnv(`DATABASE_URL_UNPOOLED=${directUrl}`), directUrl);
		});

		it('prefers a Neon value over a non-Neon one', () => {
			const env = `DATABASE_URL=postgresql://u:p@localhost:5432/db\nPOSTGRES_URL=${directUrl}`;
			assert.strictEqual(extractDatabaseUrlFromEnv(env), directUrl);
		});

		it('returns undefined when absent', () => {
			assert.strictEqual(extractDatabaseUrlFromEnv('APP_NAME=Demo'), undefined);
		});
	});

	describe('findNeonConnectionStringIn', () => {
		it('finds a Neon URL embedded in JSON config text', () => {
			const rc = `[{ "type": "postgres", "url": "${directUrl}" }]`;
			assert.strictEqual(findNeonConnectionStringIn(rc), directUrl);
		});

		it('returns undefined when no Neon URL present', () => {
			assert.strictEqual(findNeonConnectionStringIn('{"type":"sqlite"}'), undefined);
		});
	});

	describe('toPooledNeonHost', () => {
		it('rewrites a direct host to its pooled variant', () => {
			assert.strictEqual(toPooledNeonHost(directHost), pooledHost);
		});

		it('leaves an already-pooled host unchanged', () => {
			assert.strictEqual(toPooledNeonHost(pooledHost), pooledHost);
		});
	});

	describe('parseNeonConnectionString', () => {
		it('honours the host exactly as supplied (no silent pooler rewrite)', () => {
			const parsed = parseNeonConnectionString(directUrl);
			assert.deepStrictEqual(parsed, {
				host: directHost,
				port: 5432,
				user: 'alice',
				password: 's3cret',
				database: 'appdb',
			});
		});

		it('keeps an already-pooled host intact', () => {
			assert.strictEqual(parseNeonConnectionString(pooledUrl)?.host, pooledHost);
		});

		it('rewrites to the pooled host only when explicitly opted in', () => {
			assert.strictEqual(parseNeonConnectionString(directUrl, { usePooler: true })?.host, pooledHost);
		});

		it('returns undefined for a non-Neon URL', () => {
			assert.strictEqual(parseNeonConnectionString('postgresql://u:p@localhost/db'), undefined);
		});

		it('returns undefined when no database is present', () => {
			assert.strictEqual(parseNeonConnectionString('postgresql://u:p@ep-x.neon.tech/'), undefined);
		});
	});

	describe('buildNeonKnexConnection', () => {
		const connectionConfig = (knex: ReturnType<typeof buildNeonKnexConnection>): Record<string, any> =>
			knex.client.config.connection as Record<string, any>;

		it('defaults to verified TLS (rejectUnauthorized: true)', () => {
			const knex = buildNeonKnexConnection(details);
			assert.deepStrictEqual(connectionConfig(knex).ssl, { rejectUnauthorized: true });
			knex.destroy();
		});

		it('relaxes TLS verification only on explicit opt-in', () => {
			const knex = buildNeonKnexConnection(details, { allowUnauthorizedCertificate: true });
			assert.deepStrictEqual(connectionConfig(knex).ssl, { rejectUnauthorized: false });
			knex.destroy();
		});

		it('sets a cold-start connection timeout', () => {
			const knex = buildNeonKnexConnection(details);
			assert.strictEqual(connectionConfig(knex).connectionTimeoutMillis, NEON_CONNECTION_TIMEOUT_MS);
			assert.ok(NEON_CONNECTION_TIMEOUT_MS >= 10000);
			knex.destroy();
		});

		it('honours the supplied host by default', () => {
			const knex = buildSslPostgresKnexConnection(details);
			assert.strictEqual(connectionConfig(knex).host, directHost);
			knex.destroy();
		});

		it('rewrites to the pooled host only when explicitly opted in', () => {
			const knex = buildSslPostgresKnexConnection(details, { usePooler: true });
			assert.strictEqual(connectionConfig(knex).host, pooledHost);
			knex.destroy();
		});
	});
});
