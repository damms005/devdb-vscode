import * as assert from 'assert';
import { validateQuery, getQueryType } from '../../../services/mcp/query-validator';
import { sanitizeIdentifier } from '../../../services/sql';

describe('Query Validator', () => {
	describe('validateQuery', () => {
		it('should allow SELECT queries', () => {
			const result = validateQuery('SELECT * FROM users');
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.warning, undefined);
		});

		it('should allow INSERT queries', () => {
			const result = validateQuery('INSERT INTO users (name) VALUES (\'John\')');
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.warning, undefined);
		});

		it('should allow UPDATE queries', () => {
			const result = validateQuery('UPDATE users SET name = \'Jane\' WHERE id = 1');
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.warning, undefined);
		});

		it('should allow DELETE with WHERE clause', () => {
			const result = validateQuery('DELETE FROM users WHERE id = 1');
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.warning, undefined);
		});

		it('should warn on DELETE without WHERE clause', () => {
			const result = validateQuery('DELETE FROM users');
			assert.strictEqual(result.allowed, true);
			assert.ok(result.warning?.includes('DELETE without WHERE'));
		});

		it('should warn on DROP TABLE', () => {
			const result = validateQuery('DROP TABLE users');
			assert.strictEqual(result.allowed, true);
			assert.ok(result.warning?.includes('DROP'));
		});

		it('should block DROP DATABASE', () => {
			const result = validateQuery('DROP DATABASE mydb');
			assert.strictEqual(result.allowed, false);
			assert.ok(result.warning?.includes('blocked'));
		});

		it('should block DROP SCHEMA', () => {
			const result = validateQuery('DROP SCHEMA public');
			assert.strictEqual(result.allowed, false);
			assert.ok(result.warning?.includes('blocked'));
		});

		it('should block TRUNCATE', () => {
			const result = validateQuery('TRUNCATE TABLE users');
			assert.strictEqual(result.allowed, false);
			assert.ok(result.warning?.includes('blocked'));
		});

		it('should warn on ALTER TABLE', () => {
			const result = validateQuery('ALTER TABLE users ADD COLUMN email varchar(255)');
			assert.strictEqual(result.allowed, true);
			assert.ok(result.warning?.includes('ALTER'));
		});

		it('should warn on GRANT', () => {
			const result = validateQuery('GRANT ALL ON users TO admin');
			assert.strictEqual(result.allowed, true);
			assert.ok(result.warning?.includes('GRANT'));
		});

		it('should be case insensitive', () => {
			const result = validateQuery('drop database mydb');
			assert.strictEqual(result.allowed, false);
		});

		it('should handle leading whitespace', () => {
			const result = validateQuery('   DROP DATABASE mydb');
			assert.strictEqual(result.allowed, false);
		});
	});

	describe('getQueryType', () => {
		it('should extract SELECT', () => {
			assert.strictEqual(getQueryType('SELECT * FROM users'), 'SELECT');
		});

		it('should extract INSERT', () => {
			assert.strictEqual(getQueryType('INSERT INTO users VALUES (1)'), 'INSERT');
		});

		it('should handle leading whitespace', () => {
			assert.strictEqual(getQueryType('  DELETE FROM users'), 'DELETE');
		});

		it('should return UNKNOWN for empty string', () => {
			assert.strictEqual(getQueryType(''), 'UNKNOWN');
		});
	});
});

describe('sanitizeIdentifier', () => {
	it('should wrap identifier with backtick delimiters', () => {
		assert.strictEqual(sanitizeIdentifier('users', '`', '`'), '`users`');
	});

	it('should escape backtick within identifier', () => {
		assert.strictEqual(sanitizeIdentifier('user`s', '`', '`'), '`user``s`');
	});

	it('should wrap identifier with bracket delimiters', () => {
		assert.strictEqual(sanitizeIdentifier('users', '[', ']'), '[users]');
	});

	it('should escape close bracket within identifier', () => {
		assert.strictEqual(sanitizeIdentifier('user]s', '[', ']'), '[user]]s]');
	});

	it('should handle identifier with no special chars', () => {
		assert.strictEqual(sanitizeIdentifier('simple_table', '`', '`'), '`simple_table`');
	});

	it('should handle multiple delimiter chars in identifier', () => {
		assert.strictEqual(sanitizeIdentifier('a`b`c', '`', '`'), '`a``b``c`');
	});
});

describe('Query Validator - Redis engine guard', () => {
	it('blocks FLUSHALL for redis (plain string)', () => {
		assert.strictEqual(validateQuery('FLUSHALL', 'redis').allowed, false);
	});

	it('blocks FLUSHDB for redis via JSON-array command form', () => {
		assert.strictEqual(validateQuery('["FLUSHDB"]', 'redis').allowed, false);
	});

	it('blocks CONFIG and SHUTDOWN for redis', () => {
		assert.strictEqual(validateQuery('CONFIG SET maxmemory 0', 'redis').allowed, false);
		assert.strictEqual(validateQuery('SHUTDOWN NOSAVE', 'redis').allowed, false);
	});

	it('allows normal redis reads/writes', () => {
		assert.strictEqual(validateQuery('GET foo', 'redis').allowed, true);
		assert.strictEqual(validateQuery('["HSET","user:1","name","Ada"]', 'redis').allowed, true);
	});

	it('does not apply SQL patterns to redis commands', () => {
		// "DROP" is a real (harmless) concept-free token for redis; ensure SQL DROP-DATABASE block does not fire
		assert.strictEqual(validateQuery('GET drop:database:key', 'redis').allowed, true);
	});
});
