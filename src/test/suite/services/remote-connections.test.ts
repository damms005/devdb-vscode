import { createFakeExtensionContext } from '../vscode-stub';
import * as assert from 'assert';
import {
	connectionToFormData,
	RemoteConnectionFormData,
	remoteConnectionStorageService,
	StoredRemoteConnection,
} from '../../../services/remote-connection-storage-service';
import { redactSecrets, remoteCredentialService } from '../../../services/remote-credential-service';

const STORAGE_KEY = 'devdb.remoteConnections'

async function saveForm(formData: RemoteConnectionFormData): Promise<StoredRemoteConnection> {
	const { connection, update } = await remoteConnectionStorageService.prepareFromForm(formData)
	return remoteConnectionStorageService.save(connection, update)
}

describe('Remote connection storage', () => {
	let fake: ReturnType<typeof createFakeExtensionContext>

	beforeEach(() => {
		fake = createFakeExtensionContext()
		remoteCredentialService.setExtensionContext(fake.context)
		remoteConnectionStorageService.setExtensionContext(fake.context)
	})

	function storedRaw(): StoredRemoteConnection[] {
		return fake.globalState.get(STORAGE_KEY) as StoredRemoteConnection[]
	}

	const cases: { title: string, form: RemoteConnectionFormData, type: StoredRemoteConnection['type'], expected: Partial<RemoteConnectionFormData> }[] = [
		{
			title: 'direct MySQL',
			form: { connectionType: 'direct', dbEngine: 'mysql', connectionName: 'my', dbHost: 'db.local', dbPort: 3307, dbUsername: 'root', dbPassword: 'secret', dbName: 'app' },
			type: 'mysql',
			expected: { connectionType: 'direct', dbEngine: 'mysql', dbPort: 3307, dbName: 'app', ssl: false },
		},
		{
			title: 'direct Postgres on a non-default port with SSL and self-signed cert',
			form: { connectionType: 'direct', dbEngine: 'postgres', connectionName: 'pg', dbHost: 'pg.local', dbPort: 6543, dbUsername: 'postgres', dbPassword: 'secret', dbName: 'app', ssl: true, allowUnauthorizedCertificate: true },
			type: 'postgres',
			expected: { connectionType: 'direct', dbEngine: 'postgres', dbPort: 6543, ssl: true, allowUnauthorizedCertificate: true },
		},
		{
			title: 'SSH tunnel to MySQL',
			form: { connectionType: 'ssh-tunnel', dbEngine: 'mysql', connectionName: 'ssh-my', sshHost: 'bastion', sshPort: 2222, sshUsername: 'ubuntu', sshPrivateKeyPath: '~/.ssh/id', dbHost: '127.0.0.1', dbPort: 3306, dbUsername: 'root', dbPassword: 'secret', dbName: 'app' },
			type: 'mysql-ssh',
			expected: { connectionType: 'ssh-tunnel', dbEngine: 'mysql', sshHost: 'bastion', sshPort: 2222, sshUsername: 'ubuntu', sshPrivateKeyPath: '~/.ssh/id' },
		},
		{
			title: 'SSH tunnel to Postgres on a non-default port',
			form: { connectionType: 'ssh-tunnel', dbEngine: 'postgres', connectionName: 'ssh-pg', sshHost: 'bastion', sshUsername: 'ubuntu', dbHost: '127.0.0.1', dbPort: 6432, dbUsername: 'postgres', dbName: 'app' },
			type: 'postgres-ssh',
			expected: { connectionType: 'ssh-tunnel', dbEngine: 'postgres', dbPort: 6432 },
		},
		{
			title: 'MongoDB with a credential-bearing URI',
			form: { connectionType: 'mongodb', connectionName: 'mongo', mongoConnectionString: 'mongodb+srv://alice:s3cret@cluster0.example.net/app' },
			type: 'mongodb',
			expected: { connectionType: 'mongodb', mongoConnectionString: 'mongodb+srv://alice:****@cluster0.example.net/app' },
		},
		{
			title: 'Redis with URI, key prefix and TLS',
			form: { connectionType: 'redis', connectionName: 'cache', redisConnectionString: 'rediss://default:s3cret@cache.example.net:6380/2', keyPrefix: 'app:', tls: true, dbName: '2' },
			type: 'redis',
			expected: { connectionType: 'redis', redisConnectionString: 'rediss://default:****@cache.example.net:6380/2', keyPrefix: 'app:', tls: true, dbName: '2' },
		},
		{
			title: 'ClickHouse over https',
			form: { connectionType: 'clickhouse', connectionName: 'olap', dbHost: 'ch.example.net', dbPort: 8443, dbUsername: 'default', dbPassword: 'secret', dbName: 'analytics', protocol: 'https' },
			type: 'clickhouse',
			expected: { connectionType: 'clickhouse', protocol: 'https', dbPort: 8443, dbName: 'analytics' },
		},
	]

	for (const testCase of cases) {
		it(`round-trips ${testCase.title}`, async () => {
			const saved = await saveForm(testCase.form)
			assert.strictEqual(saved.type, testCase.type)

			const raw = JSON.stringify(storedRaw())
			assert.ok(!raw.includes('s3cret'), 'globalState must not hold passwords')
			assert.ok(!raw.includes('"secret"'), 'globalState must not hold passwords')

			const loaded = await remoteConnectionStorageService.getById(saved.id)
			assert.ok(loaded)
			const form = connectionToFormData(loaded!)
			assert.strictEqual(form.connectionName, testCase.form.connectionName)
			for (const [key, value] of Object.entries(testCase.expected)) {
				assert.deepStrictEqual((form as any)[key], value, key)
			}
			assert.strictEqual((form as any).dbPassword, undefined)

			const secrets = await remoteConnectionStorageService.getSecrets(loaded!)
			assert.strictEqual(secrets.password, testCase.form.dbPassword)
			assert.strictEqual(secrets.connectionString, testCase.form.mongoConnectionString ?? testCase.form.redisConnectionString)
		})
	}

	it('keeps the stored password and URI when an edit sends them back empty/redacted', async () => {
		const saved = await saveForm({ connectionType: 'redis', connectionName: 'cache', redisConnectionString: 'redis://u:s3cret@h:6379', dbPassword: 'pw' })
		const form = connectionToFormData((await remoteConnectionStorageService.getById(saved.id))!)

		await saveForm({ ...form, connectionName: 'renamed', dbPassword: '' })

		const loaded = (await remoteConnectionStorageService.getById(saved.id))!
		assert.strictEqual(loaded.name, 'renamed')
		const secrets = await remoteConnectionStorageService.getSecrets(loaded)
		assert.strictEqual(secrets.password, 'pw')
		assert.strictEqual(secrets.connectionString, 'redis://u:s3cret@h:6379')
	})

	it('keys secrets by connection id, not name', async () => {
		const saved = await saveForm({ connectionType: 'direct', dbEngine: 'postgres', connectionName: 'pg', dbPassword: 'pw' })
		assert.strictEqual(fake.secrets.get(`devdb.connection.${saved.id}.password`), 'pw')
		assert.strictEqual(fake.secrets.get('devdb.pg.password'), undefined)

		await remoteConnectionStorageService.delete(saved.id)
		assert.strictEqual(fake.secrets.size, 0)
	})

	it('migrates legacy name-keyed secrets and plaintext connection strings on load', async () => {
		fake.globalState.set(STORAGE_KEY, [
			{ id: 'rc-1', name: 'legacy-mongo', type: 'mongodb', host: 'localhost', mongoConnectionString: 'mongodb://bob:hunter2@db:27017/app' },
			{ id: 'rc-2', name: 'legacy-pg', type: 'postgres', host: 'localhost', port: 5432 },
		])
		fake.secrets.set('devdb.legacy-pg.password', 'pgpass')

		const all = await remoteConnectionStorageService.getAll()

		assert.strictEqual(all[0].mongoConnectionString, 'mongodb://bob:****@db:27017/app')
		assert.ok(!JSON.stringify(fake.globalState.get(STORAGE_KEY)).includes('hunter2'))
		assert.strictEqual(fake.secrets.get('devdb.connection.rc-1.connectionString'), 'mongodb://bob:hunter2@db:27017/app')
		assert.strictEqual(fake.secrets.get('devdb.connection.rc-2.password'), 'pgpass')
		assert.strictEqual(fake.secrets.get('devdb.legacy-pg.password'), undefined)
		assert.strictEqual((await remoteConnectionStorageService.getSecrets(all[1])).password, 'pgpass')
	})

	it('infers the engine from the port for legacy payloads without dbEngine', async () => {
		const pg = await saveForm({ connectionType: 'direct', connectionName: 'a', dbPort: 5432 })
		const my = await saveForm({ connectionType: 'ssh-tunnel', connectionName: 'b', dbPort: 3306 })
		assert.strictEqual(pg.type, 'postgres')
		assert.strictEqual(my.type, 'mysql-ssh')
	})

	it('redacts passwords in URIs and DSN parameters', () => {
		assert.strictEqual(redactSecrets('redis://:p%40ss@host:6379/0'), 'redis://:****@host:6379/0')
		assert.strictEqual(redactSecrets('failed for postgres://u:pw@h/db?password=x&a=1'), 'failed for postgres://u:****@h/db?password=****&a=1')
		assert.strictEqual(redactSecrets('redis://host:6379'), 'redis://host:6379')
	})
})
