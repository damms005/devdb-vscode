import * as assert from 'assert';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { RedisEngine } from '../../../database-engines/redis-engine';
import { RedisConfig } from '../../../types';

/**
 * We use a predefined image like this because docker image download can be very very slow, hence
 * on new computer/initial setup when the image is not already existing, it takes a very long time
 * to run this test. Using a predefined image name like this makes it possible for us to manually
 * download the image (e.g. using `docker run ...`) to ensure it exists in the system before running the test.
 *
 * Redis and Valkey both speak RESP, so this single suite exercises the driver used for both.
 */
const dockerImage = 'redis:7-alpine'

describe('Redis Tests', () => {
	let container: StartedRedisContainer;
	let engine: RedisEngine;

	before(async function () {
		container = await new RedisContainer(dockerImage)
			.withName('devdb-test-container-redis')
			.withReuse()
			.start();

		const config: RedisConfig = {
			name: 'redis-test',
			type: 'redis',
			connectionString: container.getConnectionUrl(),
		}

		engine = new RedisEngine(config);
		const connected = await engine.connect();
		assert.strictEqual(connected, true);
	})

	beforeEach(async function () {
		await engine.rawQuery('FLUSHALL');

		await engine.rawQuery(['SET', 'greeting', 'hello world']);
		await engine.rawQuery(['SET', 'counter', '42']);

		await engine.rawQuery(['HSET', 'user:1', 'name', 'John', 'age', '30']);

		await engine.rawQuery(['RPUSH', 'queue', 'first', 'second', 'third']);
	})

	it('should report a healthy connection with isOkay', async () => {
		const ok = await engine.isOkay();
		assert.strictEqual(ok, true);
	})

	it('should return present data types as tables', async () => {
		const tables = await engine.getTables();
		assert.deepStrictEqual(tables.sort(), ['hash', 'list', 'string']);
	})

	it('should return synthetic columns for the string type', async () => {
		const columns = await engine.getColumns('string');
		assert.deepStrictEqual(columns.map(c => c.name), ['_id', 'value', 'ttl']);

		const idColumn = columns.find(c => c.name === '_id');
		assert.strictEqual(idColumn?.isPrimaryKey, true);

		const valueColumn = columns.find(c => c.name === 'value');
		assert.strictEqual(valueColumn?.isEditable, true);
	})

	it('should return synthetic columns for the hash type', async () => {
		const columns = await engine.getColumns('hash');
		assert.deepStrictEqual(columns.map(c => c.name), ['_id', 'key', 'field', 'value', 'ttl']);
	})

	it('should return synthetic columns for the list type', async () => {
		const columns = await engine.getColumns('list');
		assert.deepStrictEqual(columns.map(c => c.name), ['_id', 'key', 'index', 'value', 'ttl']);

		const indexColumn = columns.find(c => c.name === 'index');
		assert.strictEqual(indexColumn?.isNumeric, true);
	})

	it('should return one row per string key', async () => {
		const columns = await engine.getColumns('string');
		const result = await engine.getRows('string', columns, 100, 0);

		const rows = result?.rows ?? [];
		assert.strictEqual(rows.length, 2);

		const greeting = rows.find(row => row._id === 'greeting');
		assert.strictEqual(greeting?.value, 'hello world');
	})

	it('should expand hash fields into field/value rows', async () => {
		const columns = await engine.getColumns('hash');
		const result = await engine.getRows('hash', columns, 100, 0);

		const rows = result?.rows ?? [];
		assert.strictEqual(rows.length, 2);

		const nameRow = rows.find(row => row.field === 'name');
		assert.strictEqual(nameRow?.key, 'user:1');
		assert.strictEqual(nameRow?.value, 'John');
	})

	it('should expand list values into index/value rows', async () => {
		const columns = await engine.getColumns('list');
		const result = await engine.getRows('list', columns, 100, 0);

		const rows = result?.rows ?? [];
		assert.strictEqual(rows.length, 3);
		assert.strictEqual(rows[0].index, 0);
		assert.strictEqual(rows[0].value, 'first');
		assert.strictEqual(rows[2].value, 'third');
	})

	it('should count rows with getTotalRows', async () => {
		assert.strictEqual(await engine.getTotalRows('string', []), 2);
		assert.strictEqual(await engine.getTotalRows('hash', []), 2);
		assert.strictEqual(await engine.getTotalRows('list', []), 3);
	})

	it('should paginate rows', async () => {
		const columns = await engine.getColumns('list');
		const firstPage = await engine.getRows('list', columns, 2, 0);
		const secondPage = await engine.getRows('list', columns, 2, 2);

		assert.strictEqual(firstPage?.rows.length, 2);
		assert.strictEqual(secondPage?.rows.length, 1);
		assert.strictEqual(secondPage?.rows[0].value, 'third');
	})

	it('should filter rows with a where clause', async () => {
		const columns = await engine.getColumns('string');
		const result = await engine.getRows('string', columns, 100, 0, { value: 'hello' });

		assert.strictEqual(result?.rows.length, 1);
		assert.strictEqual(result?.rows[0]._id, 'greeting');
	})

	it('should commit a string SET edit', async () => {
		await engine.commitChange({
			type: 'cell-update',
			id: '1',
			tabId: 'abc',
			table: 'string',
			column: { name: 'value', type: 'string', isPlainTextType: true, isNumeric: false, isNullable: true, isEditable: true, isPrimaryKey: false },
			newValue: 'goodbye',
			primaryKey: 'greeting',
			primaryKeyColumn: '_id',
		}, undefined as any);

		const value = await engine.rawQuery(['GET', 'greeting']);
		assert.strictEqual(value, 'goodbye');
	})

	it('should commit a hash HSET edit', async () => {
		const columns = await engine.getColumns('hash');
		const result = await engine.getRows('hash', columns, 100, 0);
		const nameRow = result?.rows.find(row => row.field === 'name');

		await engine.commitChange({
			type: 'cell-update',
			id: '1',
			tabId: 'abc',
			table: 'hash',
			column: { name: 'value', type: 'string', isPlainTextType: true, isNumeric: false, isNullable: true, isEditable: true, isPrimaryKey: false },
			newValue: 'Jane',
			primaryKey: nameRow!._id,
			primaryKeyColumn: '_id',
		}, undefined as any);

		const value = await engine.rawQuery(['HGET', 'user:1', 'name']);
		assert.strictEqual(value, 'Jane');
	})

	it('should return a redis version', async () => {
		const version = await engine.getVersion();
		assert.ok(version && version.length > 0);
	})

	it('should page a large keyspace without reading every value', async () => {
		await engine.rawQuery('FLUSHALL');

		const total = 500;
		for (let i = 0; i < total; i++) {
			await engine.rawQuery(['SET', `bulk:${String(i).padStart(4, '0')}`, `value-${i}`]);
		}

		const client = (engine as any).client;
		const originalGet = client.get.bind(client);
		let getCalls = 0;
		client.get = (...args: any[]) => {
			getCalls++;
			return originalGet(...args);
		};

		try {
			const columns = await engine.getColumns('string');
			const pageSize = 10;

			const firstPage = await engine.getRows('string', columns, pageSize, 0);
			assert.strictEqual(firstPage?.rows.length, pageSize);
			assert.ok(getCalls <= pageSize, `expected at most ${pageSize} value reads for page 1, got ${getCalls}`);
			assert.ok(getCalls < total, 'must not read the whole keyspace for one page');

			const callsAfterFirst = getCalls;
			const secondPage = await engine.getRows('string', columns, pageSize, pageSize);
			assert.strictEqual(secondPage?.rows.length, pageSize);
			assert.ok(getCalls - callsAfterFirst <= pageSize, 'page 2 must also read only page-sized values');

			const firstIds = new Set(firstPage!.rows.map(row => row._id));
			const overlap = secondPage!.rows.filter(row => firstIds.has(row._id));
			assert.strictEqual(overlap.length, 0, 'sequential pages must return distinct keys');
		} finally {
			client.get = originalGet;
		}
	})

	it('should approximate total rows without a full keyspace walk', async () => {
		await engine.rawQuery('FLUSHALL');
		for (let i = 0; i < 250; i++) {
			await engine.rawQuery(['SET', `count:${i}`, 'x']);
		}

		const totalRows = await engine.getTotalRows('string', []);
		assert.strictEqual(totalRows, 250);
	})

	it('should expose a ttl column reflecting PTTL for the current page', async () => {
		await engine.rawQuery('FLUSHALL');
		await engine.rawQuery(['SET', 'persistent', 'forever']);
		await engine.rawQuery(['SET', 'ephemeral', 'soon']);
		await engine.rawQuery(['PEXPIRE', 'ephemeral', '100000']);

		const columns = await engine.getColumns('string');
		assert.ok(columns.some(c => c.name === 'ttl'), 'ttl column must be present');

		const result = await engine.getRows('string', columns, 100, 0);
		const rows = result?.rows ?? [];

		const persistent = rows.find(row => row._id === 'persistent');
		assert.strictEqual(persistent?.ttl, -1, 'a key without expiry reports PTTL -1');

		const ephemeral = rows.find(row => row._id === 'ephemeral');
		assert.ok(ephemeral && ephemeral.ttl > 0 && ephemeral.ttl <= 100000, `ephemeral ttl should reflect PTTL, got ${ephemeral?.ttl}`);
	})

	it('should sort keys naturally (1, 2, 11 not 1, 11, 2)', async () => {
		await engine.rawQuery('FLUSHALL');
		await engine.rawQuery(['SET', 'item:11', 'k']);
		await engine.rawQuery(['SET', 'item:2', 'k']);
		await engine.rawQuery(['SET', 'item:1', 'k']);

		const columns = await engine.getColumns('string');
		const result = await engine.getRows('string', columns, 100, 0);
		const ids = (result?.rows ?? []).map(row => row._id);

		assert.deepStrictEqual(ids, ['item:1', 'item:2', 'item:11']);
	})

	it('should cap per-key element reads and flag truncation', async () => {
		await engine.rawQuery('FLUSHALL');

		const elementCount = 150;
		const args = ['RPUSH', 'biglist'];
		for (let i = 0; i < elementCount; i++) {
			args.push(`e-${i}`);
		}
		await engine.rawQuery(args);

		const columns = await engine.getColumns('list');
		const result = await engine.getRows('list', columns, 1000, 0);
		const rows = result?.rows ?? [];

		assert.strictEqual(rows.length, 100, 'a single key must not expand beyond the element cap');
		assert.ok(rows.every(row => row._truncated === true), 'capped rows must carry a truncation flag');

		const totalRows = await engine.getTotalRows('list', []);
		assert.strictEqual(totalRows, 100, 'total rows must respect the element cap');
	})

	it('should delete a string key via UNLINK on row-delete', async () => {
		await engine.rawQuery(['SET', 'todelete', 'gone']);
		assert.strictEqual(await engine.rawQuery(['EXISTS', 'todelete']), 1);

		await engine.commitChange({
			type: 'row-delete',
			id: '1',
			tabId: 'abc',
			table: 'string',
			primaryKey: 'todelete',
			primaryKeyColumn: '_id',
		}, undefined as any);

		assert.strictEqual(await engine.rawQuery(['EXISTS', 'todelete']), 0);
	})

	after(async function () {
		await engine.disconnect();
	});
});
