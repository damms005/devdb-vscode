import * as assert from 'assert';
import { validateQuery, getQueryType } from '../../../services/mcp/query-validator';
import { sanitizeIdentifier } from '../../../services/sql';

const writes = { allowWrites: true };

describe('Query Validator', () => {
	describe('validateQuery (read-only default)', () => {
		it('should allow SELECT queries', () => {
			const result = validateQuery('SELECT * FROM users', 'postgres');
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.warning, undefined);
		});

		it('should allow read-only CTE, SHOW, EXPLAIN and trailing semicolon', () => {
			assert.strictEqual(validateQuery('WITH a AS (SELECT 1) SELECT * FROM a', 'postgres').allowed, true);
			assert.strictEqual(validateQuery('SHOW TABLES', 'mysql2').allowed, true);
			assert.strictEqual(validateQuery('EXPLAIN SELECT 1', 'sqlite').allowed, true);
			assert.strictEqual(validateQuery('SELECT 1;  ', 'postgres').allowed, true);
		});

		it('should not treat semicolons or keywords inside string literals as code', () => {
			assert.strictEqual(validateQuery("SELECT * FROM t WHERE a = 'x; DROP TABLE t'", 'postgres').allowed, true);
			assert.strictEqual(validateQuery("SELECT 'it''s -- fine' AS a", 'postgres').allowed, true);
		});

		it('should block INSERT, UPDATE and DELETE when writes are disallowed', () => {
			for (const query of ['INSERT INTO users (name) VALUES (\'John\')', 'UPDATE users SET name = \'Jane\' WHERE id = 1', 'DELETE FROM users WHERE id = 1']) {
				const result = validateQuery(query, 'postgres');
				assert.strictEqual(result.allowed, false, query);
				assert.ok(result.warning?.includes('read-only'), query);
			}
		});

		it('should block DROP DATABASE / SCHEMA / TRUNCATE (case and whitespace insensitive)', () => {
			assert.strictEqual(validateQuery('DROP DATABASE mydb').allowed, false);
			assert.strictEqual(validateQuery('DROP SCHEMA public').allowed, false);
			assert.strictEqual(validateQuery('TRUNCATE TABLE users').allowed, false);
			assert.strictEqual(validateQuery('drop database mydb').allowed, false);
			assert.strictEqual(validateQuery('   DROP DATABASE mydb').allowed, false);
		});

		it('should not strip # as a comment when it hides a stacked statement', () => {
			assert.strictEqual(validateQuery("SELECT data #> '{a}' FROM t; DROP TABLE t", 'postgres').allowed, false);
		});

		it('should not trust backslash escapes that hide a stacked statement', () => {
			assert.strictEqual(validateQuery("SELECT '\\'; DROP TABLE t; --'", 'postgres').allowed, false);
		});

		it('should run MySQL executable comments as code', () => {
			assert.strictEqual(validateQuery('SELECT 1 /*!50000 ; DROP TABLE t */', 'mysql2').allowed, false);
		});
	});

	describe('validateQuery (writes allowed)', () => {
		it('should allow writes but flag them destructive for confirmation', () => {
			const result = validateQuery('INSERT INTO users (name) VALUES (\'John\')', 'postgres', writes);
			assert.strictEqual(result.allowed, true);
			assert.strictEqual(result.destructive, true);
		});

		it('should flag DELETE without WHERE', () => {
			const result = validateQuery('DELETE FROM users', 'postgres', writes);
			assert.strictEqual(result.allowed, true);
			assert.ok(result.warning?.includes('DELETE without WHERE'));
		});

		it('should flag DROP TABLE, ALTER and GRANT', () => {
			assert.ok(validateQuery('DROP TABLE users', 'postgres', writes).warning?.includes('DROP'));
			assert.ok(validateQuery('ALTER TABLE users ADD COLUMN email varchar(255)', 'postgres', writes).warning?.includes('ALTER'));
			assert.ok(validateQuery('GRANT ALL ON users TO admin', 'postgres', writes).warning?.includes('GRANT'));
		});

		it('should keep always-blocked statements blocked', () => {
			assert.strictEqual(validateQuery('DROP DATABASE mydb', 'postgres', writes).allowed, false);
			assert.strictEqual(validateQuery('SELECT 1; DELETE FROM t', 'postgres', writes).allowed, false);
			assert.strictEqual(validateQuery('FLUSHALL', 'redis', writes).allowed, false);
		});
	});

	describe('audit bypass payloads', () => {
		const payloads: [string, string | undefined][] = [
			['/**/DROP DATABASE x', 'postgres'],
			['-- c\nTRUNCATE t', 'postgres'],
			['SELECT 1; DROP SCHEMA public CASCADE', 'postgres'],
			['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgres'],
			["COPY (SELECT 1) TO PROGRAM 'id'", 'postgres'],
			['EVAL "return redis.call(\'FLUSHALL\')" 0', 'redis'],
			['MODULE LOAD /x.so', 'redis'],
			['REPLICAOF evil 6379', 'redis'],
			['SYSTEM SHUTDOWN', 'clickhouse'],
			["INSERT INTO FUNCTION file('x.csv') SELECT 1", 'clickhouse'],
			["COPY (SELECT 1) TO '/tmp/x'", 'duckdb'],
			["SELECT * FROM read_text('/etc/passwd')", 'duckdb'],
			['flushall', 'redis'],
			['  DrOp TABLE t', 'postgres'],
			['MULTI', 'redis'],
		];

		for (const [payload, engine] of payloads) {
			it(`blocks ${JSON.stringify(payload)} (${engine})`, () => {
				assert.strictEqual(validateQuery(payload, engine).allowed, false);
			});

			it(`blocks ${JSON.stringify(payload)} with no engine type`, () => {
				assert.strictEqual(validateQuery(payload).allowed, false);
			});
		}

		it('blocks the always-dangerous payloads even when writes are allowed', () => {
			for (const [payload, engine] of payloads) {
				if (payload === '  DrOp TABLE t' || payload.startsWith('WITH d AS')) {
					continue;
				}
				assert.strictEqual(validateQuery(payload, engine, writes).allowed, false, payload);
			}
		});
	});

	describe('engine deny lists', () => {
		it('blocks Postgres server file and network functions', () => {
			assert.strictEqual(validateQuery("SELECT pg_read_file('/etc/passwd')", 'postgres', writes).allowed, false);
			assert.strictEqual(validateQuery("SELECT lo_import('/etc/passwd')", 'postgres', writes).allowed, false);
			assert.strictEqual(validateQuery("SELECT * FROM dblink('host=x', 'select 1') AS t(a int)", 'postgres', writes).allowed, false);
		});

		it('blocks ClickHouse KILL and table functions', () => {
			assert.strictEqual(validateQuery('KILL QUERY WHERE 1', 'clickhouse', writes).allowed, false);
			assert.strictEqual(validateQuery("SELECT * FROM url('http://x', CSV)", 'clickhouse', writes).allowed, false);
			assert.strictEqual(validateQuery("SELECT * FROM s3('http://x')", 'clickhouse', writes).allowed, false);
			assert.strictEqual(validateQuery("SELECT * FROM remote('x', db.t)", 'clickhouse', writes).allowed, false);
		});

		it('blocks DuckDB configuration and file access', () => {
			for (const query of ["ATTACH '/tmp/x.db'", 'INSTALL httpfs', 'LOAD httpfs', "SET enable_external_access = true", 'PRAGMA database_list', "EXPORT DATABASE '/tmp/x'", "SELECT * FROM read_csv('/etc/passwd')", "SELECT * FROM read_blob('/etc/passwd')"]) {
				assert.strictEqual(validateQuery(query, 'duckdb', writes).allowed, false, query);
			}
		});

		it('blocks Redis scripting, admin and slow verbs', () => {
			for (const verb of ['EVALSHA abc 0', 'EVAL_RO "x" 0', 'FCALL f 0', 'FUNCTION LOAD x', 'SLAVEOF x 1', 'ACL SETUSER x', 'MIGRATE x', 'CLIENT KILL x', 'SCRIPT LOAD x', 'DEBUG SLEEP 1', 'CONFIG SET x y', 'SHUTDOWN', 'FLUSHDB', 'EXEC', 'SWAPDB 0 1', 'KEYS *', '["flushall"]']) {
				assert.strictEqual(validateQuery(verb, 'redis', writes).allowed, false, verb);
			}
		});

		it('allows Redis reads, and blocks Redis writes unless writes are allowed', () => {
			assert.strictEqual(validateQuery('GET foo', 'redis').allowed, true);
			assert.strictEqual(validateQuery('GET drop:database:key', 'redis').allowed, true);
			assert.strictEqual(validateQuery('["HSET","user:1","name","Ada"]', 'redis').allowed, false);
			const allowed = validateQuery('["HSET","user:1","name","Ada"]', 'redis', writes);
			assert.strictEqual(allowed.allowed, true);
			assert.strictEqual(allowed.destructive, true);
		});

		it('allows MongoDB reads and blocks $out / $merge / unknown operations', () => {
			assert.strictEqual(validateQuery('{"collection":"c","operation":"find","query":{"filter":{}}}', 'mongodb').allowed, true);
			assert.strictEqual(validateQuery('{"collection":"c","operation":"aggregate","query":{"pipeline":[{"$out":"x"}]}}', 'mongodb').allowed, false);
			assert.strictEqual(validateQuery('{"collection":"c","operation":"aggregate","query":{"pipeline":[{"\\u0024merge":"x"}]}}', 'mongodb').allowed, false);
			assert.strictEqual(validateQuery('{"collection":"c","operation":"deleteMany"}', 'mongodb').allowed, false);
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
