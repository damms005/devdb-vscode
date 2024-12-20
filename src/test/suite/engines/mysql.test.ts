import * as assert from 'assert';
import { Sequelize } from 'sequelize';
import { MysqlEngine } from '../../../database-engines/mysql-engine';
import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';

/**
 * Skipping because of https://github.com/testcontainers/testcontainers-node/issues/868
 */
describe('MySQL Tests', () => {
	let container: StartedMySqlContainer;

	before(async function () {
		container = await new MySqlContainer().start();
	})

	it('should return foreign key definitions', async () => {
		console.log('Creating MySQL engine...');
		let sequelize: Sequelize = new Sequelize(container.getDatabase(), container.getUsername(), container.getUserPassword(), {
			dialect: 'mysql',
			port: container.getPort(),
			host: container.getHost(),
			dialectModule: require('mysql2'),
			logging: false
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

		await mysql.sequelize?.query(`DROP TABLE ChildTable`);
		await mysql.sequelize?.query(`DROP TABLE ParentTable`);
	})

	describe('MysqlEngine Tests', () => {
		let mysql: MysqlEngine;

		beforeEach(async function () {
			let sequelize: Sequelize = new Sequelize(container.getDatabase(), container.getUsername(), container.getUserPassword(), {
				dialect: 'mysql',
				port: container.getPort(),
				host: container.getHost(),
				dialectModule: require('mysql2'),
				logging: false
			});
			await sequelize.authenticate();

			mysql = new MysqlEngine(sequelize);
			const ok = await mysql.isOkay();
			assert.strictEqual(ok, true);

			await mysql.sequelize?.query(`
            CREATE TABLE users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name varchar(255),
                age INT
            )
        `);
		});

		afterEach(async function () {
			await mysql.sequelize?.query(`DROP TABLE users;`);
		})

		it('should return table names', async () => {
			await mysql.sequelize?.query(`
            CREATE TABLE products (
                id INT PRIMARY KEY,
                name varchar(255),
                price INT
            )
        `);

			const tables = await mysql.getTables();
			assert.deepStrictEqual(tables, ['products', 'users']);
		});

		it('should return column definitions', async () => {
			const columns = await mysql.getColumns('users');
			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'int', isPrimaryKey: true, isNumeric: true, isNullable: false, foreignKey: undefined },
				{ name: 'name', type: 'varchar(255)', isPrimaryKey: false, isNumeric: false, isNullable: true, foreignKey: undefined },
				{ name: 'age', type: 'int', isPrimaryKey: false, isNumeric: true, isNullable: true, foreignKey: undefined }
			]);
		});

		it('should return total rows', async () => {
			await mysql.sequelize?.query(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const totalRows = await mysql.getTotalRows('users', []);
			assert.strictEqual(totalRows, 3);
		});

		it('should return rows', async () => {
			await mysql.sequelize?.query(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const rows = await mysql.getRows('users', [], 2, 0);
			assert.deepStrictEqual(rows?.rows, [
				{ id: 1, name: 'John', age: 30 },
				{ id: 2, name: 'Jane', age: 25 }
			]);
		});

		it('should save changes', async () => {
			await mysql.sequelize?.query(`
				INSERT INTO users (name, age) VALUES
				('John', 30)
			`);

			const mutation = {
				row: { id: 1, name: 'John', age: 30 },
				rowIndex: 0,
				column: { name: 'age', type: 'int', isPrimaryKey: false },
				originalValue: 30,
				newValue: 31,
				primaryKey: 1,
				primaryKeyColumn: { name: 'id', type: 'int', isPrimaryKey: true },
				table: 'users'
			};

			await mysql.commitChange(mutation);

			const rows = await mysql.getRows('users', [], 1, 0);
			assert.strictEqual(rows?.rows[0].age, 31);
		});

		it('should return table creation SQL', async () => {
			const creationSql = (await mysql.getTableCreationSql('users'))
				.replace(/`/g, '')
				.replace(/\n|\t/g, '')
				.replace(/\s+/g, ' ')
				.trim();

			assert.strictEqual(creationSql, 'CREATE TABLE users ( id int NOT NULL AUTO_INCREMENT, name varchar(255) DEFAULT NULL, age int DEFAULT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci');
		});
	})
});
