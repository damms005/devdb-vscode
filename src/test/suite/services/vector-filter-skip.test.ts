import * as assert from 'assert';
import { buildWhereClause, isOpaqueColumnType } from '../../../services/sql';
import { Column, DatabaseEngine } from '../../../types';

const fakeEngine = {
	getNumericColumnTypeNamesLowercase: () => ['integer', 'bigint', 'smallint', 'numeric', 'int', 'decimal'],
} as unknown as DatabaseEngine;

function column(name: string, type: string, overrides: Partial<Column> = {}): Column {
	return {
		name,
		type,
		isPrimaryKey: false,
		isNumeric: false,
		isNullable: true,
		isEditable: true,
		isPlainTextType: false,
		...overrides,
	} as Column;
}

describe('buildWhereClause opaque-column skipping', () => {
	const columns: Column[] = [
		column('content', 'text', { isPlainTextType: true }),
		column('embedding', 'vector(3)', { isPlainTextType: false, isEditable: false }),
	];

	it('skips a pgvector column so no LIKE is built against it', () => {
		const entries = buildWhereClause(fakeEngine, 'postgres', { content: 'foo', embedding: 'bar' }, columns);

		assert.strictEqual(entries.length, 1, 'only the text column should produce a where entry');
		assert.strictEqual(entries[0].column, 'content');
	});

	it('still filters the text column normally when the vector column is absent from the filter', () => {
		const entries = buildWhereClause(fakeEngine, 'postgres', { content: 'foo' }, columns);

		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].operator, 'LIKE');
		assert.strictEqual(entries[0].value, '%foo%');
	});

	for (const dialect of ['mysql2', 'sqlite3', 'postgres'] as const) {
		it(`filters varchar(255), char(36), enum and date columns on ${dialect} even when not flagged plain text`, () => {
			const typed: Column[] = [
				column('name', 'varchar(255)'),
				column('code', 'char(36)'),
				column('status', dialect === 'postgres' ? 'USER-DEFINED' : "enum('active','banned')"),
				column('born', 'date'),
			];

			const entries = buildWhereClause(fakeEngine, dialect, { name: 'Jo', code: 'ab', status: 'act', born: '2024' }, typed);

			assert.deepStrictEqual(entries.map(entry => entry.column), ['name', 'code', 'status', 'born']);
			assert.ok(entries.every(entry => entry.operator === 'LIKE'));
		});
	}

	it('casts non-text Postgres types to text but leaves varchar/char native', () => {
		const typed: Column[] = [
			column('name', 'character varying'),
			column('born', 'date'),
			column('status', 'USER-DEFINED'),
			column('meta', 'jsonb', { isPlainTextType: true }),
		];

		const entries = buildWhereClause(fakeEngine, 'postgres', { name: 'a', born: '2024', status: 'x', meta: 'k' }, typed);

		assert.deepStrictEqual(entries.map(entry => [entry.column, entry.useRawCast]), [
			['name', false],
			['born', true],
			['status', true],
			['meta', true],
		]);
	});

	it('flags DATE for a text cast on the sqlite3 (SQLite/DuckDB) path but never on MySQL', () => {
		const typed: Column[] = [column('title', 'VARCHAR(255)'), column('born', 'DATE')];

		const duck = buildWhereClause(fakeEngine, 'sqlite3', { title: 'a', born: '2024' }, typed);
		assert.deepStrictEqual(duck.map(entry => entry.useRawCast), [false, true]);

		const mysql = buildWhereClause(fakeEngine, 'mysql2', { title: 'a', born: '2024' }, typed);
		assert.deepStrictEqual(mysql.map(entry => entry.useRawCast), [false, false]);
	});

	it('compares numeric columns by base type (decimal(10,2), int unsigned)', () => {
		const typed: Column[] = [column('price', 'decimal(10,2)'), column('qty', 'int unsigned')];

		const entries = buildWhereClause(fakeEngine, 'mysql2', { price: '9.5', qty: '3' }, typed);

		assert.deepStrictEqual(entries.map(entry => entry.operator), ['=', '=']);
	});

	it('recognises opaque types by base type', () => {
		for (const type of ['vector(1536)', 'halfvec(3)', 'sparsevec', 'bytea', 'BLOB', 'longblob', 'varbinary(16)', 'geometry', 'INTEGER[]', 'Array(String)', 'STRUCT(a INTEGER)', 'MAP(VARCHAR, INTEGER)', 'LIST', 'ARRAY']) {
			assert.strictEqual(isOpaqueColumnType(type), true, type);
		}
		for (const type of ['varchar(255)', 'char(36)', "enum('a','b')", 'date', 'json', 'jsonb', 'uuid', 'timestamp without time zone', 'USER-DEFINED', 'text']) {
			assert.strictEqual(isOpaqueColumnType(type), false, type);
		}
	});
});
