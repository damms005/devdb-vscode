import * as assert from 'assert';
import {
	isNeonConnectionString,
	extractDatabaseUrlFromEnv,
	findNeonConnectionStringIn,
	toPooledNeonHost,
	parseNeonConnectionString,
} from '../../../providers/postgres/neon-connection-helper';

describe('Neon connection helper', () => {
	const directUrl = 'postgresql://alice:s3cret@ep-cool-fire-123.us-east-2.aws.neon.tech/appdb?sslmode=require';
	const pooledUrl = 'postgresql://alice:s3cret@ep-cool-fire-123-pooler.us-east-2.aws.neon.tech/appdb?sslmode=require';

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
			assert.strictEqual(
				toPooledNeonHost('ep-cool-fire-123.us-east-2.aws.neon.tech'),
				'ep-cool-fire-123-pooler.us-east-2.aws.neon.tech'
			);
		});

		it('leaves an already-pooled host unchanged', () => {
			const host = 'ep-cool-fire-123-pooler.us-east-2.aws.neon.tech';
			assert.strictEqual(toPooledNeonHost(host), host);
		});
	});

	describe('parseNeonConnectionString', () => {
		it('parses details and enforces the pooled host on port 5432', () => {
			const details = parseNeonConnectionString(directUrl);
			assert.deepStrictEqual(details, {
				host: 'ep-cool-fire-123-pooler.us-east-2.aws.neon.tech',
				port: 5432,
				user: 'alice',
				password: 's3cret',
				database: 'appdb',
			});
		});

		it('keeps an already-pooled host intact', () => {
			assert.strictEqual(parseNeonConnectionString(pooledUrl)?.host, 'ep-cool-fire-123-pooler.us-east-2.aws.neon.tech');
		});

		it('returns undefined for a non-Neon URL', () => {
			assert.strictEqual(parseNeonConnectionString('postgresql://u:p@localhost/db'), undefined);
		});

		it('returns undefined when no database is present', () => {
			assert.strictEqual(parseNeonConnectionString('postgresql://u:p@ep-x.neon.tech/'), undefined);
		});
	});
});
