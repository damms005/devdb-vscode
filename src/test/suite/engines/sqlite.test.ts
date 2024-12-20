import * as assert from 'assert';
import { Sequelize } from 'sequelize';
import { SqliteEngine } from '../../../database-engines/sqlite-engine';

describe('Sqlite Tests', () => {
	it('should return foreign key definitions', async () => {
		let sequelize: Sequelize = new Sequelize({ dialect: 'sqlite', logging: false });
		await sequelize.authenticate();

		// Create two tables with a foreign key relationship for testing
		await sequelize.query(`
        CREATE TABLE ParentTable (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        )
    `);

		await sequelize.query(`
        CREATE TABLE ChildTable (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parentId INTEGER,
            FOREIGN KEY(parentId) REFERENCES ParentTable(id)
        )
    `);

		const sqlite = new SqliteEngine();
		sqlite.sequelize = sequelize;
		const columns = await sqlite.getColumns('ChildTable');

		const foreignKeyColumn = columns.find(column => column.name === 'parentId');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'ParentTable');
	});

	describe('SqliteEngine Tests', () => {
		let sqlite: SqliteEngine;

		before(async function () {
			sqlite = new SqliteEngine();
		});

		beforeEach(async () => {
			const ok = await sqlite.isOkay();
			assert.strictEqual(ok, true);
		});

		afterEach(async () => {
			const tables = await sqlite.getTables();
			for (const table of tables) {
				await sqlite.sequelize?.query(`DROP TABLE ${table}`);
			}
		});

		it('should return table names', async () => {
			await sqlite.sequelize?.query(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			await sqlite.sequelize?.query(`
            CREATE TABLE products (
                id INTEGER PRIMARY KEY,
                name TEXT,
                price INTEGER
            )
        `);

			const tables = await sqlite.getTables();
			assert.deepStrictEqual(tables, ['products', 'users']);
		});

		it('should return column definitions', async () => {
			await sqlite.sequelize?.query(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY NOT NULL,
                name TEXT,
                age INTEGER
            )
        `);

			const columns = await sqlite.getColumns('users');
			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'INTEGER', isPrimaryKey: true, isNumeric: true, isNullable: false, foreignKey: undefined },
				{ name: 'name', type: 'TEXT', isPrimaryKey: false, isNumeric: false, isNullable: true, foreignKey: undefined },
				{ name: 'age', type: 'INTEGER', isPrimaryKey: false, isNumeric: true, isNullable: true, foreignKey: undefined }
			]);
		});

		it('should return total rows', async () => {
			await sqlite.sequelize?.query(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			await sqlite.sequelize?.query(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const totalRows = await sqlite.getTotalRows('users', []);
			assert.strictEqual(totalRows, 3);
		});

		it('should return rows', async () => {
			await sqlite.sequelize?.query(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			await sqlite.sequelize?.query(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const rows = await sqlite.getRows('users', [], 2, 0);
			assert.deepStrictEqual(rows?.rows, [
				{ id: 1, name: 'John', age: 30 },
				{ id: 2, name: 'Jane', age: 25 }
			]);
		});

		it('should save changes', async () => {
			await sqlite.sequelize?.query(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT,
					age INTEGER
				)
			`);

			await sqlite.sequelize?.query(`
				INSERT INTO users (name, age) VALUES
				('John', 30)
			`);

			const mutation = {
				row: { id: 1, name: 'John', age: 30 },
				rowIndex: 0,
				column: { name: 'age', type: 'INTEGER', isPrimaryKey: false },
				originalValue: 30,
				newValue: 31,
				primaryKey: 1,
				primaryKeyColumn: { name: 'id', type: 'INTEGER', isPrimaryKey: true },
				table: 'users'
			};

			await sqlite.commitChange(mutation);

			const rows = await sqlite.getRows('users', [], 1, 0);
			assert.strictEqual(rows?.rows[0].age, 31);
		});

		it('should return table creation SQL', async () => {
			await sqlite.sequelize?.query(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT,
                age INTEGER
            )
        `);

			const creationSql = (await sqlite.getTableCreationSql('users'))
				// make single line by removing newlines and tabs, and turn all spaces into single spaces
				.replace(/\n|\t/g, '')
				.replace(/\s+/g, ' ')
				.trim();

			assert.strictEqual(creationSql, 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
		});
	});
});
