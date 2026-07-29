import * as assert from 'assert';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { createClient, ClickHouseClient } from '@clickhouse/client';
import { ClickhouseEngine } from '../../../database-engines/clickhouse-engine';
import { ClickhouseConfig, SerializedMutation } from '../../../types';

/**
 * We pin the image so it can be pre-pulled manually before CI/first run,
 * mirroring the approach used by the PostgreSQL engine tests.
 */
const dockerImage = 'clickhouse/clickhouse-server:24.3-alpine';
const HTTP_PORT = 8123;

/**
 * The ClickHouse server image disables network access for the `default` user
 * unless CLICKHOUSE_USER/CLICKHOUSE_PASSWORD are provided, so a password is set.
 */
const CLICKHOUSE_PASSWORD = 'devdb';

describe('ClickHouse Tests', () => {
	let container: StartedTestContainer;
	let client: ClickHouseClient;
	let engine: ClickhouseEngine;

	function makeConfig(): ClickhouseConfig {
		return {
			name: 'test-clickhouse',
			type: 'clickhouse',
			host: container.getHost(),
			port: container.getMappedPort(HTTP_PORT),
			username: 'default',
			password: CLICKHOUSE_PASSWORD,
			database: 'default',
		};
	}

	before(async function () {
		this.timeout(120000);

		container = await new GenericContainer(dockerImage)
			.withName('devdb-test-container-clickhouse')
			.withExposedPorts(HTTP_PORT)
			.withEnvironment({ CLICKHOUSE_PASSWORD })
			.withReuse()
			.withWaitStrategy(Wait.forHttp('/ping', HTTP_PORT).forStatusCode(200))
			.start();

		client = createClient({
			url: `http://${container.getHost()}:${container.getMappedPort(HTTP_PORT)}`,
			username: 'default',
			password: CLICKHOUSE_PASSWORD,
			database: 'default',
		});

		engine = new ClickhouseEngine(makeConfig());
		const connected = await engine.connect();
		assert.strictEqual(connected, true);
	});

	beforeEach(async function () {
		await client.command({ query: 'DROP TABLE IF EXISTS users' });
		await client.command({ query: 'DROP TABLE IF EXISTS products' });

		await client.command({
			query: `
				CREATE TABLE users (
					id UInt64,
					name String,
					age Int32,
					tags Array(String)
				) ENGINE = MergeTree ORDER BY id
			`,
		});
	});

	afterEach(async function () {
		await client.command({ query: 'DROP TABLE IF EXISTS users' });
		await client.command({ query: 'DROP TABLE IF EXISTS products' });
	});

	it('should report the connection as okay', async () => {
		const ok = await engine.isOkay();
		assert.strictEqual(ok, true);
	});

	it('should return table names', async () => {
		await client.command({
			query: `CREATE TABLE products (id UInt64, name String) ENGINE = MergeTree ORDER BY id`,
		});

		const tables = await engine.getTables();
		assert.ok(tables.includes('users'));
		assert.ok(tables.includes('products'));
	});

	it('should return column definitions including an Array column', async () => {
		const columns = await engine.getColumns('users');
		const byName = Object.fromEntries(columns.map(column => [column.name, column]));

		assert.strictEqual(byName['id'].type, 'UInt64');
		assert.strictEqual(byName['id'].isPrimaryKey, true);
		assert.strictEqual(byName['id'].isNumeric, true);
		assert.strictEqual(byName['id'].isEditable, true);

		assert.strictEqual(byName['name'].type, 'String');
		assert.strictEqual(byName['name'].isPlainTextType, true);
		assert.strictEqual(byName['name'].isNumeric, false);

		assert.strictEqual(byName['age'].type, 'Int32');
		assert.strictEqual(byName['age'].isNumeric, true);

		assert.strictEqual(byName['tags'].type, 'Array(String)');
		assert.strictEqual(byName['tags'].isNumeric, false);
		assert.strictEqual(byName['tags'].isPlainTextType, false);
		assert.strictEqual(byName['tags'].isEditable, false);
	});

	it('should classify a Nullable(String) column as nullable and plain text', async () => {
		await client.command({ query: 'DROP TABLE IF EXISTS products' });
		await client.command({
			query: `CREATE TABLE products (id UInt64, note Nullable(String)) ENGINE = MergeTree ORDER BY id`,
		});

		const columns = await engine.getColumns('products');
		const note = columns.find(column => column.name === 'note');

		assert.ok(note);
		assert.strictEqual(note?.isNullable, true);
		assert.strictEqual(note?.isPlainTextType, true);
	});

	it('should return rows with an Array column serialized to JSON', async () => {
		await client.insert({
			table: 'users',
			values: [
				{ id: 1, name: 'John', age: 30, tags: ['a', 'b'] },
				{ id: 2, name: 'Jane', age: 25, tags: [] },
			],
			format: 'JSONEachRow',
		});

		const columns = await engine.getColumns('users');
		const response = await engine.getRows('users', columns, 10, 0);

		assert.strictEqual(response?.rows.length, 2);

		const john = response?.rows.find(row => row.name === 'John');
		assert.strictEqual(john?.id, 1);
		assert.strictEqual(john?.age, 30);
		assert.strictEqual(john?.tags, JSON.stringify(['a', 'b']));
	});

	it('should return total rows', async () => {
		await client.insert({
			table: 'users',
			values: [
				{ id: 1, name: 'John', age: 30, tags: [] },
				{ id: 2, name: 'Jane', age: 25, tags: [] },
				{ id: 3, name: 'Bob', age: 40, tags: [] },
			],
			format: 'JSONEachRow',
		});

		const totalRows = await engine.getTotalRows('users', []);
		assert.strictEqual(totalRows, 3);
	});

	it('should filter rows with a where clause', async () => {
		await client.insert({
			table: 'users',
			values: [
				{ id: 1, name: 'John', age: 30, tags: [] },
				{ id: 2, name: 'Jane', age: 25, tags: [] },
			],
			format: 'JSONEachRow',
		});

		const columns = await engine.getColumns('users');

		const numericFiltered = await engine.getRows('users', columns, 10, 0, { age: 30 });
		assert.strictEqual(numericFiltered?.rows.length, 1);
		assert.strictEqual(numericFiltered?.rows[0].name, 'John');

		const textFiltered = await engine.getRows('users', columns, 10, 0, { name: 'Jane' });
		assert.strictEqual(textFiltered?.rows.length, 1);
		assert.strictEqual(textFiltered?.rows[0].name, 'Jane');
	});

	it('should return a version string', async () => {
		const version = await engine.getVersion();
		assert.ok(version && version.length > 0);
	});

	it('should commit a cell-update mutation', async () => {
		await client.insert({
			table: 'users',
			values: [{ id: 1, name: 'John', age: 30, tags: [] }],
			format: 'JSONEachRow',
		});

		const mutation: SerializedMutation = {
			type: 'cell-update',
			id: '1',
			tabId: 'abc',
			column: {
				name: 'age', type: 'Int32', isPlainTextType: false,
				isNumeric: true, isNullable: false, isEditable: true, isPrimaryKey: false,
			},
			newValue: 31,
			primaryKey: 1,
			primaryKeyColumn: 'id',
			table: 'users',
		};

		await engine.commitChange(mutation, undefined as any);

		const columns = await engine.getColumns('users');
		const rows = await engine.getRows('users', columns, 1, 0);
		assert.strictEqual(Number(rows?.rows[0].age), 31);
	});

	after(async function () {
		await engine.disconnect();
		await client.close();
	});
});
