import * as assert from 'assert';
import knexlib from "knex";
import { StartedPostgreSqlContainer, PostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresEngine } from '../../../database-engines/postgres-engine';
import { SerializedMutation } from '../../../types';

/**
 * We use a predefined image like this because docker image download can be ery very slow, hence
 * on new computer/initial setup when the image is not already existing, it takes a very long time
 * to run this test. Using a predefined image name like this makes it possible to us to manually
 * download the image (e.g. using `docker run ...`) to ensure it exists in the system before running the test.
 */
const dockerImage = 'postgres:13.3-alpine'

describe('PostgreSQL Tests', () => {
	let container: StartedPostgreSqlContainer;

	before(async function () {
		container = await new PostgreSqlContainer(dockerImage)
			.withName('devdb-test-container-postgres')
			.withReuse()
			.start();
	})

	it('should return foreign key definitions', async () => {
		let connection = knexlib.knex({
			client: 'postgres',
			connection: {
				host: container.getHost(),
				port: container.getPort(),
				user: container.getUsername(),
				password: container.getPassword(),
				database: container.getDatabase(),
			},
		})

		await connection?.raw(`DROP TABLE IF EXISTS ChildTable`);
		await connection?.raw(`DROP TABLE IF EXISTS parenttable`);

		await connection.raw(`
        CREATE TABLE ParentTable (
            id SERIAL PRIMARY KEY
        )
    `);

		await connection.raw(`
        CREATE TABLE ChildTable (
            id SERIAL PRIMARY KEY,
            parentId INT,
            FOREIGN KEY (parentId) REFERENCES ParentTable(id)
        )
    `);

		const postgres = new PostgresEngine(connection);
		const columns = await postgres.getColumns('ChildTable');

		const foreignKeyColumn = columns.find((column: { name: string }) => column.name === 'parentid');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'parenttable');

		await postgres.connection?.raw(`DROP TABLE ChildTable`);
		await postgres.connection?.raw(`DROP TABLE ParentTable`);
		await connection.destroy();
	})

	describe('PostgresEngine Tests', () => {
		let engine: PostgresEngine;

		before(async function () {
			let connection = knexlib.knex({
				client: 'postgres',
				connection: {
					host: container.getHost(),
					port: container.getPort(),
					user: container.getUsername(),
					password: container.getPassword(),
					database: container.getDatabase(),
				},
			})

			engine = new PostgresEngine(connection);
			const ok = await engine.isOkay();
			assert.strictEqual(ok, true);
		})

		beforeEach(async function () {
			await engine.connection?.raw(`DROP TABLE IF EXISTS users`);
			await engine.connection?.raw(`DROP TABLE IF EXISTS parenttable`);
			await engine.connection?.raw(`DROP TABLE IF EXISTS products`);
			await engine.connection?.raw(`DROP TABLE IF EXISTS test_table`);
			await engine.connection?.raw(`DROP TABLE IF EXISTS timestamp_test`);

			await engine.connection?.raw(`
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                name varchar(255),
                age INT,
                location varchar(255) NOT NULL DEFAULT 'somewhere'
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
                id SERIAL PRIMARY KEY,
                name varchar(255),
                price INT
            )
        `);

			const tables = await engine.getTables();
			assert.deepStrictEqual(tables.sort(), ['products', 'users']);
		});

		it('should return column definitions', async () => {
			const columns = await engine.getColumns('users');

			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'integer', isPrimaryKey: true, isNumeric: true, isNullable: false, foreignKey: undefined, isEditable: true, isPlainTextType: false },
				{ name: 'name', type: 'character varying', isPrimaryKey: false, isNumeric: false, isNullable: true, foreignKey: undefined, isEditable: true, isPlainTextType: true },
				{ name: 'age', type: 'integer', isPrimaryKey: false, isNumeric: true, isNullable: true, foreignKey: undefined, isEditable: true, isPlainTextType: false },
				{ name: 'location', type: 'character varying', isPrimaryKey: false, isNumeric: false, isNullable: false, foreignKey: undefined, isEditable: true, isPlainTextType: true },
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
			assert.strictEqual(totalRows, '3');
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
				{ id: 1, name: 'John', age: 30, location: 'somewhere' },
				{ id: 2, name: 'Jane', age: 25, location: 'somewhere' }
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
				column: {
					name: 'age', type: 'integer', isPlainTextType: true,
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

			const rows = await engine.getRows('users', await engine.getColumns('users'), 1, 0);
			assert.strictEqual(rows?.rows[0].age, 31);
		});

		it('should return table creation SQL', async () => {
			const creationSql = (await engine.getTableCreationSql('users'))
				.replace(/"/g, '')
				.replace(/\n|\t/g, '')
				.replace(/\s+/g, ' ')
				.trim();

			assert.strictEqual(creationSql, 'CREATE TABLE users ( id integer, name CHARACTER varying (255), age integer, location CHARACTER varying (255) );');
		});

		it('should filter values in uuid and integer column types', async () => {
			await engine.connection?.raw(`
					CREATE TABLE test_table (
						id SERIAL PRIMARY KEY,
						uuid_col UUID,
						int_col INT
					)
				`);

			const uuid1 = '33e09dc0-838e-4584-bc22-8de273c4f1c9';
			const uuid2 = '3314dc82-2989-4133-8108-ee9b0ba475b9';

			await engine.connection?.raw(`
		INSERT INTO test_table (uuid_col, int_col) VALUES
		('${uuid1}', 100),
		('${uuid2}', 200)
	`);

			const columns = await engine.getColumns('test_table')
			const uuidFilteredRows = await engine.getRows('test_table', columns, 10, 0, { uuid_col: '4584' });
			const integerFilteredRows = await engine.getRows('test_table', columns, 10, 0, { int_col: 200 });

			assert.strictEqual(uuidFilteredRows?.rows.length, 1);
			assert.strictEqual(integerFilteredRows?.rows.length, 1);

			assert.strictEqual(uuidFilteredRows?.rows[0].uuid_col, '33e09dc0-838e-4584-bc22-8de273c4f1c9');
			assert.strictEqual(integerFilteredRows?.rows[0].int_col, 200);
		});

		it('should filter values in timestamp column types', async () => {
			await engine.connection?.raw(`
				CREATE TABLE timestamp_test (
					id SERIAL PRIMARY KEY,
					created_at TIMESTAMP
				)
			`);

			await engine.connection?.raw(`
				INSERT INTO timestamp_test (created_at) VALUES
				('2024-10-14 10:00:00'),
				('2024-10-14 12:00:00')
			`);

			const timestampFilteredRows = await engine.getRows('timestamp_test', [
				{
					name: 'created_at', type: 'timestamp',
					isPlainTextType: true,
					isNumeric: true,
					isEditable: false,
					isPrimaryKey: false,
					isNullable: true
				}
			], 10, 0, { created_at: '2024-10-14 10:00:00' });

			assert.strictEqual(timestampFilteredRows?.rows.length, 1);
			assert.strictEqual(timestampFilteredRows?.rows[0].created_at.toISOString(), new Date('2024-10-14 10:00:00').toISOString());
		});

		it('should filter rows with where clause', async () => {
			await engine.connection?.raw(`
				INSERT INTO users (name, age) VALUES
				('John', 30),
				('Jane', 25),
				('Bob', 40)
			`);

			const columns = await engine.getColumns('users')

			// Test numeric filtering
			const ageFilteredRows = await engine.getRows('users', columns, 10, 0, { age: 30 });

			assert.strictEqual(ageFilteredRows?.rows.length, 1);
			assert.strictEqual(ageFilteredRows?.rows[0].name, 'John');
			assert.strictEqual(ageFilteredRows?.rows[0].age, 30);

			// Test string filtering
			const nameFilteredRows = await engine.getRows('users', columns, 10, 0, { name: 'Jane' });
			assert.strictEqual(nameFilteredRows?.rows.length, 1);
			assert.strictEqual(nameFilteredRows?.rows[0].name, 'Jane');
			assert.strictEqual(nameFilteredRows?.rows[0].age, 25);
		});

		it('should return undefined for getVersion', async () => {
			const version = await engine.getVersion();
			assert.strictEqual(version, undefined);
		});

		after(async function () {
			await engine.connection?.destroy();
		});
	})
});
