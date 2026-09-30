import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { DynamodbEngine } from '../../../database-engines/dynamodb-engine';
import { Column, DynamodbConfig } from '../../../types';

/**
 * Pre-pull with `docker pull amazon/dynamodb-local:latest` on a new machine; the first download is slow.
 * The container is seeded with the local-datastores seed script (users, orders, events).
 */
const dockerImage = 'amazon/dynamodb-local:latest'

const repoRoot = join(__dirname, '../../../..')
const seedScript = join(repoRoot, '.claude/skills/run-devdb/local-datastores/dynamodb/seed.mjs')

describe('DynamoDB Tests', () => {
	let container: StartedTestContainer;
	let endpoint: string;
	let engine: DynamodbEngine;

	function newEngine(overrides: Partial<DynamodbConfig> = {}): DynamodbEngine {
		return new DynamodbEngine({ name: 'dynamodb-test', type: 'dynamodb', endpoint, region: 'us-east-1', ...overrides })
	}

	async function columnsOf(table: string): Promise<Column[]> {
		return engine.getColumns(table)
	}

	function seed() {
		execFileSync('node', [seedScript], { env: { ...process.env, DYNAMODB_ENDPOINT: endpoint, DEVDB_REPO: repoRoot }, stdio: 'pipe' })
	}

	before(async function () {
		container = await new GenericContainer(dockerImage)
			.withName('devdb-test-container-dynamodb')
			.withCommand(['-jar', 'DynamoDBLocal.jar', '-sharedDb', '-inMemory'])
			.withExposedPorts(8000)
			.withWaitStrategy(Wait.forHttp('/', 8000).forStatusCodeMatching(() => true))
			.withReuse()
			.start();

		endpoint = `http://${container.getHost()}:${container.getMappedPort(8000)}`
		seed()

		engine = newEngine()
		assert.strictEqual(await engine.connect(), true)
	})

	after(async function () {
		await engine?.disconnect()
	})

	it('reports a healthy connection and lists tables', async () => {
		assert.strictEqual(await engine.isOkay(), true)
		assert.deepStrictEqual(await engine.getTables(), ['events', 'orders', 'users'])
	})

	it('fails to connect with a clear message when the endpoint is down', async () => {
		const offline = newEngine({ endpoint: 'http://127.0.0.1:1' })
		await assert.rejects(() => offline.connect(), /Could not reach the DynamoDB endpoint|ECONNREFUSED|connect/i)
	})

	it('puts the partition key first and marks it for a PK-only table', async () => {
		const columns = await columnsOf('users')
		assert.strictEqual(columns[0].name, 'userId')
		assert.strictEqual(columns[0].type, 'S PK')
		assert.strictEqual(columns[0].isPrimaryKey, true)
		assert.strictEqual(columns[0].isEditable, false)

		const types = Object.fromEntries(columns.map(column => [column.name, column.type]))
		assert.deepStrictEqual(
			{ address: types.address, tags: types.tags, scores: types.scores, history: types.history, active: types.active, avatar: types.avatar, bigCounter: types.bigCounter, files: types.files, age: types.age, email: types.email },
			{ address: 'M', tags: 'SS', scores: 'NS', history: 'L', active: 'boolean', avatar: 'B', bigCounter: 'N', files: 'BS', age: 'N', email: 'S' },
		)
		assert.strictEqual(columns.find(column => column.name === 'age')?.isNumeric, true)
		assert.strictEqual(columns.find(column => column.name === 'tags')?.isEditable, false)
		assert.strictEqual(columns.find(column => column.name === 'address')?.isEditable, true)
	})

	it('adds a synthetic _key column for a PK + SK table and marks PK and SK', async () => {
		const columns = await columnsOf('orders')
		assert.deepStrictEqual(columns.slice(0, 3).map(column => [column.name, column.type, column.isPrimaryKey]), [
			['_key', 'key', true],
			['customerId', 'S PK', false],
			['orderId', 'S SK', false],
		])
	})

	it('renders nested maps, lists and sets as JSON, binary as base64 and keeps numbers beyond 2^53 as strings', async () => {
		const response = await engine.getRows('users', await columnsOf('users'), 1, 0, { userId: 'user-001' })
		const row = response!.rows[0]

		assert.strictEqual(row.bigCounter, '12345678901234567890')
		assert.strictEqual(row.age, 21)
		assert.strictEqual(row.active, true)
		assert.deepStrictEqual(JSON.parse(row.address), { city: 'London', zip: '10037', geo: { lat: 6.5244, lng: 3.3792 } })
		assert.deepStrictEqual(JSON.parse(row.history), ['signup', 1, { step: 'verify', ok: true }])
		assert.deepStrictEqual(JSON.parse(row.tags).sort(), ['t1', 't11'])
		assert.deepStrictEqual(JSON.parse(row.scores).sort(), [1, 10])
		assert.strictEqual(Buffer.from(row.avatar, 'base64').toString(), 'DevDb binary \u0000\u0001\u0002')
		assert.deepStrictEqual(JSON.parse(row.files).map((value: string) => Buffer.from(value, 'base64').toString()).sort(), ['a', 'bc'])

		const nullEmail = await engine.getRows('users', await columnsOf('users'), 1, 0, { userId: 'user-005' })
		assert.strictEqual(nullEmail!.rows[0].email, null)
	})

	it('counts exactly for a small table and says the count is not approximate', async () => {
		const columns = await columnsOf('events')
		assert.strictEqual(await engine.getTotalRows('events', columns), 5000)
		const response = await engine.getRows('events', columns, 10, 0)
		assert.strictEqual(response!.stats?.totalRowsApproximate, false)
	})

	it('uses the approximate DescribeTable ItemCount for a table above the exact-count size and says so', async () => {
		const large = new DynamodbEngine({ name: 'dynamodb-test', type: 'dynamodb', endpoint, region: 'us-east-1' }, { exactCountMaxTableBytes: 1 })
		await large.connect()
		const columns = await large.getColumns('events')
		const response = await large.getRows('events', columns, 10, 0)
		assert.strictEqual(response!.stats?.totalRowsApproximate, true)
		assert.strictEqual(typeof await large.getTotalRows('events', columns), 'number')
		await large.disconnect()
	})

	it('pages through 5,000 items with LastEvaluatedKey and never repeats or skips an item', async () => {
		const columns = await columnsOf('events')
		const seen = new Set<string>()
		for (let page = 0; page < 50; page++) {
			const response = await engine.getRows('events', columns, 100, page * 100)
			assert.strictEqual(response!.rows.length, 100, `page ${page + 1}`)
			for (const row of response!.rows) seen.add(row._key)
		}
		assert.strictEqual(seen.size, 5000)

		const pastTheEnd = await engine.getRows('events', columns, 100, 5000)
		assert.strictEqual(pastTheEnd!.rows.length, 0)
	})

	it('jumps to a far page by scanning forward and returns the same items as sequential paging', async () => {
		const sequential = newEngine()
		await sequential.connect()
		const columns = await sequential.getColumns('events')
		for (let page = 0; page < 38; page++) {
			await sequential.getRows('events', columns, 100, page * 100)
		}
		const expected = (await sequential.getRows('events', columns, 100, 3800))!.rows.map(row => row._key)
		await sequential.disconnect()

		const jumper = newEngine()
		await jumper.connect()
		const response = await jumper.getRows('events', columns, 100, 3800)
		await jumper.disconnect()

		assert.deepStrictEqual(response!.rows.map(row => row._key), expected)
		assert.ok((response!.stats?.rowsRead ?? 0) >= 3900, 'a far jump scans forward from the start')
	})

	it('uses Query when the partition key is filtered with equality', async () => {
		const columns = await columnsOf('events')
		const where = { deviceId: 'device-07' }
		assert.strictEqual(await engine.getTotalRows('events', columns, where), 100)

		const response = await engine.getRows('events', columns, 30, 60, where)
		assert.ok(response!.sql!.startsWith('Query events'), response!.sql)
		assert.strictEqual(response!.rows.length, 30)
		assert.ok(response!.rows.every(row => row.deviceId === 'device-07'))
	})

	it('uses begins_with on a string sort key in a Query', async () => {
		const columns = await columnsOf('orders')
		const response = await engine.getRows('orders', columns, 50, 0, { customerId: 'cust-03', orderId: '2026-02' })
		assert.ok(response!.sql!.includes('begins_with'), response!.sql)
		assert.ok(response!.rows.length > 0)
		assert.ok(response!.rows.every(row => row.customerId === 'cust-03' && String(row.orderId).startsWith('2026-02')))
	})

	it('scans with contains() for strings and = for numbers when the partition key is not filtered', async () => {
		const events = await columnsOf('events')
		const warn = { level: 'war' }
		assert.strictEqual(await engine.getTotalRows('events', events, warn), 50 * 33)
		const page = await engine.getRows('events', events, 100, 100, warn)
		assert.ok(page!.sql!.startsWith('Scan events'))
		assert.strictEqual(page!.rows.length, 100)
		assert.ok(page!.rows.every(row => row.level === 'warn'))

		const users = await columnsOf('users')
		const byAge = await engine.getRows('users', users, 10, 0, { age: '25' })
		assert.deepStrictEqual(byAge!.rows.map(row => row.userId), ['user-005'])

		const injection = await engine.getRows('users', users, 10, 0, { name: "x') OR attribute_exists(userId" })
		assert.strictEqual(injection!.rows.length, 0)
	})

	it('updates an attribute by full primary key on PK-only and PK + SK tables', async () => {
		const users = await columnsOf('users')
		await engine.commitChange({ type: 'cell-update', id: 'm1', tabId: 't', table: 'users', column: users.find(c => c.name === 'name')!, newValue: 'Renamed', primaryKeyColumn: 'userId', primaryKey: 'user-002' })
		await engine.commitChange({ type: 'cell-update', id: 'm2', tabId: 't', table: 'users', column: users.find(c => c.name === 'age')!, newValue: '99', primaryKeyColumn: 'userId', primaryKey: 'user-002' })
		await engine.commitChange({ type: 'cell-update', id: 'm3', tabId: 't', table: 'users', column: users.find(c => c.name === 'address')!, newValue: '{"city":"Ibadan","floors":[1,2]}', primaryKeyColumn: 'userId', primaryKey: 'user-002' })
		const user = (await engine.getRows('users', users, 1, 0, { userId: 'user-002' }))!.rows[0]
		assert.strictEqual(user.name, 'Renamed')
		assert.strictEqual(user.age, 99)
		assert.deepStrictEqual(JSON.parse(user.address), { city: 'Ibadan', floors: [1, 2] })

		const orders = await columnsOf('orders')
		const order = (await engine.getRows('orders', orders, 1, 0, { customerId: 'cust-01' }))!.rows[0]
		await engine.commitChange({ type: 'cell-update', id: 'm4', tabId: 't', table: 'orders', column: orders.find(c => c.name === 'status')!, newValue: 'refunded', primaryKeyColumn: '_key', primaryKey: order._key })
		const updated = (await engine.getRows('orders', orders, 1, 0, { customerId: 'cust-01', orderId: order.orderId }))!.rows[0]
		assert.strictEqual(updated.status, 'refunded')
	})

	it('refuses to edit key attributes and to update an item that does not exist', async () => {
		const users = await columnsOf('users')
		await assert.rejects(
			() => engine.commitChange({ type: 'cell-update', id: 'k', tabId: 't', table: 'users', column: users[0], newValue: 'x', primaryKeyColumn: 'userId', primaryKey: 'user-003' }),
			/key attributes cannot be changed/,
		)
		await assert.rejects(
			() => engine.commitChange({ type: 'cell-update', id: 'g', tabId: 't', table: 'users', column: users.find(c => c.name === 'name')!, newValue: 'ghost', primaryKeyColumn: 'userId', primaryKey: 'no-such-user' }),
			/conditional request failed/i,
		)
		const ghost = await engine.getRows('users', users, 1, 0, { userId: 'no-such-user' })
		assert.strictEqual(ghost!.rows.length, 0, 'the condition must stop UpdateItem from creating an item')
	})

	it('deletes an item by its composite key', async () => {
		const events = await columnsOf('events')
		const target = (await engine.getRows('events', events, 1, 0, { deviceId: 'device-50' }))!.rows[0]
		await engine.commitChange({ type: 'row-delete', id: 'd', tabId: 't', table: 'events', primaryKeyColumn: '_key', primaryKey: target._key })

		assert.strictEqual(await engine.getTotalRows('events', events, { deviceId: 'device-50' }), 99)
		await assert.rejects(
			() => engine.commitChange({ type: 'row-delete', id: 'd2', tabId: 't', table: 'events', primaryKeyColumn: '_key', primaryKey: target._key }),
			/conditional request failed/i,
		)
	})

	it('runs PartiQL SELECT and keeps big numbers as strings', async () => {
		const rows = await engine.rawQuery(`SELECT * FROM "users" WHERE "userId" = 'user-001'`, { readOnly: true })
		assert.strictEqual(rows.length, 1)
		assert.strictEqual(rows[0].bigCounter, '12345678901234567890')
	})

	it('refuses PartiQL writes in read-only mode', async () => {
		for (const statement of [
			`INSERT INTO "users" VALUE {'userId': 'evil'}`,
			`UPDATE "users" SET "name" = 'x' WHERE "userId" = 'user-001'`,
			`DELETE FROM "users" WHERE "userId" = 'user-001'`,
			`-- SELECT\nDELETE FROM "users" WHERE "userId" = 'user-001'`,
			`/* SELECT */ DELETE FROM "users" WHERE "userId" = 'user-001'`,
		]) {
			await assert.rejects(() => engine.rawQuery(statement, { readOnly: true }), /Read-only mode/, statement)
		}
		const stillThere = await engine.rawQuery(`SELECT * FROM "users" WHERE "userId" = 'user-001'`, { readOnly: true })
		assert.strictEqual(stillThere.length, 1)
		assert.strictEqual(stillThere[0].name, 'User 1')
	})

	it('runs PartiQL writes when not read-only', async () => {
		await engine.rawQuery(`INSERT INTO "users" VALUE {'userId': 'user-900', 'name': 'Inserted'}`)
		const rows = await engine.rawQuery(`SELECT "name" FROM "users" WHERE "userId" = 'user-900'`)
		assert.deepStrictEqual(rows, [{ name: 'Inserted' }])
	})

	it('cancels a raw query with an AbortSignal', async () => {
		const controller = new AbortController()
		controller.abort()
		await assert.rejects(() => engine.rawQuery(`SELECT * FROM "events"`, { signal: controller.signal }), /abort/i)
	})

	it('describes the table with key schema and GSIs', async () => {
		const description = await engine.getTableCreationSql('orders')
		assert.ok(description.includes('status-index'))
		assert.ok(description.includes('"KeyType": "RANGE"'))
		assert.ok(/approximate/i.test(description))
	})
})
