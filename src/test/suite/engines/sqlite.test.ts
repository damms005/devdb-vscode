import * as assert from 'assert';
import { Sequelize } from 'sequelize';
import { SqliteEngine } from '../../../database-engines/sqlite-engine';

describe('Sqlite Tests', () => {
	it('sqlite: should return correct foreign key definitions', async () => {
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

		beforeEach(async () => {
			sqlite = new SqliteEngine();
			const ok = await sqlite.isOkay();
			assert.strictEqual(ok, true);
		});

		afterEach(async () => {
			const tables = await sqlite.getTables();
			for (const table of tables) {
				await sqlite.sequelize?.query(`DROP TABLE ${table}`);
			}
			await sqlite.disconnect();
		});

		it('should return correct table names', async () => {
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

		it('should return correct column definitions', async () => {
			await sqlite.sequelize?.query(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY NOT NULL,
                name TEXT,
                age INTEGER
            )
        `);

			const columns = await sqlite.getColumns('users');
			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'INTEGER', isPrimaryKey: true, isOptional: false, foreignKey: undefined },
				{ name: 'name', type: 'TEXT', isPrimaryKey: false, isOptional: true, foreignKey: undefined },
				{ name: 'age', type: 'INTEGER', isPrimaryKey: false, isOptional: true, foreignKey: undefined }
			]);
		});

		it('should return correct total rows', async () => {
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

		it('should return correct rows', async () => {
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

		it('should return correct table creation SQL', async () => {
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