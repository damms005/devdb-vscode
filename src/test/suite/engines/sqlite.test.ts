import * as assert from 'assert';
import { SqliteEngine } from '../../../database-engines/sqlite-engine';
import { SerializedMutation } from '../../../types';

describe('Sqlite Tests', () => {
	it('should return foreign key definitions', async () => {
		let connection = (new SqliteEngine()).getConnection()!;

		// Create two tables with a foreign key relationship for testing
		await connection.raw(`
        CREATE TABLE ParentTable (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    `);

		await connection.raw(`
        CREATE TABLE ChildTable (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parentId INTEGER,
            FOREIGN KEY(parentId) REFERENCES ParentTable(id)
        )
    `);

		const sqlite = new SqliteEngine();
		sqlite.connection = connection;
		const columns = await sqlite.getColumns('ChildTable');

		const foreignKeyColumn = columns.find((column: { name: string }) => column.name === 'parentId');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'ParentTable');
	});

	describe('SqliteEngine Tests', () => {
		let engine: SqliteEngine;

		before(async function () {
			engine = new SqliteEngine();
		});

		beforeEach(async () => {
			await engine.connection?.raw(`DROP TABLE IF EXISTS products`);
		});

		afterEach(async () => {
			const tables = await engine.getTables();
			for (const table of tables) {
				await engine.connection?.raw(`DROP TABLE ${table}`);
			}
		});

		it('should return table names', async () => {
			await engine.connection?.raw(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			await engine.connection?.raw(`
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
			await engine.connection?.raw(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY NOT NULL,
                name TEXT,
                age INTEGER
            )
        `);

			const columns = await engine.getColumns('users');
			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'INTEGER', isPrimaryKey: true, isNumeric: true, isNullable: false, foreignKey: undefined },
				{ name: 'name', type: 'TEXT', isPrimaryKey: false, isNumeric: false, isNullable: true, foreignKey: undefined },
				{ name: 'age', type: 'INTEGER', isPrimaryKey: false, isNumeric: true, isNullable: true, foreignKey: undefined }
			]);
		});

		it('should return total rows', async () => {
			await engine.connection?.raw(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			await engine.connection?.raw(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const totalRows = await engine.getTotalRows('users', []);
			assert.strictEqual(totalRows, 3);
		});

		it('should return rows', async () => {
			await engine.connection?.raw(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			await engine.connection?.raw(`
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
			await engine.connection?.raw(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT,
					age INTEGER
				)
			`);

			await engine.connection?.raw(`
				INSERT INTO users (name, age) VALUES
				('John', 30)
			`);

			const mutation: SerializedMutation = {
				type: 'cell-update',
				id: '1',
				tabId: 'abc',
				column: { name: 'age', type: 'INTEGER', isPrimaryKey: false },
				newValue: 31,
				primaryKey: 1,
				primaryKeyColumn: 'id',
				table: 'users'
			};

			await engine.commitChange(mutation);

			const rows = await engine.getRows('users', await engine.getColumns('users'), 1, 0);
			assert.strictEqual(rows?.rows[0].age, 31);
		});

		it('should return table creation SQL', async () => {
			await engine.connection?.raw(`
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
			await engine.connection?.raw(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			await engine.connection?.raw(`
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

		it('should return version information', async () => {
			const version = await engine.getVersion();
			assert.strictEqual(version, undefined);
		});
	});
});
