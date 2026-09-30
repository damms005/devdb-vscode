import * as assert from 'assert';
import { assertReadOnlySql, SqlLexDialect, stripSqlCommentsAndLiterals } from '../../../services/sql';

const SELECT_ONLY = ['SELECT', 'WITH'];

describe('Read-only SQL guard', () => {
	describe('stripSqlCommentsAndLiterals', () => {
		it('removes line and block comments', () => {
			assert.strictEqual(stripSqlCommentsAndLiterals('/**/DROP -- x\nTABLE', 'postgres').replace(/\s+/g, ' ').trim(), 'DROP TABLE');
		});

		it('blanks string literals so a quoted ";" is not a separator', () => {
			assert.strictEqual(stripSqlCommentsAndLiterals("SELECT ';DROP'", 'postgres'), "SELECT ''");
		});

		it('handles Postgres dollar quoting and nested comments', () => {
			assert.strictEqual(stripSqlCommentsAndLiterals('SELECT $tag$ ; $tag$ /* a /* b */ c */ 1', 'postgres').replace(/\s+/g, ' '), "SELECT '' 1");
		});

		it('treats a backslash as literal in standard Postgres strings', () => {
			// 'a\' closes the string in Postgres, so the ; after it is a real separator
			assert.ok(stripSqlCommentsAndLiterals("SELECT 'a\\'; DELETE FROM t; --'", 'postgres').includes(';'));
		});

		it('treats a backslash as an escape in MySQL strings', () => {
			assert.strictEqual(stripSqlCommentsAndLiterals("SELECT 'a\\'b'", 'mysql'), "SELECT ''");
		});

		it('rejects MySQL executable comments', () => {
			assert.throws(() => stripSqlCommentsAndLiterals('SELECT 1 /*!50000 , SLEEP(1) */', 'mysql'), /executable comments/);
		});

		it('rejects unterminated literals and comments', () => {
			assert.throws(() => stripSqlCommentsAndLiterals("SELECT 'x", 'sqlite'), /Unterminated/);
			assert.throws(() => stripSqlCommentsAndLiterals('SELECT 1 /* x', 'mssql'), /Unterminated/);
		});
	});

	describe('assertReadOnlySql', () => {
		const dialects: SqlLexDialect[] = ['postgres', 'mysql', 'sqlite', 'mssql'];

		for (const dialect of dialects) {
			it(`accepts a single SELECT with a trailing semicolon (${dialect})`, () => {
				assert.doesNotThrow(() => assertReadOnlySql('SELECT 1;', dialect, SELECT_ONLY));
				assert.doesNotThrow(() => assertReadOnlySql('-- lead\n(SELECT 1)', dialect, SELECT_ONLY));
			});

			for (const bypass of ['/**/DROP TABLE users', '-- c\nTRUNCATE users', 'SELECT 1; DROP TABLE users', 'SELECT 1;DELETE FROM users;', "COPY (SELECT 1) TO PROGRAM 'id'"]) {
				it(`rejects ${JSON.stringify(bypass)} (${dialect})`, () => {
					assert.throws(() => assertReadOnlySql(bypass, dialect, SELECT_ONLY), /Read-only mode/);
				});
			}
		}

		it('applies denied patterns to the stripped statement only', () => {
			const denied = [/\bINTO\s+OUTFILE\b/i];
			assert.throws(() => assertReadOnlySql("SELECT 1 INTO OUTFILE '/tmp/x'", 'mysql', SELECT_ONLY, denied), /INTO OUTFILE/);
			assert.doesNotThrow(() => assertReadOnlySql("SELECT 'INTO OUTFILE'", 'mysql', SELECT_ONLY, denied));
		});

		it('rejects an empty query', () => {
			assert.throws(() => assertReadOnlySql(' ; -- nothing', 'postgres', SELECT_ONLY), /empty/);
		});
	});
});
