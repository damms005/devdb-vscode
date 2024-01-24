import * as assert from 'assert';
import { Sequelize } from 'sequelize';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresEngine } from '../../../database-engines/postgres-engine';

describe.skip('Postgres Tests', () => {
	it('postgres: should return correct foreign key definitions', async () => {
		const container = await new PostgreSqlContainer().start();
		let sequelize: Sequelize = new Sequelize(
			container.getDatabase(),
			container.getUsername(),
			container.getPassword(),
			{
				dialect: 'postgres',
				port: container.getPort(),
				host: container.getHost(),
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

		const postgres = new PostgresEngine(sequelize);
		const columns = await postgres.getColumns('ChildTable');

		const foreignKeyColumn = columns.find(column => column.name === 'parentId');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'ParentTable');
	})
		.timeout(30000)


	describe('PostgresEngine Tests', () => {
		let postgres: PostgresEngine;

		before(async function () {
			this.timeout(30000);
			const container = await new PostgreSqlContainer().start();
			let sequelize: Sequelize = new Sequelize(
				container.getDatabase(),
				container.getUsername(),
				container.getPassword(),
				{
					dialect: 'postgres',
					port: container.getPort(),
					host: container.getHost(),
					logging: false
				});
			await sequelize.authenticate();

			postgres = new PostgresEngine(sequelize);
			const ok = await postgres.isOkay();
			assert.strictEqual(ok, true);

			await postgres.sequelize?.query(`
            CREATE TABLE users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name varchar(255),
                age INT
            )
        `);
		});

		it('should return correct table names', async () => {
			await postgres.sequelize?.query(`
            CREATE TABLE products (
                id INT PRIMARY KEY,
                name varchar(255),
                price INT
            )
        `);

			const tables = await postgres.getTables();
			assert.deepStrictEqual(tables, ['products', 'users']);
		})

		it('should return correct column definitions', async () => {
			const columns = await postgres.getColumns('users');
			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'int', isPrimaryKey: true, isOptional: false, foreignKey: undefined },
				{ name: 'name', type: 'varchar(255)', isPrimaryKey: false, isOptional: true, foreignKey: undefined },
				{ name: 'age', type: 'int', isPrimaryKey: false, isOptional: true, foreignKey: undefined }
			]);
		})

		it('should return correct total rows', async () => {
			await postgres.sequelize?.query(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const totalRows = await postgres.getTotalRows('users');
			assert.strictEqual(totalRows, 3);
		})

		it('should return correct rows', async () => {
			await postgres.sequelize?.query(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const rows = await postgres.getRows('users', 2, 0);
			assert.deepStrictEqual(rows?.rows, [
				{ id: 1, name: 'John', age: 30 },
				{ id: 2, name: 'Jane', age: 25 }
			]);
		})

		it('should return correct table creation SQL', async () => {
			const creationSql = (await postgres.getTableCreationSql('users'))
				.replace(/`/g, '')
				.replace(/\n|\t/g, '')
				.replace(/\s+/g, ' ')
				.trim();

			assert.strictEqual(creationSql, 'CREATE TABLE users ( id int NOT NULL AUTO_INCREMENT, name varchar(255) DEFAULT NULL, age int DEFAULT NULL, PRIMARY KEY (id) ) ENGINE = InnoDB AUTO_INCREMENT = 7 DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci');
		})
	})
		.timeout(30000)
});