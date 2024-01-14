import * as assert from 'assert';
import { Sequelize } from 'sequelize';
import { SqlService } from '../../../services/sql';
import { SqliteEngine } from '../../../database-engines/sqlite-engine';
import { MysqlEngine } from '../../../database-engines/mysql-engine';

describe('SqliteService Tests', () => {
	let sequelize: Sequelize;

	beforeEach(async () => {
		sequelize = new Sequelize('sqlite::memory:', { logging: false });
		await sequelize.authenticate();
	});

	afterEach(async () => {
		await sequelize.close();
	});

	it('ensures buildWhereClause returns empty arrays when whereClause is undefined', () => {
		const { where, replacements } = SqlService.buildWhereClause(undefined);
		assert.deepStrictEqual(where, []);
		assert.deepStrictEqual(replacements, []);
	});

	it('ensures buildWhereClause returns correct arrays when whereClause is defined', () => {
		const whereClause = { name: 'John', age: 30 };
		const { where, replacements } = SqlService.buildWhereClause(whereClause);
		assert.deepStrictEqual(where, ['name LIKE ?', 'age LIKE ?']);
		assert.deepStrictEqual(replacements, ['%John%', '%30%']);
	});

	it('ensures getRows returns correct rows and sql when sequelize is not null', async () => {
		await sequelize.query(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT,
				age INTEGER
			)
		`);

		await sequelize.query(`
			INSERT INTO users (name, age) VALUES
			('John', 30),
			('Jane', 25),
			('Bob', 40)
		`);

		const whereClause = { name: 'J' };
		const result = await SqlService.getRows('sqlite', sequelize, 'users', 2, 0, whereClause);

		assert.deepStrictEqual(result?.rows, [
			{ id: 1, name: 'John', age: 30 },
			{ id: 2, name: 'Jane', age: 25 }
		]);

		assert.strictEqual(result?.sql, "Executing (default): SELECT * FROM `users` WHERE name LIKE '%J%' LIMIT 2");
	});

	it('ensures initializePaginationFor returns null when sequelize is null', async () => {
		const result = await SqlService.getTotalRows('sqlite', null, 'users');
		assert.strictEqual(result, undefined);
	});

	it('ensures initializePaginationFor returns correct pagination data when sequelize is not null', async () => {
		await sequelize.query(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT,
				age INTEGER
			)
		`);

		await sequelize.query(`
			INSERT INTO users (name, age) VALUES
			('John', 30),
			('Jane', 25),
			('Bob', 40)
		`);

		const result = await SqlService.getTotalRows('sqlite', sequelize, 'users');

		assert.equal(result, 3);
	});

	it('sqlite: should return correct foreign key definitions', async () => {
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

		const sqlite = new SqliteEngine('sqlite::memory:');
		sqlite.sequelize = sequelize;
		const columns = await sqlite.getColumns('ChildTable');

		const foreignKeyColumn = columns.find(column => column.name === 'parentId');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'ParentTable');
	});

	it.skip('mysql: should return correct foreign key definitions', async () => {
		sequelize = new Sequelize('mysql://user:password@localhost', {
			dialect: 'mysql',
			dialectModule: require('mysql2'),
			storage: ':memory:', // This is typically for SQLite, but we use it here to signify an in-memory approach
		});

		await sequelize.query(`
        CREATE TABLE ParentTable (
            id INT PRIMARY KEY AUTO_INCREMENT
        )
    `);

		await sequelize.query(`
        CREATE TABLE ChildTable (
            id INT PRIMARY KEY AUTO_INCREMENT,
            parentId INT,
            FOREIGN KEY (parentId) REFERENCES ParentTable(id)
        )
    `);

		const mysql = new MysqlEngine(sequelize);
		const columns = await mysql.getColumns('ChildTable');

		const foreignKeyColumn = columns.find(column => column.name === 'parentId');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'ParentTable');
	});
});