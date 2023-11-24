import * as assert from 'assert';
import { Sequelize } from 'sequelize';
import { SqliteService } from '../../../services/sql';

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
		const { where, replacements } = SqliteService.buildWhereClause(undefined);
		assert.deepStrictEqual(where, []);
		assert.deepStrictEqual(replacements, []);
	});

	it('ensures buildWhereClause returns correct arrays when whereClause is defined', () => {
		const whereClause = { name: 'John', age: 30 };
		const { where, replacements } = SqliteService.buildWhereClause(whereClause);
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
		const result = await SqliteService.getRows(sequelize, 'users', 2, 0, whereClause);

		assert.deepStrictEqual(result?.rows, [
			{ id: 1, name: 'John', age: 30 },
			{ id: 2, name: 'Jane', age: 25 }
		]);

		assert.strictEqual(result?.sql, "Executing (default): SELECT * FROM `users` WHERE name LIKE '%J%' LIMIT 0, 2");
	});

	it('ensures initializePaginationFor returns null when sequelize is null', async () => {
		const result = await SqliteService.getTotalRows(null, 'users');
		assert.strictEqual(result, null);
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

		const result = await SqliteService.getTotalRows(sequelize, 'users');

		assert.deepStrictEqual(result, {
			table: 'users',
			firstRowOnPage: 0,
			lastRowOnPage: 0,
			totalRows: 3,
			endPage: 1,
			itemsPerPage: 10,
			displayText: `Showing 0 to 0 of 0 records`
		});
	});
});