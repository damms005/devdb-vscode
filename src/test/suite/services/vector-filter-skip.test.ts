import * as assert from 'assert';
import { buildWhereClause } from '../../../services/sql';
import { Column, DatabaseEngine } from '../../../types';

const fakeEngine = {
	getNumericColumnTypeNamesLowercase: () => ['integer', 'bigint', 'smallint', 'numeric'],
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
});
