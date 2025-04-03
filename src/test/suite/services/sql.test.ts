import * as assert from 'assert';
import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';
import knexlib from "knex";
import { SqlService } from '../../../services/sql';
import { Column } from '../../../types';
import { MysqlEngine } from '../../../database-engines/mysql-engine';

/**
 * We use a predefined image like this because docker image download can be ery very slow, hence
 * on new computer/initial setup when the image is not already existing, it takes a very long time
 * to run this test. Using a predefined image name like this makes it possible to us to manually
 * download the image (e.g. using `docker run ...`) to ensure it exists in the system before running the test.
 */
const dockerImage = 'mysql:8.0.31'

describe('SqliteService Tests', () => {
	let container: StartedMySqlContainer;
	let connection: knexlib.Knex;
	let engine: MysqlEngine;

	before(async function () {
		container = await new MySqlContainer(dockerImage)
			.withReuse()
			.start();
	})

	beforeEach(async () => {
		connection = knexlib.knex({
			client: 'mysql2',
			connection: {
				host: container.getHost(),
				port: container.getPort(),
				user: container.getUsername(),
				password: container.getUserPassword(),
				database: container.getDatabase(),
			},
		});

		engine = new MysqlEngine(connection);

		await engine.getConnection()?.raw(`DROP TABLE IF EXISTS users`);
	});

	afterEach(async () => {
		await connection.destroy();
	});

	it('ensures buildWhereClause returns empty arrays when whereClause is undefined', () => {
		const where = SqlService.buildWhereClause(engine, 'mysql2', []);
		assert.deepStrictEqual(where, []);
	});

	it('ensures buildWhereClause returns expected arrays when whereClause is defined', () => {
		const whereClause = { name: 'John', age: 30 };

		const columns: Column[] = [{
			name: 'name',
			type: 'text',
			isPrimaryKey: false,
			isNullable: true,
			isEditable: false,
			isPlainTextType: true,
		}, {
			name: 'age',
			type: 'integer',
			isPrimaryKey: false,
			isPlainTextType: true,
			isEditable: false,
			isNullable: true,
		}]

		const whereEntry = SqlService.buildWhereClause(engine, 'mysql2', columns, whereClause);
		assert.deepStrictEqual(whereEntry, [
			{ column: "name", operator: "LIKE", useRawCast: false, value: "%John%" },
			{ column: "age", operator: "=", useRawCast: false, value: 30 },
		]);
	});

	it('ensures getRows returns expected rows and sql when connection is not null', async () => {
		await connection.raw(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY AUTO_INCREMENT,
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
			isEditable: false,
			isPlainTextType: true,
		}, {
			name: 'age',
			type: 'integer',
			isPrimaryKey: false,
			isPlainTextType: true,
			isEditable: false,
			isNullable: true,
		}]

		const result = await SqlService.getRows(engine, 'mysql2', connection, 'users', columns, 2, 0, whereClause);

		assert.deepStrictEqual(result?.rows, [
			{ id: 1, name: 'John', age: 30 },
			{ id: 2, name: 'Jane', age: 25 }
		]);

		assert.strictEqual(result?.sql?.trim(), "select * from `users` where `name` like '%J%' limit 2");
	});

	it('ensures initializePaginationFor returns nought when connection is null', async () => {
		const result = await SqlService.getTotalRows(engine, 'mysql2', null, 'users', []);
		assert.strictEqual(result, 0);
	});

	it('ensures initializePaginationFor returns expected pagination data when connection is not null', async () => {
		await connection.raw(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY AUTO_INCREMENT,
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

		const result = await SqlService.getTotalRows(engine, 'mysql2', connection, 'users', [],);

		assert.equal(result, 3);
	});
});