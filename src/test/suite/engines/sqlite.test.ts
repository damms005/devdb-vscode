import * as assert from 'assert';
import { SqliteEngine } from '../../../database-engines/sqlite-engine';
import { SerializedMutation } from '../../../types';

describe('Sqlite Tests', () => {
	it('should return foreign key definitions', async () => {
		let engine = new SqliteEngine
		let connection = (new SqliteEngine()).getConnection()!;

		await engine?.raw(`DROP TABLE IF EXISTS ChildTable`);
		await engine?.raw(`DROP TABLE IF EXISTS ParentTable`);

		// Create two tables with a foreign key relationship for testing
		await engine.raw(`
        CREATE TABLE ParentTable (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    `);

		await engine.raw(`
        CREATE TABLE ChildTable (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parentId INTEGER,
            FOREIGN KEY(parentId) REFERENCES ParentTable(id)
        )
    `);

		const columns = await engine.getColumns('ChildTable');

		const foreignKeyColumn = columns.find((column: { name: string }) => column.name === 'parentId');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'ParentTable');

		engine.destroy();
	});

	describe('SqliteEngine Tests', () => {
		let engine: SqliteEngine;

		before(async function () {
			engine = new SqliteEngine();
		});

		beforeEach(async () => {
			await engine?.raw(`DROP TABLE IF EXISTS products`);
		});

		afterEach(async () => {
			const tables = await engine.getTables();
			for (const table of tables) {
				await engine?.raw(`DROP TABLE ${table}`);
			}
		});

		it('should return table names', async () => {
			await engine?.raw(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			await engine?.raw(`
            CREATE TABLE products (
                id INTEGER PRIMARY KEY,
                name TEXT,
                price INTEGER
            )
        `);

			const tables = await engine.getTables();
			assert.deepStrictEqual(tables, ['products', 'users']);
		});

		it('should return column definitions', async () => {
			await engine?.raw(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY NOT NULL,
                name TEXT,
                age INTEGER
            )
        `);

			const columns = await engine.getColumns('users');

			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'INTEGER', isPrimaryKey: true, isNumeric: true, isNullable: false, foreignKey: undefined, isEditable: true, isPlainTextType: false },
				{ name: 'name', type: 'TEXT', isPrimaryKey: false, isNumeric: false, isNullable: true, foreignKey: undefined, isEditable: true, isPlainTextType: true },
				{ name: 'age', type: 'INTEGER', isPrimaryKey: false, isNumeric: true, isNullable: true, foreignKey: undefined, isEditable: true, isPlainTextType: false }
			]);
		});

		it('should return total rows', async () => {
			await engine?.raw(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			await engine?.raw(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const totalRows = await engine.getTotalRows('users', []);
			assert.strictEqual(totalRows, 3);
		});

		it('should return rows', async () => {
			await engine?.raw(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			await engine?.raw(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const rows = await engine.getRows('users', await engine.getColumns('users'), 2, 0);

			assert.deepStrictEqual(rows?.rows, [
				{ id: 1, name: 'John', age: 30 },
				{ id: 2, name: 'Jane', age: 25 }
			]);
		});

		it('should save changes', async () => {
			await engine?.raw(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT,
					age INTEGER
				)
			`);

			await engine?.raw(`
				INSERT INTO users (name, age) VALUES
				('John', 30)
			`);

			const mutation: SerializedMutation = {
				type: 'cell-update',
				id: '1',
				tabId: 'abc',
				column: {
					name: 'age', type: 'INTEGER',
					isPlainTextType: true,
					isNumeric: true,
					isNullable: true,
					isEditable: false,
					isPrimaryKey: false
				},
				newValue: 31,
				primaryKey: 1,
				primaryKeyColumn: 'id',
				table: 'users'
			};

			await engine.commitChange(mutation, await engine.transaction());

			const rows = await engine.getRows('users', await engine.getColumns('users'), 1, 0);
			assert.strictEqual(rows?.rows[0].age, 31);
		});

		it('should return table creation SQL', async () => {
			await engine?.raw(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			const creationSql = (await engine.getTableCreationSql('users'))
				// make single line by removing newlines and tabs, and turn all spaces into single spaces
				.replace(/\n|\t/g, '')
				.replace(/\s+/g, ' ')
				.trim();

			assert.strictEqual(creationSql, 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
		});

		it('should return rows with where clause', async () => {
			await engine?.raw(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			await engine?.raw(`
            INSERT INTO users (name, age) VALUES
            ('Jane', 25),
            ('John', 30),
            ('Bob', 40),
            ('Alice', 30)
        `);

			const columns = await engine.getColumns('users')

			// Test filtering by age
			const whereClause = { age: 30 };
			const rows = await engine.getRows('users', columns, 10, 0, whereClause);

			assert.strictEqual(rows?.rows.length, 2);
			assert.deepStrictEqual(rows?.rows.map(r => r.name).sort(), ['Alice', 'John']);

			// Test filtering by name
			const nameWhereClause = { name: 'Bob' };
			const bobRows = await engine.getRows('users', columns, 10, 0, nameWhereClause);

			assert.strictEqual(bobRows?.rows.length, 1);
			assert.strictEqual(bobRows?.rows[0].age, 40);
		});

		it('should filter varchar(n), char(n), enum-like and date columns', async () => {
			await engine?.raw(`
            CREATE TABLE products (
                id INTEGER PRIMARY KEY,
                title varchar(255),
                sku char(36),
                status TEXT CHECK (status IN ('active', 'banned')),
                released date
            )
        `);
			await engine?.raw(`
            INSERT INTO products (title, sku, status, released) VALUES
            ('Blue shirt', '11111111-aaaa', 'active', '2024-01-15'),
            ('Red hat', '22222222-bbbb', 'banned', '2023-06-01')
        `);

			const columns = await engine.getColumns('products');

			for (const [filter, expectedTitle] of [
				[{ title: 'shirt' }, 'Blue shirt'],
				[{ sku: '2222' }, 'Red hat'],
				[{ status: 'bann' }, 'Red hat'],
				[{ released: '2024-01' }, 'Blue shirt'],
			] as const) {
				const rows = await engine.getRows('products', columns, 10, 0, filter);
				assert.deepStrictEqual(rows?.rows.map(row => row.title), [expectedTitle], JSON.stringify(filter));
				assert.strictEqual(await engine.getTotalRows('products', columns, filter), 1, JSON.stringify(filter));
			}
		});

		it('should enforce read-only raw queries', async () => {
			await engine?.raw(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)`);
			await engine?.raw(`INSERT INTO users (name) VALUES ('John')`);

			const rows = await engine.rawQuery('SELECT name FROM users;', { readOnly: true });
			assert.deepStrictEqual(rows.map((row: any) => row.name), ['John']);
			assert.ok(Array.isArray(await engine.rawQuery('PRAGMA table_info(users)', { readOnly: true })));

			for (const bypass of [
				'/**/DROP TABLE users',
				'-- c\nDELETE FROM users',
				'SELECT 1; DELETE FROM users',
				'WITH d AS (SELECT 1) DELETE FROM users',
				'PRAGMA query_only = OFF',
				'PRAGMA query_only(0)',
				'PRAGMA user_version = 5',
				"ATTACH DATABASE '/tmp/devdb-x.db' AS x",
			]) {
				await assert.rejects(engine.rawQuery(bypass, { readOnly: true }), JSON.stringify(bypass));
			}

			// query_only is switched back off afterwards
			await engine?.raw(`INSERT INTO users (name) VALUES ('Jane')`);
			const [{ total }] = await engine.rawQuery('SELECT COUNT(*) AS total FROM users');
			assert.strictEqual(total, 2);
		});

		it('should return version information', async () => {
			const version = await engine.getVersion();
			assert.strictEqual(Number(version.split('.').join('')) >= 10, true);
		});

		after(async function () {
			engine?.destroy();
		});
	});
});
