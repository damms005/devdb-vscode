import * as assert from 'assert';
import knexlib from "knex";
import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';
import { MysqlEngine } from '../../../database-engines/mysql-engine';
import { SerializedMutation } from '../../../types';

/**
 * We use a predefined image like this because docker image download can be ery very slow, hence
 * on new computer/initial setup when the image is not already existing, it takes a very long time
 * to run this test. Using a predefined image name like this makes it possible to us to manually
 * download the image (e.g. using `docker run ...`) to ensure it exists in the system before running the test.
 */
const dockerImage = 'mysql:8.0.31'

/**
 * Skipping because of https://github.com/testcontainers/testcontainers-node/issues/868
 */
describe('MySQL Tests', () => {
	let container: StartedMySqlContainer;

	before(async function () {
		container = await new MySqlContainer(dockerImage)
			.withReuse()
			.start();
	})

	it('should return foreign key definitions', async () => {
		let connection = knexlib.knex({
			client: 'mysql2',
			connection: {
				host: container.getHost(),
				port: container.getPort(),
				user: container.getUsername(),
				password: container.getUserPassword(),
				database: container.getDatabase(),
			},
		});

		await connection.raw(`
        CREATE TABLE ParentTable (
            id INT PRIMARY KEY AUTO_INCREMENT
        )
    `);

		await connection.raw(`
        CREATE TABLE ChildTable (
            id INT PRIMARY KEY AUTO_INCREMENT,
            parentId INT,
            FOREIGN KEY (parentId) REFERENCES ParentTable(id)
        )
    `);

		const mysql = new MysqlEngine(connection);
		const columns = await mysql.getColumns('ChildTable');

		const foreignKeyColumn = columns.find(column => column.name === 'parentId');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'ParentTable');

		await mysql.connection?.raw(`DROP TABLE ChildTable`);
		await mysql.connection?.raw(`DROP TABLE ParentTable`);
	})

	describe('MysqlEngine Tests', () => {
		let engine: MysqlEngine;

		beforeEach(async function () {
			let connection = knexlib.knex({
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
			const ok = await engine.isOkay();
			assert.strictEqual(ok, true);

			await engine.connection?.raw(`DROP TABLE IF EXISTS products`);

			await engine.connection?.raw(`
            CREATE TABLE users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name varchar(255),
                age INT
            )
        `);
		});

		afterEach(async function () {
			await engine.connection?.raw(`DROP TABLE IF EXISTS users`);
			await engine.connection?.raw(`DROP TABLE IF EXISTS products`);
		})

		it('should return table names', async () => {
			await engine.connection?.raw(`
            CREATE TABLE products (
                id INT PRIMARY KEY,
                name varchar(255),
                price INT
            )
        `);

			const tables = await engine.getTables();
			assert.deepStrictEqual(tables, ['products', 'users']);
		});

		it('should return column definitions', async () => {
			const columns = await engine.getColumns('users');
			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'int', isPrimaryKey: true, isNumeric: true, isNullable: false, foreignKey: undefined },
				{ name: 'name', type: 'varchar(255)', isPrimaryKey: false, isNumeric: false, isNullable: true, foreignKey: undefined },
				{ name: 'age', type: 'int', isPrimaryKey: false, isNumeric: true, isNullable: true, foreignKey: undefined }
			]);
		});

		it('should return total rows', async () => {
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
				INSERT INTO users (name, age) VALUES
				('John', 30)
			`);

			const mutation: SerializedMutation = {
				type: 'cell-update',
				id: '1',
				tabId: 'abc',
				column: { name: 'age', type: 'int', isPrimaryKey: false },
				newValue: 31,
				primaryKey: 1,
				primaryKeyColumn: 'id',
				table: 'users'
			};

			await engine.commitChange(mutation);

			const rows = await engine.getRows('users', await engine.getColumns('users'), 1, 0);
			assert.strictEqual(rows?.rows[0].age, 31);
		});

		it('should return rows with where clause', async () => {
			await engine.connection?.raw(`
				INSERT INTO users (name, age) VALUES
				('John', 30),
				('Jane', 25),
				('Bob', 40),
				('Alice', 35)
			`);

			// Test string where clause
			const nameWhereClause = { name: 'Jane' };
			const nameFilteredRows = await engine.getRows('users', await engine.getColumns('users'), 10, 0, nameWhereClause);
			assert.strictEqual(nameFilteredRows?.rows.length, 1);
			assert.strictEqual(nameFilteredRows?.rows[0].name, 'Jane');
			assert.strictEqual(nameFilteredRows?.rows[0].age, 25);
		});

		it('should run arbitrary query and get output', async () => {
			await engine.connection?.raw(`
				INSERT INTO users (name, age) VALUES
				('John', 30),
				('Jane', 25),
				('Bob', 40)
			`);

			const query = "EXPLAIN FORMAT=TREE SELECT * FROM users WHERE age > 25";
			const result = await engine.runArbitraryQueryAndGetOutput(query);

			assert.ok(result[0]['EXPLAIN'].includes('Table scan on users'));
		});

		it('should return version information', async () => {
			const version = await engine.getVersion();

			assert.strictEqual(version, '8.0.31');
		});

		it('should return table creation SQL', async () => {
			const creationSql = (await engine.getTableCreationSql('users'))
				.replace(/`/g, '')
				.replace(/\n|\t/g, '')
				.replace(/\s+/g, ' ')
				.trim();

			assert.strictEqual(creationSql, 'CREATE TABLE users ( id int NOT NULL AUTO_INCREMENT, name varchar(255) DEFAULT NULL, age int DEFAULT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
		});
	})
});
