import * as assert from 'assert';
import knexlib from "knex";
import { MSSQLServerContainer, StartedMSSQLServerContainer } from '@testcontainers/mssqlserver';
import { MssqlEngine } from '../../../database-engines/mssql-engine';
import { SerializedMutation } from '../../../types';

/**
 * We use a predefined image like this because docker image download can be ery very slow, hence
 * on new computer/initial setup when the image is not already existing, it takes a very long time
 * to run this test. Using a predefined image name like this makes it possible to us to manually
 * download the image (e.g. using `docker run ...`) to ensure it exists in the system before running the test.
 */
const dockerImage = 'mcr.microsoft.com/mssql/server:2022-CU13-ubuntu-22.04'

describe('MSSQL Tests', () => {
	let container: StartedMSSQLServerContainer;

	before(async function () {
		container = await new MSSQLServerContainer(dockerImage)
			.withName('devdb-test-container-mssql')
			.acceptLicense()
			.withPassword('yourStrong(!)Password')
			.withReuse()
			.start();
	})

	it('should return foreign key definitions', async () => {
		const connection = knexlib.knex({
			client: 'mssql',
			connection: {
				host: container.getHost(),
				port: container.getMappedPort(1433),
				database: 'master',
				user: 'sa',
				password: 'yourStrong(!)Password',
			}
		});

		await connection?.raw(`DROP TABLE IF EXISTS ChildTable`);
		await connection?.raw(`DROP TABLE IF EXISTS ParentTable`);

		await connection.raw(`
        CREATE TABLE ParentTable (
            id INT PRIMARY KEY IDENTITY(1,1)
        )
    `);

		await connection.raw(`
        CREATE TABLE ChildTable (
            id INT PRIMARY KEY IDENTITY(1,1),
            parentId INT,
            FOREIGN KEY (parentId) REFERENCES ParentTable(id)
        )
    `);

		const mssql = new MssqlEngine(connection);
		const columns = await mssql.getColumns('ChildTable');

		const foreignKeyColumn = columns.find(column => column.name === 'parentId');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'ParentTable');

		await mssql.connection?.raw(`DROP TABLE IF EXISTS ChildTable`);
		await mssql.connection?.raw(`DROP TABLE IF EXISTS ParentTable`);
		await connection.destroy();
	})

	describe('MssqlEngine Tests', () => {
		let engine: MssqlEngine;

		before(async function () {
			const connection = knexlib.knex({
				client: 'mssql',
				connection: {
					host: container.getHost(),
					port: container.getMappedPort(1433),
					database: 'master',
					user: 'sa',
					password: 'yourStrong(!)Password',
				}
			});

			engine = new MssqlEngine(connection);
			const ok = await engine.isOkay();
			assert.strictEqual(ok, true);
		})

		beforeEach(async function () {
			await engine.connection?.raw(`DROP TABLE IF EXISTS products`);
			await engine.connection?.raw(`DROP TABLE IF EXISTS users`);
			await engine.connection?.raw(`
				CREATE TABLE users (
						id INT PRIMARY KEY IDENTITY(1,1),
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
		})
			;

		it('should return column definitions', async () => {
			const columns = await engine.getColumns('users');
			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'int', isPrimaryKey: true, isNumeric: true, isNullable: false, foreignKey: undefined, isEditable: true, isPlainTextType: false, },
				{ name: 'name', type: 'varchar', isPrimaryKey: false, isNumeric: false, isNullable: true, foreignKey: undefined, isEditable: true, isPlainTextType: true, },
				{ name: 'age', type: 'int', isPrimaryKey: false, isNumeric: true, isNullable: true, foreignKey: undefined, isEditable: true, isPlainTextType: false, }
			]);
		})
			;

		it('should return total rows', async () => {
			await engine.connection?.raw(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const totalRows = await engine.getTotalRows('users', []);
			assert.strictEqual(totalRows, 3);
		})
			;

		it('should return rows', async () => {
			await engine.connection?.raw(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const rows = await engine.getRows('users', [], 2, 0);
			assert.deepStrictEqual(rows?.rows, [
				{ id: 1, name: 'John', age: 30 },
				{ id: 2, name: 'Jane', age: 25 }
			]);
		})
			;

		it('should save changes', async () => {
			await engine.connection?.raw(`
				INSERT INTO users (name, age) VALUES
				('John', 30)
			`);

			const mutation: SerializedMutation = {
				type: 'cell-update',
				id: '1',
				tabId: 'abc',
				column: {
					name: 'age', type: 'int',
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

			await engine.commitChange(mutation, await engine.connection?.transaction()!);

			const rows = await engine.getRows('users', [], 1, 0);
			assert.strictEqual(rows?.rows[0].age, 31);
		});

		it('should return table creation SQL', async () => {
			const creationSql = (await engine.getTableCreationSql('users'))
				.replace(/\[|\]/g, '')
				.replace(/\n|\t/g, '')
				.replace(/\s+/g, ' ')
				.trim();

			assert.strictEqual(creationSql, '{ "TABLE_QUALIFIER": "master", "TABLE_OWNER": "dbo", "TABLE_NAME": "users", "COLUMN_NAME": "id", "DATA_TYPE": 4, "TYPE_NAME": "int identity", "PRECISION": 10, "LENGTH": 4, "SCALE": 0, "RADIX": 10, "NULLABLE": 0, "REMARKS": null, "COLUMN_DEF": null, "SQL_DATA_TYPE": 4, "SQL_DATETIME_SUB": null, "CHAR_OCTET_LENGTH": null, "ORDINAL_POSITION": 1, "IS_NULLABLE": "NO", "SS_DATA_TYPE": 56 }, { "TABLE_QUALIFIER": "master", "TABLE_OWNER": "dbo", "TABLE_NAME": "users", "COLUMN_NAME": "name", "DATA_TYPE": 12, "TYPE_NAME": "varchar", "PRECISION": 255, "LENGTH": 255, "SCALE": null, "RADIX": null, "NULLABLE": 1, "REMARKS": null, "COLUMN_DEF": null, "SQL_DATA_TYPE": 12, "SQL_DATETIME_SUB": null, "CHAR_OCTET_LENGTH": 255, "ORDINAL_POSITION": 2, "IS_NULLABLE": "YES", "SS_DATA_TYPE": 39 }, { "TABLE_QUALIFIER": "master", "TABLE_OWNER": "dbo", "TABLE_NAME": "users", "COLUMN_NAME": "age", "DATA_TYPE": 4, "TYPE_NAME": "int", "PRECISION": 10, "LENGTH": 4, "SCALE": 0, "RADIX": 10, "NULLABLE": 1, "REMARKS": null, "COLUMN_DEF": null, "SQL_DATA_TYPE": 4, "SQL_DATETIME_SUB": null, "CHAR_OCTET_LENGTH": null, "ORDINAL_POSITION": 3, "IS_NULLABLE": "YES", "SS_DATA_TYPE": 38 }');
		});

		it('should return rows with a where clause', async () => {
			await engine.connection?.raw(`
				INSERT INTO users (name, age) VALUES
				('John', 30),
				('Jane', 25),
				('Bob', 40),
				('Alice', 30)
			`);

			const whereClause = { age: 30, name: 'John' }

			const rows = await engine.getRows('users', [], 10, 0, whereClause);

			assert.strictEqual(rows?.rows.length, 1);
			assert.deepStrictEqual(rows?.rows[0], { id: 1, name: 'John', age: 30 });
		});

		it('should return version information', async () => {
			const version = await engine.getVersion();
			assert.strictEqual(version, undefined);
		});

		after(async function () {
			await engine.connection?.destroy();
		});
	})
});
