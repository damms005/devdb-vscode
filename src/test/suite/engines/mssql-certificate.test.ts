import * as assert from 'assert';
import knexlib from "knex";
import { MSSQLServerContainer, StartedMSSQLServerContainer } from '@testcontainers/mssqlserver';
import { MssqlEngine } from '../../../database-engines/mssql-engine';

const dockerImage = 'mcr.microsoft.com/mssql/server:2022-CU13-ubuntu-22.04';

/**
 * @see https://github.com/damms005/devdb-vscode/issues/113
 */
describe('MSSQL Certificate Connection Tests', () => {
  let container: StartedMSSQLServerContainer;

  before(async function () {
    this.timeout(60000); // Increase timeout for container setup

    // Start a standard MSSQL container with the testcontainers API
    container = await new MSSQLServerContainer(dockerImage)
      .withName('devdb-test-container-mssql-cert')
      .acceptLicense()
      .withPassword('yourStrong(!)Password')
      .start();
  });

  it('should connect with trustServerCertificate=true', async function () {
    this.timeout(10000);

    const connectionWithTrust = knexlib.knex({
      client: 'mssql',
      connection: {
        host: container.getHost(),
        port: container.getMappedPort(1433),
        database: 'master',
        user: 'sa',
        password: 'yourStrong(!)Password',
        options: {
          encrypt: true,
          trustServerCertificate: true // Trust any certificate
        },
        requestTimeout: 15000,
        connectionTimeout: 15000
      }
    });

    try {
      const result = await connectionWithTrust.raw('SELECT 1 as result');
      assert.ok(result && result.length > 0, 'Query should return results');
      await connectionWithTrust.destroy();
    } catch (error: any) {
      await connectionWithTrust.destroy();
      throw new Error(`Connection with trustServerCertificate=true should succeed, but failed with: ${error.message}`);
    }
  });

  it('should fail to connect with trustServerCertificate=false', async function () {
    this.timeout(10000);

    const connectionWithoutTrust = knexlib.knex({
      client: 'mssql',
      connection: {
        host: container.getHost(),
        port: container.getMappedPort(1433),
        database: 'master',
        user: 'sa',
        password: 'yourStrong(!)Password',
        options: {
          encrypt: true,
          trustServerCertificate: false // Don't trust self-signed certificates
        },
        requestTimeout: 15000,
        connectionTimeout: 15000
      }
    });

    try {
      await connectionWithoutTrust.raw('SELECT 1 as result');
      await connectionWithoutTrust.destroy();
      assert.fail('Connection with trustServerCertificate=false should have failed');
    } catch (error: any) {
      // This is expected to fail with certificate validation error
      assert.ok(
        error.message.includes('certificate') ||
        error.message.includes('self signed') ||
        error.message.includes('Could not connect'),
        `Expected certificate validation error, got: ${error.message}`
      );
    }
  });

  it('should connect with MssqlEngine when trustServerCertificate=true', async function () {
    this.timeout(10000);

    const connection = knexlib.knex({
      client: 'mssql',
      connection: {
        host: container.getHost(),
        port: container.getMappedPort(1433),
        database: 'master',
        user: 'sa',
        password: 'yourStrong(!)Password',
        options: {
          encrypt: true,
          trustServerCertificate: true // Trust any certificate
        },
        requestTimeout: 15000,
        connectionTimeout: 15000
      }
    });

    try {
      const engine = new MssqlEngine(connection);
      const isOkay = await engine.isOkay();
      assert.strictEqual(isOkay, true, 'MssqlEngine should report connection as okay');
      await connection.destroy();
    } catch (error: any) {
      await connection.destroy();
      throw new Error(`MssqlEngine connection with trustServerCertificate=true should succeed, but failed with: ${error.message}`);
    }
  });

  it('should perform database operations with secure connection', async function () {
    this.timeout(15000);

    const connection = knexlib.knex({
      client: 'mssql',
      connection: {
        host: container.getHost(),
        port: container.getMappedPort(1433),
        database: 'master',
        user: 'sa',
        password: 'yourStrong(!)Password',
        options: {
          encrypt: true,
          trustServerCertificate: true
        },
        requestTimeout: 15000,
        connectionTimeout: 15000
      }
    });

    try {
      const engine = new MssqlEngine(connection);

      // Create test table
      await engine.connection?.raw(`DROP TABLE IF EXISTS secure_test_table`);
      await engine.connection?.raw(`
        CREATE TABLE secure_test_table (
          id INT PRIMARY KEY IDENTITY(1,1),
          name VARCHAR(255),
          sensitive_data VARCHAR(255)
        )
      `);

      // Insert test data
      await engine.connection?.raw(`
        INSERT INTO secure_test_table (name, sensitive_data) VALUES
        ('Test1', 'Sensitive1'),
        ('Test2', 'Sensitive2')
      `);

      // Verify data can be retrieved
      const rows = await engine.getRows('secure_test_table', [], 10, 0);
      assert.strictEqual(rows?.rows.length, 2, 'Should return 2 rows');
      assert.strictEqual(rows?.rows[0].name, 'Test1', 'First row name should be Test1');
      assert.strictEqual(rows?.rows[0].sensitive_data, 'Sensitive1', 'First row sensitive data should be Sensitive1');

      // Verify column definitions
      const columns = await engine.getColumns('secure_test_table');
      assert.deepStrictEqual(columns.map(c => c.name), ['id', 'name', 'sensitive_data']);
      assert.strictEqual(columns[0].isPrimaryKey, true);
      assert.strictEqual(columns[1].type, 'varchar');
      assert.strictEqual(columns[2].type, 'varchar');

      // Clean up
      await engine.connection?.raw(`DROP TABLE IF EXISTS secure_test_table`);
      await connection.destroy();
    } catch (error: any) {
      // Clean up in case of error
      try {
        await connection.raw(`DROP TABLE IF EXISTS secure_test_table`);
      } catch { }
      await connection.destroy();
      throw new Error(`Database operations with secure connection failed: ${error.message}`);
    }
  });

  after(async function () {
    // Stop the container if it exists
    if (container) {
      try {
        await container.stop();
        console.log('Container stopped successfully');
      } catch (error) {
        console.error(`Failed to stop container: ${error}`);
      }
    }
  });
});
