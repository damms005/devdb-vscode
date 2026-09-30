import * as assert from 'assert';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { createClient, ClickHouseClient } from '@clickhouse/client';
import { ClickhouseEngine, resolveProtocol, sanitizeIdentifier } from '../../../database-engines/clickhouse-engine';
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
		assert.strictEqual(john?.id, '1');
		assert.strictEqual(john?.age, 30);
		assert.strictEqual(john?.tags, JSON.stringify(['a', 'b']));
	});

	it('round-trips a UInt64 value above 2^53 exactly as a string', async () => {
		const bigId = '18446744073709551615';

		await client.insert({
			table: 'users',
			values: [{ id: bigId, name: 'Big', age: 1, tags: [] }],
			format: 'JSONEachRow',
		});

		const columns = await engine.getColumns('users');
		const response = await engine.getRows('users', columns, 10, 0);

		const row = response?.rows.find(candidate => candidate.name === 'Big');
		assert.strictEqual(typeof row?.id, 'string');
		assert.strictEqual(row?.id, bigId);
	});

	it('populates query stats on getRows', async () => {
		await client.insert({
			table: 'users',
			values: [
				{ id: 1, name: 'John', age: 30, tags: [] },
				{ id: 2, name: 'Jane', age: 25, tags: [] },
			],
			format: 'JSONEachRow',
		});

		const columns = await engine.getColumns('users');
		const response = await engine.getRows('users', columns, 10, 0);

		assert.ok(response?.stats, 'expected stats to be populated');
		assert.strictEqual(typeof response?.stats?.rowsRead, 'number');
		assert.strictEqual(typeof response?.stats?.bytesRead, 'number');
		assert.strictEqual(typeof response?.stats?.elapsedSeconds, 'number');
		assert.ok((response?.stats?.bytesRead ?? 0) > 0);
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

	it('commits type-aware updates on Decimal and DateTime columns', async () => {
		await client.command({ query: 'DROP TABLE IF EXISTS products' });
		await client.command({
			query: `CREATE TABLE products (
				id UInt64,
				price Decimal(10, 2),
				created_at DateTime,
				note Nullable(String)
			) ENGINE = MergeTree ORDER BY id`,
		});

		await client.insert({
			table: 'products',
			values: [{ id: 1, price: '1.00', created_at: '2020-01-01 00:00:00', note: 'x' }],
			format: 'JSONEachRow',
		});

		const columns = await engine.getColumns('products');
		const priceColumn = columns.find(column => column.name === 'price')!;
		const createdAtColumn = columns.find(column => column.name === 'created_at')!;
		const noteColumn = columns.find(column => column.name === 'note')!;

		const decimalMutation: SerializedMutation = {
			type: 'cell-update', id: '1', tabId: 'abc', column: priceColumn,
			newValue: '1234.56', primaryKey: 1, primaryKeyColumn: 'id', table: 'products',
		};
		await engine.commitChange(decimalMutation, undefined as any);

		const dateMutation: SerializedMutation = {
			type: 'cell-update', id: '1', tabId: 'abc', column: createdAtColumn,
			newValue: '2024-06-15 12:34:56', primaryKey: 1, primaryKeyColumn: 'id', table: 'products',
		};
		await engine.commitChange(dateMutation, undefined as any);

		const nullMutation: SerializedMutation = {
			type: 'cell-update', id: '1', tabId: 'abc', column: noteColumn,
			newValue: null, primaryKey: 1, primaryKeyColumn: 'id', table: 'products',
		};
		await engine.commitChange(nullMutation, undefined as any);

		const rows = await engine.getRows('products', columns, 1, 0);
		const row = rows?.rows[0];
		assert.strictEqual(Number(row?.price), 1234.56);
		assert.strictEqual(row?.created_at, '2024-06-15 12:34:56');
		assert.strictEqual(row?.note, null);
	});

	it('caps rawQuery results to protect the host from unbounded scans', async () => {
		const raw = await engine.rawQuery('SELECT number FROM numbers(50000)');
		const parsed = JSON.parse(raw);

		assert.ok(Array.isArray(parsed));
		assert.ok(parsed.length <= 10000, `expected <= 10000 rows, got ${parsed.length}`);
		assert.strictEqual(parsed.length, 10000);
	});

	describe('identifier quoting', () => {
		const weirdTable = 'x\\` UNION ALL SELECT 1 --';

		beforeEach(async () => {
			await client.command({ query: `DROP TABLE IF EXISTS ${sanitizeIdentifier(weirdTable)}` });
			await client.command({
				query: `CREATE TABLE ${sanitizeIdentifier(weirdTable)} (id UInt64, \`a.b\` String, \`q\\\\\` String) ENGINE = MergeTree ORDER BY id`,
			});
			await client.insert({ table: sanitizeIdentifier(weirdTable), values: [{ id: 1, 'a.b': 'dot', 'q\\': 'slash' }], format: 'JSONEachRow' });
		});

		afterEach(async () => {
			await client.command({ query: `DROP TABLE IF EXISTS ${sanitizeIdentifier(weirdTable)}` });
		});

		it('escapes backslash before backtick', () => {
			assert.strictEqual(sanitizeIdentifier('x\\` y'), '`x\\\\\\` y`');
			assert.strictEqual(sanitizeIdentifier('a.b'), '`a.b`');
		});

		it('reads, counts, describes and edits a table named with backslash-backtick injection text', async () => {
			const columns = await engine.getColumns(weirdTable);
			assert.deepStrictEqual(columns.map(column => column.name), ['id', 'a.b', 'q\\']);

			const response = await engine.getRows(weirdTable, columns, 10, 0, { 'a.b': 'dot' });
			assert.deepStrictEqual(response?.rows, [{ id: '1', 'a.b': 'dot', 'q\\': 'slash' }]);
			assert.strictEqual(await engine.getTotalRows(weirdTable, columns), 1);
			assert.ok((await engine.getTableCreationSql(weirdTable)).startsWith('CREATE TABLE'));

			await engine.commitChange({
				type: 'cell-update', id: '1', tabId: 't', column: columns.find(column => column.name === 'q\\')!,
				newValue: 'edited', primaryKey: '1', primaryKeyColumn: 'id', table: weirdTable,
			}, undefined as any);
			const edited = await engine.getRows(weirdTable, columns, 10, 0);
			assert.strictEqual(edited?.rows[0]['q\\'], 'edited');
		});
	});

	it('casts cell updates to the server column type, ignoring the payload type', async () => {
		await client.insert({ table: 'users', values: [{ id: 1, name: 'John', age: 30, tags: [] }], format: 'JSONEachRow' });

		const mutation: SerializedMutation = {
			type: 'cell-update', id: '1', tabId: 'abc',
			column: {
				name: 'age', type: 'String) = 1, name = (SELECT \'pwned\'', isPlainTextType: false,
				isNumeric: true, isNullable: false, isEditable: true, isPrimaryKey: false,
			},
			newValue: '42', primaryKey: 1, primaryKeyColumn: 'id', table: 'users',
		};
		await engine.commitChange(mutation, undefined as any);

		const rows = await engine.getRows('users', await engine.getColumns('users'), 1, 0);
		assert.strictEqual(rows?.rows[0].age, 42);
		assert.strictEqual(rows?.rows[0].name, 'John');
	});

	it('round-trips Decimal values exactly in getRows and rawQuery', async () => {
		await client.command({ query: 'CREATE TABLE products (id UInt64, amount Decimal(18, 4)) ENGINE = MergeTree ORDER BY id' });
		await client.insert({ table: 'products', values: [{ id: 1, amount: '99999999999999.9999' }], format: 'JSONEachRow' });

		const response = await engine.getRows('products', await engine.getColumns('products'), 1, 0);
		assert.strictEqual(response?.rows[0].amount, '99999999999999.9999');

		const raw = JSON.parse(await engine.rawQuery('SELECT amount, toUInt64(18446744073709551615) AS big FROM products'));
		assert.deepStrictEqual(raw, [{ amount: '99999999999999.9999', big: '18446744073709551615' }]);
	});

	it('defaults to https except for loopback hosts', () => {
		assert.strictEqual(resolveProtocol('localhost', 8123), 'http');
		assert.strictEqual(resolveProtocol('127.0.0.1', 8123), 'http');
		assert.strictEqual(resolveProtocol('[::1]', 8123), 'http');
		assert.strictEqual(resolveProtocol('localhost', 8443), 'https');
		assert.strictEqual(resolveProtocol('localhost', 9440), 'https');
		assert.strictEqual(resolveProtocol('ch.example.com', 8123), 'https');
		assert.strictEqual(resolveProtocol('ch.example.com', 8123, 'http'), 'http');
	});

	it('flags plain http to a non-loopback host as insecure', () => {
		assert.strictEqual(engine.usesInsecureTransport, false);
		assert.strictEqual(new ClickhouseEngine({ ...makeConfig(), host: '203.0.113.1', port: 8123, protocol: 'http' }).usesInsecureTransport, true);
		assert.strictEqual(new ClickhouseEngine({ ...makeConfig(), host: '203.0.113.1', port: 8123 }).usesInsecureTransport, false);
	});

	it('rejects writes, SYSTEM, KILL and DROP in readOnly rawQuery', async () => {
		const blocked = [
			"INSERT INTO FUNCTION file('devdb-ro.csv', 'CSV', 'a UInt8') SELECT 1",
			'INSERT INTO users (id, name, age, tags) VALUES (9, \'x\', 1, [])',
			'SYSTEM FLUSH LOGS',
			"KILL QUERY WHERE query_id = 'none'",
			'/* c */ kill query where 1',
			'DROP TABLE users',
			'SELECT 1 SETTINGS readonly = 0',
		];

		for (const query of blocked) {
			await assert.rejects(engine.rawQuery(query, { readOnly: true }), `expected read-only rejection for: ${query}`);
		}

		assert.ok((await engine.getTables()).includes('users'));
		assert.strictEqual(await engine.getTotalRows('users', []), 0);
		assert.deepStrictEqual(JSON.parse(await engine.rawQuery('SELECT 1 AS x', { readOnly: true })), [{ x: 1 }]);
	});

	it('runs DDL through rawQuery without a JSON parse error', async () => {
		assert.strictEqual(await engine.rawQuery('CREATE TABLE products (id UInt64) ENGINE = MergeTree ORDER BY id'), '[]');
		assert.ok((await engine.getTables()).includes('products'));
	});

	it('kills the server query when a rawQuery is aborted', async function () {
		this.timeout(30000);
		const marker = `devdb-cancel-${Date.now()}`;
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1000);

		await assert.rejects(engine.rawQuery(`SELECT count() FROM numbers(2000000) a CROSS JOIN numbers(2000000) b /* ${marker} */`, { signal: controller.signal }));

		let running = -1;
		for (let attempt = 0; attempt < 10 && running !== 0; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 500));
			const result = await client.query({
				query: 'SELECT count() AS c FROM system.processes WHERE query LIKE {marker:String} AND query NOT LIKE \'%system.processes%\'',
				query_params: { marker: `%${marker}%` },
				format: 'JSONEachRow',
			});
			running = Number(((await result.json()) as { c: string }[])[0].c);
		}
		assert.strictEqual(running, 0, 'aborted query still running on the server');
	});

	it('stops getRows at the configured max execution time', async function () {
		this.timeout(30000);
		await client.command({ query: 'DROP VIEW IF EXISTS slow_view' });
		await client.command({ query: 'CREATE VIEW slow_view AS SELECT sleepEachRow(1) AS s, number FROM numbers(20) SETTINGS max_block_size = 1' });

		const limited = new ClickhouseEngine(makeConfig(), { maxExecutionTimeSeconds: 1 });
		await limited.connect();
		const started = Date.now();
		const response = await limited.getRows('slow_view', await limited.getColumns('slow_view'), 20, 0);
		await limited.disconnect();
		await client.command({ query: 'DROP VIEW IF EXISTS slow_view' });

		assert.strictEqual(response, undefined);
		assert.ok(Date.now() - started < 10000, `expected timeout near 1 s, took ${Date.now() - started} ms`);
	});

	after(async function () {
		await engine.disconnect();
		await client.close();
	});
});
