import * as assert from 'assert';
import { Sequelize } from 'sequelize';
import { PostgresEngine } from '../../../database-engines/postgres-engine';
import { StartedPostgreSqlContainer, PostgreSqlContainer } from '@testcontainers/postgresql';

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
		container = await new PostgreSqlContainer(dockerImage).start();
	})

	it('should return foreign key definitions', async () => {
		let sequelize: Sequelize = new Sequelize(container.getDatabase(), container.getUsername(), container.getPassword(), {
			dialect: 'postgres',
			port: container.getPort(),
			host: container.getHost(),
			logging: false
		});

		await sequelize.query(`
        CREATE TABLE ParentTable (
            id SERIAL PRIMARY KEY
        )
    `);

		await sequelize.query(`
        CREATE TABLE ChildTable (
            id SERIAL PRIMARY KEY,
            parentId INT,
            FOREIGN KEY (parentId) REFERENCES ParentTable(id)
        )
    `);

		const postgres = new PostgresEngine(sequelize);
		const columns = await postgres.getColumns('ChildTable');

		const foreignKeyColumn = columns.find(column => column.name === 'parentid');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'parenttable');

		await postgres.sequelize?.query(`DROP TABLE ChildTable`);
		await postgres.sequelize?.query(`DROP TABLE ParentTable`);
	})

	describe('PostgresEngine Tests', () => {
		let postgres: PostgresEngine;

		before(async function(){
			let sequelize: Sequelize = new Sequelize(container.getDatabase(), container.getUsername(), container.getPassword(), {
				dialect: 'postgres',
				port: container.getPort(),
				host: container.getHost(),
				logging: false
			});
			await sequelize.authenticate();

			postgres = new PostgresEngine(sequelize);
			const ok = await postgres.isOkay();
			assert.strictEqual(ok, true);
		})

		beforeEach(async function () {
			await postgres.sequelize?.query(`
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                name varchar(255),
                age INT
            )
        `);
		});

		afterEach(async function () {
			await postgres.sequelize?.query(`DROP TABLE users;`);
		})

		it('should return table names', async () => {
			await postgres.sequelize?.query(`
            CREATE TABLE products (
                id SERIAL PRIMARY KEY,
                name varchar(255),
                price INT
            )
        `);

			const tables = await postgres.getTables();
			assert.deepStrictEqual(tables.sort(), ['products', 'users']);
		});

		it('should return column definitions', async () => {
			const columns = await postgres.getColumns('users');

			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'integer', isPrimaryKey: false, isNumeric: true, isNullable: false, foreignKey: undefined },
				{ name: 'name', type: 'character varying', isPrimaryKey: false, isNumeric: false, isNullable: false, foreignKey: undefined },
				{ name: 'age', type: 'integer', isPrimaryKey: false, isNumeric: true, isNullable: false, foreignKey: undefined }
			]);
		});

		it('should return total rows', async () => {
			await postgres.sequelize?.query(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const totalRows = await postgres.getTotalRows('users', []);
			assert.strictEqual(totalRows, 3);
		});

		it('should return rows', async () => {
			await postgres.sequelize?.query(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const rows = await postgres.getRows('users', [], 2, 0);
			assert.deepStrictEqual(rows?.rows, [
				{ id: 1, name: 'John', age: 30 },
				{ id: 2, name: 'Jane', age: 25 }
			]);
		});

		it('should save changes', async () => {
			await postgres.sequelize?.query(`
				INSERT INTO users (name, age) VALUES
				('John', 30)
			`);

			const mutation = {
				row: { id: 1, name: 'John', age: 30 },
				rowIndex: 0,
				column: { name: 'age', type: 'integer', isPrimaryKey: false },
				originalValue: 30,
				newValue: 31,
				primaryKey: 1,
				primaryKeyColumn: { name: 'id', type: 'integer', isPrimaryKey: true },
				table: 'users'
			};

			await postgres.commitChange(mutation);

			const rows = await postgres.getRows('users', [], 1, 0);
			assert.strictEqual(rows?.rows[0].age, 31);
		});

		it('should return table creation SQL', async () => {
			const creationSql = (await postgres.getTableCreationSql('users'))
				.replace(/"/g, '')
				.replace(/\n|\t/g, '')
				.replace(/\s+/g, ' ')
				.trim();

			assert.strictEqual(creationSql, 'CREATE TABLE users (id integer, name character varying(255), age integer);');
		});

		it('should filter values in uuid and integer column types', async () => {
			await postgres.sequelize?.query(`
					CREATE TABLE test_table (
						id SERIAL PRIMARY KEY,
						uuid_col UUID,
						int_col INT
					)
				`);

			const uuid1 = '33e09dc0-838e-4584-bc22-8de273c4f1c9';
			const uuid2 = '3314dc82-2989-4133-8108-ee9b0ba475b9';

			await postgres.sequelize?.query(`
		INSERT INTO test_table (uuid_col, int_col) VALUES
		('${uuid1}', 100),
		('${uuid2}', 200)
	`);

			const integerFilteredRows = await postgres.getRows('test_table', [
				{ name: 'uuid_col', type: 'uuid', isPrimaryKey: false, isNullable: true },
				{ name: 'int_col', type: 'int4', isPrimaryKey: false, isNullable: true }
			], 10, 0, { int_col: 20 });

			assert.strictEqual(integerFilteredRows?.rows.length, 1);
			assert.strictEqual(integerFilteredRows?.rows[0].int_col, 200);
		});

		it('should filter values in timestamp column types', async () => {
			await postgres.sequelize?.query(`
				CREATE TABLE timestamp_test (
					id SERIAL PRIMARY KEY,
					created_at TIMESTAMP
				)
			`);

			await postgres.sequelize?.query(`
				INSERT INTO timestamp_test (created_at) VALUES
				('2024-10-14 10:00:00'),
				('2024-10-14 12:00:00')
			`);

			const timestampFilteredRows = await postgres.getRows('timestamp_test', [
				{ name: 'created_at', type: 'timestamp', isPrimaryKey: false, isNullable: true }
			], 10, 0, { created_at: '2024-10-14 10:00:00' });

			assert.strictEqual(timestampFilteredRows?.rows.length, 1);
			assert.strictEqual(timestampFilteredRows?.rows[0].created_at.toISOString(), new Date('2024-10-14 10:00:00').toISOString());
		});
	})
});
