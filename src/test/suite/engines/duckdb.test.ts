import * as assert from 'assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { DuckDbEngine } from '../../../database-engines/duckdb-engine';

describe('DuckDB Tests', () => {
	let dbPath: string;
	let engine: DuckDbEngine;

	before(async function () {
		dbPath = join(tmpdir(), `devdb-duckdb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`);
		// Write-mode engine: these tests create tables / insert rows, so the file
		// must be opened read-write (the safe default is now read-only).
		engine = new DuckDbEngine(dbPath, { readOnly: false });
	});

	afterEach(async () => {
		const tables = await engine.getTables();
		for (const table of tables) {
			await engine.raw(`DROP TABLE IF EXISTS ${table}`);
		}
	});

	after(async function () {
		await engine.disconnect();
		if (existsSync(dbPath)) {
			rmSync(dbPath, { force: true });
		}
		engine.destroy();
	});

	it('should open a duckdb file and report a version', async () => {
		assert.strictEqual(await engine.isOkay(), true);
		const version = await engine.getVersion();
		assert.strictEqual(typeof version, 'string');
		assert.ok(version.length > 0);
	});

	it('should return table names', async () => {
		await engine.raw(`CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR)`);
		await engine.raw(`CREATE TABLE products (id INTEGER PRIMARY KEY, name VARCHAR)`);

		const tables = await engine.getTables();
		assert.deepStrictEqual(tables.sort(), ['products', 'users']);
	});

	it('should return column definitions including a LIST column', async () => {
		await engine.raw(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY NOT NULL,
				name VARCHAR,
				price DOUBLE,
				tags INTEGER[]
			)
		`);

		const columns = await engine.getColumns('items');

		const byName = Object.fromEntries(columns.map((column) => [column.name, column]));

		assert.strictEqual(byName.id.isPrimaryKey, true);
		assert.strictEqual(byName.id.isNullable, false);
		assert.strictEqual(byName.id.isNumeric, true);

		assert.strictEqual(byName.name.isNumeric, false);
		assert.strictEqual(byName.name.isPlainTextType, true);
		assert.strictEqual(byName.name.isEditable, true);

		assert.strictEqual(byName.price.isNumeric, true);

		// LIST column: not numeric, not plain text, not editable
		assert.strictEqual(byName.tags.isNumeric, false);
		assert.strictEqual(byName.tags.isPlainTextType, false);
		assert.strictEqual(byName.tags.isEditable, false);
	});

	it('should return total rows', async () => {
		await engine.raw(`CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR, age INTEGER)`);
		await engine.raw(`INSERT INTO users (id, name, age) VALUES (1, 'John', 30), (2, 'Jane', 25), (3, 'Bob', 40)`);

		const totalRows = await engine.getTotalRows('users', await engine.getColumns('users'));
		assert.strictEqual(totalRows, 3);
	});

	it('should return rows with JSON-serializable LIST/STRUCT values', async () => {
		await engine.raw(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY,
				name VARCHAR,
				tags INTEGER[],
				attrs STRUCT(color VARCHAR, size INTEGER)
			)
		`);

		await engine.raw(`
			INSERT INTO items (id, name, tags, attrs) VALUES
			(1, 'Widget', [1, 2, 3], {'color': 'red', 'size': 10}),
			(2, 'Gadget', [4, 5], {'color': 'blue', 'size': 20})
		`);

		const columns = await engine.getColumns('items');
		const result = await engine.getRows('items', columns, 10, 0);

		assert.ok(result);
		assert.strictEqual(result!.rows.length, 2);

		const first = result!.rows[0];
		assert.strictEqual(first.id, 1);
		assert.strictEqual(first.name, 'Widget');
		assert.deepStrictEqual(first.tags, [1, 2, 3]);
		assert.deepStrictEqual(first.attrs, { color: 'red', size: 10 });

		// Complex cells must survive JSON serialization (webview boundary)
		assert.doesNotThrow(() => JSON.stringify(result!.rows));
	});

	it('should return rows with a where clause', async () => {
		await engine.raw(`CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR, age INTEGER)`);
		await engine.raw(`
			INSERT INTO users (id, name, age) VALUES
			(1, 'Jane', 25), (2, 'John', 30), (3, 'Bob', 40), (4, 'Alice', 30)
		`);

		const columns = await engine.getColumns('users');

		const rows = await engine.getRows('users', columns, 10, 0, { age: 30 });
		assert.strictEqual(rows?.rows.length, 2);
		assert.deepStrictEqual(rows?.rows.map((r) => r.name).sort(), ['Alice', 'John']);

		const bobRows = await engine.getRows('users', columns, 10, 0, { name: 'Bob' });
		assert.strictEqual(bobRows?.rows.length, 1);
		assert.strictEqual(bobRows?.rows[0].age, 40);
	});

	it('should return foreign key definitions', async () => {
		await engine.raw(`CREATE TABLE ParentTable (id INTEGER PRIMARY KEY)`);
		await engine.raw(`
			CREATE TABLE ChildTable (
				id INTEGER PRIMARY KEY,
				parentId INTEGER,
				FOREIGN KEY (parentId) REFERENCES ParentTable(id)
			)
		`);

		const columns = await engine.getColumns('ChildTable');
		const foreignKeyColumn = columns.find((column) => column.name === 'parentId');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'ParentTable');
	});

	it('should return SUMMARIZE rows via raw() (D1: no longer a silent no-op)', async () => {
		await engine.raw(`CREATE TABLE metrics (id INTEGER, amount DOUBLE, label VARCHAR)`);
		await engine.raw(`INSERT INTO metrics VALUES (1, 10.5, 'a'), (2, 20.0, 'b'), (3, 30.5, 'a')`);

		const rows = await engine.raw(`SUMMARIZE metrics`);

		assert.ok(Array.isArray(rows), 'SUMMARIZE must return a rows array, not a { changes } no-op');
		assert.strictEqual(rows.length, 3, 'one summary row per column');
		const columnNames = rows.map((row: any) => String(row.column_name)).sort();
		assert.deepStrictEqual(columnNames, ['amount', 'id', 'label']);

		const helperRows = await engine.summarize('metrics');
		assert.strictEqual(helperRows.length, 3);
	});

	it('should disable edits and refuse mutations when opened read-only (D2/D4)', async () => {
		const readOnlyPath = join(tmpdir(), `devdb-duckdb-ro-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`);

		const writer = new DuckDbEngine(readOnlyPath, { readOnly: false });
		await writer.raw(`CREATE TABLE people (id INTEGER PRIMARY KEY, name VARCHAR)`);
		await writer.raw(`INSERT INTO people VALUES (1, 'Ada'), (2, 'Linus')`);
		await writer.disconnect();

		const readOnly = new DuckDbEngine(readOnlyPath, { readOnly: true });
		try {
			assert.strictEqual(readOnly.isReadOnly(), true);

			const columns = await readOnly.getColumns('people');
			assert.ok(columns.length > 0);
			assert.ok(columns.every((column) => column.isEditable === false), 'read-only columns must not be editable');

			// Reading still works
			const result = await readOnly.getRows('people', columns, 10, 0);
			assert.strictEqual(result?.rows.length, 2);

			// A mutation must throw, not silently no-op
			await assert.rejects(
				() => readOnly.commitChange({
					type: 'cell-update',
					table: 'people',
					column: { name: 'name', type: 'VARCHAR', isPrimaryKey: false, isPlainTextType: true, isNullable: true, isEditable: false },
					primaryKeyColumn: 'id',
					primaryKey: 1,
					newValue: 'Grace',
					originalValue: 'Ada',
				} as any),
				/read-only/i,
			);
		} finally {
			await readOnly.disconnect();
			readOnly.destroy();
			if (existsSync(readOnlyPath)) {
				rmSync(readOnlyPath, { force: true });
			}
		}
	});

	it('should open a CSV data file as a queryable view (D3)', async () => {
		const csvPath = join(tmpdir(), `devdb-duckdb-data-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
		writeFileSync(csvPath, 'id,name,score\n1,Ada,90\n2,Linus,85\n3,Grace,95\n');

		const dataEngine = new DuckDbEngine(':memory:', { dataFile: { path: csvPath, viewName: 'people' } });
		try {
			assert.strictEqual(await dataEngine.isOkay(), true);
			assert.strictEqual(dataEngine.isReadOnly(), true, 'data-file views are not editable');

			const tables = await dataEngine.getTables();
			assert.ok(tables.includes('people'), `expected view "people" in tables: ${tables.join(', ')}`);

			const columns = await dataEngine.getColumns('people');
			const columnNames = columns.map((column) => column.name).sort();
			assert.deepStrictEqual(columnNames, ['id', 'name', 'score']);
			assert.ok(columns.every((column) => column.isEditable === false));

			const result = await dataEngine.getRows('people', columns, 10, 0);
			assert.strictEqual(result?.rows.length, 3);
			assert.deepStrictEqual(result?.rows.map((row) => row.name).sort(), ['Ada', 'Grace', 'Linus']);
		} finally {
			await dataEngine.disconnect();
			dataEngine.destroy();
			if (existsSync(csvPath)) {
				rmSync(csvPath, { force: true });
			}
		}
	});
});
