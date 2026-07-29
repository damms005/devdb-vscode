import * as assert from 'assert';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import { DuckDbEngine } from '../../../database-engines/duckdb-engine';

describe('DuckDB Tests', () => {
	let dbPath: string;
	let engine: DuckDbEngine;

	before(async function () {
		dbPath = join(tmpdir(), `devdb-duckdb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.duckdb`);
		engine = new DuckDbEngine(dbPath);
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
});
