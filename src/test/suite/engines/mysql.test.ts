import * as assert from 'assert';
import { Sequelize } from 'sequelize';
import { MysqlEngine } from '../../../database-engines/mysql-engine';
import { MySqlContainer } from '@testcontainers/mysql';

describe('MySQL Tests', () => {
	it('mysql: should return correct foreign key definitions', async () => {
		const container = await new MySqlContainer().start();
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
	})
		.timeout(30000);

	describe('MysqlEngine Tests', () => {
		let mysql: MysqlEngine;

		before(async function () {
			this.timeout(30000);
			const container = await new MySqlContainer().start();
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

		it('should return correct table names', async () => {
			await mysql.sequelize?.query(`
            CREATE TABLE products (
                id INT PRIMARY KEY,
                name varchar(255),
                price INT
            )
        `);

			const tables = await mysql.getTables();
			assert.deepStrictEqual(tables, ['products', 'users']);
		})
			;

		it('should return correct column definitions', async () => {
			const columns = await mysql.getColumns('users');
			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'int', isPrimaryKey: true, isNullable: false, foreignKey: undefined },
				{ name: 'name', type: 'varchar(255)', isPrimaryKey: false, isNullable: true, foreignKey: undefined },
				{ name: 'age', type: 'int', isPrimaryKey: false, isNullable: true, foreignKey: undefined }
			]);
		})
			;

		it('should return correct total rows', async () => {
			await mysql.sequelize?.query(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const totalRows = await mysql.getTotalRows('users', []);
			assert.strictEqual(totalRows, 3);
		})
			;

		it('should return correct rows', async () => {
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
		})
			;

		it('should return correct table creation SQL', async () => {
			const creationSql = (await mysql.getTableCreationSql('users'))
				.replace(/`/g, '')
				.replace(/\n|\t/g, '')
				.replace(/\s+/g, ' ')
				.trim();

			assert.strictEqual(creationSql, 'CREATE TABLE users ( id int NOT NULL AUTO_INCREMENT, name varchar(255) DEFAULT NULL, age int DEFAULT NULL, PRIMARY KEY (id) ) ENGINE = InnoDB AUTO_INCREMENT = 7 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci');
		})
			;
	}).timeout(30000);
});