import * as assert from 'assert';
import knexlib from "knex";
import { SqlService } from '../../../services/sql';
import { Column } from '../../../types';
import { SqliteEngine } from '../../../database-engines/sqlite-engine';

describe('SqliteService Tests', () => {
	let connection: knexlib.Knex;
	let sqlite: SqliteEngine;

	beforeEach(async () => {
		connection = (new SqliteEngine()).getConnection()!;

		sqlite = new SqliteEngine();
	});

	afterEach(async () => {
		await connection.destroy();
	});

	it('ensures buildWhereClause returns empty arrays when whereClause is undefined', () => {
		const where = SqlService.buildWhereClause(sqlite, 'better-sqlite3', []);
		assert.deepStrictEqual(where, []);
	});

	it('ensures buildWhereClause returns expected arrays when whereClause is defined', () => {
		const whereClause = { name: 'John', age: 30 };

		const columns: Column[] = [{
			name: 'name',
			type: 'text',
			isPrimaryKey: false,
			isNullable: true,
		}, {
			name: 'age',
			type: 'integer',
			isPrimaryKey: false,
			isNullable: true,
		}]

		const whereEntry = SqlService.buildWhereClause(sqlite, 'better-sqlite3', columns, whereClause);
		assert.deepStrictEqual(whereEntry, [
			{ column: "name", operator: "LIKE", useRawCast: false, value: "%John%" },
			{ column: "age", operator: "=", useRawCast: false, value: 30 },
		]);
	});

	it('ensures getRows returns expected rows and sql when connection is not null', async () => {
		await connection.raw(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT,
				age INTEGER
			)
		`);

		await connection.raw(`
			INSERT INTO users (name, age) VALUES
			('John', 30),
			('Jane', 25),
			('Bob', 40)
		`);

		const whereClause = { name: 'J' };

		const columns: Column[] = [{
			name: 'name',
			type: 'text',
			isPrimaryKey: false,
			isNullable: true,
		}, {
			name: 'age',
			type: 'integer',
			isPrimaryKey: false,
			isNullable: true,
		}]

		const result = await SqlService.getRows(sqlite, 'better-sqlite3', connection, 'users', columns, 2, 0, whereClause);

		assert.deepStrictEqual(result?.rows, [
			{ id: 1, name: 'John', age: 30 },
			{ id: 2, name: 'Jane', age: 25 }
		]);

		assert.strictEqual(result?.sql?.trim(), "select * from `users` where `name` like '%J%' limit 2");
	});

	it('ensures initializePaginationFor returns null when connection is null', async () => {
		const result = await SqlService.getTotalRows(sqlite, 'better-sqlite3', null, 'users', []);
		assert.strictEqual(result, undefined);
	});

	it('ensures initializePaginationFor returns expected pagination data when connection is not null', async () => {
		await connection.raw(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT,
				age INTEGER
			)
		`);

		await connection.raw(`
			INSERT INTO users (name, age) VALUES
			('John', 30),
			('Jane', 25),
			('Bob', 40)
		`);

		const result = await SqlService.getTotalRows(sqlite, 'better-sqlite3', connection, 'users', [],);

		assert.equal(result, 3);
	});
});