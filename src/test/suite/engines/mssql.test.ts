import * as assert from 'assert';
import { Sequelize } from 'sequelize';
import { MssqlEngine } from '../../../database-engines/mssql-engine';
import { MSSQLServerContainer } from '@testcontainers/mssqlserver';

describe('MSSQL Tests', () => {
	it('mssql: should return correct foreign key definitions', async () => {
		const container = await new MSSQLServerContainer()
			.acceptLicense()
			.withPassword('yourStrong(!)Password')
			.start();

		const sequelize: Sequelize = new Sequelize('master', 'sa', 'yourStrong(!)Password', {
			dialect: 'mssql',
			port: container.getMappedPort(1433),
			host: container.getHost(),
			dialectModule: require('tedious'),
			logging: false
		});

		await sequelize.query(`
        CREATE TABLE ParentTable (
            id INT PRIMARY KEY IDENTITY(1,1)
        )
    `);

		await sequelize.query(`
        CREATE TABLE ChildTable (
            id INT PRIMARY KEY IDENTITY(1,1),
            parentId INT,
            FOREIGN KEY (parentId) REFERENCES ParentTable(id)
        )
    `);

		const mssql = new MssqlEngine(sequelize);
		const columns = await mssql.getColumns('ChildTable');

		const foreignKeyColumn = columns.find(column => column.name === 'parentId');

		assert.strictEqual(foreignKeyColumn?.foreignKey?.table, 'ParentTable');
	})
		.timeout(30000);

	describe('MssqlEngine Tests', () => {
		let mssql: MssqlEngine;

		before(async function () {
			this.timeout(30000);
			const container = await new MSSQLServerContainer()
				.acceptLicense()
				.withPassword('yourStrong(!)Password')
				.start();

			const sequelize: Sequelize = new Sequelize('master', 'sa', 'yourStrong(!)Password', {
				dialect: 'mssql',
				port: container.getMappedPort(1433),
				host: container.getHost(),
				dialectModule: require('tedious'),
				logging: false
			});
			await sequelize.authenticate();

			mssql = new MssqlEngine(sequelize);
			const ok = await mssql.isOkay();
			assert.strictEqual(ok, true);

			await mssql.sequelize?.query(`
            CREATE TABLE users (
                id INT PRIMARY KEY IDENTITY(1,1),
                name varchar(255),
                age INT
            )
        `);
		});

		it('should return correct table names', async () => {
			await mssql.sequelize?.query(`
            CREATE TABLE products (
                id INT PRIMARY KEY,
                name varchar(255),
                price INT
            )
        `);

			const tables = await mssql.getTables();
			assert.deepStrictEqual(tables, ['products', 'users']);
		})
			;

		it('should return correct column definitions', async () => {
			const columns = await mssql.getColumns('users');
			assert.deepStrictEqual(columns, [
				{ name: 'id', type: 'int', isPrimaryKey: true, isOptional: false, foreignKey: undefined },
				{ name: 'name', type: 'varchar', isPrimaryKey: false, isOptional: true, foreignKey: undefined },
				{ name: 'age', type: 'int', isPrimaryKey: false, isOptional: true, foreignKey: undefined }
			]);
		})
			;

		it('should return correct total rows', async () => {
			await mssql.sequelize?.query(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const totalRows = await mssql.getTotalRows('users');
			assert.strictEqual(totalRows, 3);
		})
			;

		it('should return correct rows', async () => {
			await mssql.sequelize?.query(`
            INSERT INTO users (name, age) VALUES
            ('John', 30),
            ('Jane', 25),
            ('Bob', 40)
        `);

			const rows = await mssql.getRows('users', [], 2, 0);
			assert.deepStrictEqual(rows?.rows, [
				{ id: 1, name: 'John', age: 30 },
				{ id: 2, name: 'Jane', age: 25 }
			]);
		})
			;

		it('should return correct table creation SQL', async () => {
			const creationSql = (await mssql.getTableCreationSql('users'))
				.replace(/\[|\]/g, '')
				.replace(/\n|\t/g, '')
				.replace(/\s+/g, ' ')
				.trim();

			assert.strictEqual(creationSql, '{ "TABLE_QUALIFIER": "master", "TABLE_OWNER": "dbo", "TABLE_NAME": "users", "COLUMN_NAME": "id", "DATA_TYPE": 4, "TYPE_NAME": "int identity", "PRECISION": 10, "LENGTH": 4, "SCALE": 0, "RADIX": 10, "NULLABLE": 0, "REMARKS": null, "COLUMN_DEF": null, "SQL_DATA_TYPE": 4, "SQL_DATETIME_SUB": null, "CHAR_OCTET_LENGTH": null, "ORDINAL_POSITION": 1, "IS_NULLABLE": "NO", "SS_DATA_TYPE": 56 }, { "TABLE_QUALIFIER": "master", "TABLE_OWNER": "dbo", "TABLE_NAME": "users", "COLUMN_NAME": "name", "DATA_TYPE": 12, "TYPE_NAME": "varchar", "PRECISION": 255, "LENGTH": 255, "SCALE": null, "RADIX": null, "NULLABLE": 1, "REMARKS": null, "COLUMN_DEF": null, "SQL_DATA_TYPE": 12, "SQL_DATETIME_SUB": null, "CHAR_OCTET_LENGTH": 255, "ORDINAL_POSITION": 2, "IS_NULLABLE": "YES", "SS_DATA_TYPE": 39 }, { "TABLE_QUALIFIER": "master", "TABLE_OWNER": "dbo", "TABLE_NAME": "users", "COLUMN_NAME": "age", "DATA_TYPE": 4, "TYPE_NAME": "int", "PRECISION": 10, "LENGTH": 4, "SCALE": 0, "RADIX": 10, "NULLABLE": 1, "REMARKS": null, "COLUMN_DEF": null, "SQL_DATA_TYPE": 4, "SQL_DATETIME_SUB": null, "CHAR_OCTET_LENGTH": null, "ORDINAL_POSITION": 3, "IS_NULLABLE": "YES", "SS_DATA_TYPE": 38 }');
		})
	}).timeout(30000);
});
