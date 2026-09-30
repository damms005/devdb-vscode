import { createFakeExtensionContext } from '../vscode-stub';
import * as assert from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import {
	assertReadOnlyPartiql,
	cellValueToAttribute,
	describeDynamodbError,
	dynamodbClientConfig,
	DYNAMODB_LOCAL_ACCESS_KEY_ID,
	numberFromText,
	parsePrimaryKey,
	renderAttribute,
} from '../../../database-engines/dynamodb-engine';
import { findDynamodbEndpointInEnv, findDynamodbEndpointsInCompose, publishedPortFor } from '../../../providers/dynamodb/dynamodb-local-detection';
import { listAwsProfiles } from '../../../services/aws-profiles';
import { validateQuery } from '../../../services/mcp/query-validator';
import { connectionToFormData, RemoteConnectionFormData, remoteConnectionStorageService } from '../../../services/remote-connection-storage-service';
import { remoteCredentialService } from '../../../services/remote-credential-service';
import { createRemoteEngine, proFeatureOf, testRemoteConnection } from '../../../services/connection-tester';
import { PRO_ENGINE_TYPES, PRO_PROVIDER_IDS, setProLicenseChecker } from '../../../services/pro-gate';

describe('DynamoDB support', () => {
	describe('values', () => {
		it('keeps numbers a double cannot hold exactly as strings', () => {
			assert.strictEqual(numberFromText('42'), 42)
			assert.strictEqual(numberFromText('-3.5'), -3.5)
			assert.strictEqual(numberFromText('9007199254740991'), 9007199254740991)
			assert.strictEqual(numberFromText('9007199254740993'), '9007199254740993')
			assert.strictEqual(numberFromText('0.10000000000000000001'), '0.10000000000000000001')
		})

		it('renders nested values as JSON and binary as base64', () => {
			assert.strictEqual(renderAttribute({ M: { a: { N: '12345678901234567890' }, b: { L: [{ BOOL: true }, { NULL: true }] } } }), '{"a":"12345678901234567890","b":[true,null]}')
			assert.strictEqual(renderAttribute({ SS: ['x', 'y'] }), '["x","y"]')
			assert.strictEqual(renderAttribute({ B: Buffer.from('hi') }), 'aGk=')
		})

		it('converts cell edits to attribute values and rejects bad input', () => {
			assert.deepStrictEqual(cellValueToAttribute('N', '12345678901234567890'), { N: '12345678901234567890' })
			assert.deepStrictEqual(cellValueToAttribute('BOOL', 'false'), { BOOL: false })
			assert.deepStrictEqual(cellValueToAttribute('M', '{"a":[1,"b"]}'), { M: { a: { L: [{ N: '1' }, { S: 'b' }] } } })
			assert.deepStrictEqual(cellValueToAttribute('S', null), { NULL: true })
			assert.throws(() => cellValueToAttribute('N', 'abc'), /not a number/)
			assert.throws(() => cellValueToAttribute('M', '[1]'), /JSON object/)
			assert.throws(() => cellValueToAttribute('SS', '["a"]'), /not supported/)
		})

		it('parses simple and composite primary keys with their key types', () => {
			assert.deepStrictEqual(parsePrimaryKey({ partition: { name: 'id', type: 'N' } }, 7), { id: { N: '7' } })
			assert.deepStrictEqual(
				parsePrimaryKey({ partition: { name: 'pk', type: 'S' }, sort: { name: 'ts', type: 'N' } }, '{"pk":"a","ts":"12345678901234567890"}'),
				{ pk: { S: 'a' }, ts: { N: '12345678901234567890' } },
			)
			assert.throws(() => parsePrimaryKey({ partition: { name: 'pk', type: 'S' }, sort: { name: 'sk', type: 'S' } }, '{"pk":"a"}'), /composite key/)
		})
	})

	describe('read-only PartiQL', () => {
		it('allows SELECT and refuses writes, also behind comments', () => {
			assert.doesNotThrow(() => assertReadOnlyPartiql(`SELECT * FROM "t" WHERE a = 'DELETE; x'`))
			for (const statement of [`INSERT INTO "t" VALUE {'a': 1}`, `update "t" SET a = 1 WHERE b = 2`, `DELETE FROM "t" WHERE a = 1`, `-- SELECT\nDELETE FROM "t" WHERE a = 1`, `EXISTS(SELECT * FROM "t" WHERE a = 1)`, `SELECT 1; DELETE FROM "t" WHERE a = 1`]) {
				assert.throws(() => assertReadOnlyPartiql(statement), /Read-only mode/, statement)
			}
		})

		it('has MCP validator rules for dynamodb', () => {
			assert.deepStrictEqual(validateQuery(`SELECT * FROM "users"`, 'dynamodb'), { allowed: true })
			const blocked = validateQuery(`DELETE FROM "users" WHERE "userId" = 'a'`, 'dynamodb')
			assert.strictEqual(blocked.allowed, false)
			assert.match(blocked.warning!, /read-only/)
			const allowed = validateQuery(`UPDATE "users" SET "a" = 1 WHERE "userId" = 'a'`, 'dynamodb', { allowWrites: true })
			assert.strictEqual(allowed.allowed, true)
			assert.strictEqual(allowed.destructive, true)
			assert.strictEqual(validateQuery(`EXISTS(SELECT * FROM "users")`, 'dynamodb', { allowWrites: true }).allowed, false)
			assert.strictEqual(validateQuery(`SELECT * FROM "a"; DELETE FROM "a" WHERE x = 1`, 'dynamodb', { allowWrites: true }).allowed, false)
			assert.strictEqual(validateQuery(`/* SELECT */ INSERT INTO "a" VALUE {'x': 1}`, 'dynamodb').allowed, false)
		})
	})

	describe('credentials', () => {
		it('uses a profile, static keys, or dummy keys for a custom endpoint', () => {
			assert.strictEqual(dynamodbClientConfig({ name: 'a', type: 'dynamodb', region: 'eu-west-1', authMethod: 'profile', profile: 'dev' }).profile, 'dev')

			const keys = dynamodbClientConfig({ name: 'a', type: 'dynamodb', region: 'eu-west-1', authMethod: 'keys', accessKeyId: 'AKIA1', secretAccessKey: 's3cret', sessionToken: 'tok' })
			assert.deepStrictEqual(keys.credentials, { accessKeyId: 'AKIA1', secretAccessKey: 's3cret', sessionToken: 'tok' })
			assert.strictEqual(keys.profile, undefined)

			const local = dynamodbClientConfig({ name: 'a', type: 'dynamodb', endpoint: 'http://localhost:8000' })
			assert.deepStrictEqual(local.credentials, { accessKeyId: DYNAMODB_LOCAL_ACCESS_KEY_ID, secretAccessKey: DYNAMODB_LOCAL_ACCESS_KEY_ID })
			assert.strictEqual(local.region, 'us-east-1')
		})

		it('tells the user to run aws sso login when the SSO session expired, and never shows keys', () => {
			const sso = new Error('The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.')
			sso.name = 'CredentialsProviderError'
			assert.strictEqual(describeDynamodbError(sso, { profile: 'work' }), 'The AWS SSO session for profile "work" has expired or is missing. Run `aws sso login --profile work` and connect again.')

			const leaked = describeDynamodbError(new Error('bad signature for AKIASECRET with s3cretkey'), { accessKeyId: 'AKIASECRET', secretAccessKey: 's3cretkey' })
			assert.ok(!leaked.includes('AKIASECRET') && !leaked.includes('s3cretkey'), leaked)
		})

		it('lists AWS profiles from config and credentials files without key values', () => {
			const home = mkdtempSync(join(tmpdir(), 'devdb-aws-'))
			try {
				mkdirSync(join(home, '.aws'))
				writeFileSync(join(home, '.aws', 'config'), '[default]\nregion = us-east-1\n\n[profile work]\nsso_session = corp\nregion = eu-west-2\n\n[sso-session corp]\nsso_start_url = https://corp.awsapps.com/start\n')
				writeFileSync(join(home, '.aws', 'credentials'), '[default]\naws_access_key_id = AKIADEFAULT\naws_secret_access_key = hidden\n\n[ci]\naws_access_key_id = AKIACI\n')

				const profiles = listAwsProfiles({}, home)
				assert.deepStrictEqual(profiles, [
					{ name: 'default', region: 'us-east-1', sso: false },
					{ name: 'ci', region: undefined, sso: false },
					{ name: 'work', region: 'eu-west-2', sso: true },
				])
				assert.ok(!JSON.stringify(profiles).includes('AKIA'))
			} finally {
				rmSync(home, { recursive: true, force: true })
			}
		})
	})

	describe('zero-config detection', () => {
		it('finds DynamoDB Local and LocalStack (with DynamoDB) in a compose file', () => {
			const compose = `
services:
  dynamo:
    image: amazon/dynamodb-local:2.5.2
    ports: ["8001:8000"]
  stack:
    image: localstack/localstack:3
    environment:
      - SERVICES=s3,dynamodb
      - AWS_DEFAULT_REGION=eu-central-1
    ports:
      - "127.0.0.1:4566:4566"
  s3only:
    image: localstack/localstack
    environment: { SERVICES: s3 }
    ports: ["4567:4566"]
  unpublished:
    image: amazon/dynamodb-local
  db:
    image: postgres:16
    ports: ["5432:5432"]
`
			assert.deepStrictEqual(findDynamodbEndpointsInCompose(compose, 'compose.yml'), [
				{ endpoint: 'http://localhost:8001', source: 'compose.yml service "dynamo"', region: undefined },
				{ endpoint: 'http://localhost:4566', source: 'compose.yml service "stack"', region: 'eu-central-1' },
			])
			assert.deepStrictEqual(findDynamodbEndpointsInCompose('not: [valid'), [])
		})

		it('reads published ports in short and long syntax', () => {
			assert.strictEqual(publishedPortFor([{ target: 8000, published: '9000' }], 8000), 9000)
			assert.strictEqual(publishedPortFor(['8000/tcp'], 8000), undefined)
			assert.strictEqual(publishedPortFor(['0.0.0.0:18000:8000'], 8000), 18000)
		})

		it('reads the endpoint from .env and keeps local keys only for loopback endpoints', () => {
			const local = findDynamodbEndpointInEnv('AWS_ENDPOINT_URL_DYNAMODB=http://127.0.0.1:8000\nAWS_REGION=eu-west-1\nAWS_ACCESS_KEY_ID=local\nAWS_SECRET_ACCESS_KEY=local\n')
			assert.deepStrictEqual(local, { endpoint: 'http://127.0.0.1:8000', source: '.env AWS_ENDPOINT_URL_DYNAMODB', region: 'eu-west-1', accessKeyId: 'local', secretAccessKey: 'local' })

			const remote = findDynamodbEndpointInEnv('DYNAMODB_ENDPOINT=https://dynamo.internal.example.com\nAWS_ACCESS_KEY_ID=AKIA\nAWS_SECRET_ACCESS_KEY=x\n')
			assert.strictEqual(remote?.accessKeyId, undefined)
			assert.strictEqual(findDynamodbEndpointInEnv('DATABASE_URL=postgres://x'), undefined)
		})
	})

	describe('remote connections', () => {
		let fake: ReturnType<typeof createFakeExtensionContext>
		let licensed = true

		beforeEach(() => {
			licensed = true
			fake = createFakeExtensionContext()
			remoteCredentialService.setExtensionContext(fake.context)
			remoteConnectionStorageService.setExtensionContext(fake.context)
			setProLicenseChecker(() => licensed)
		})

		async function saveForm(formData: RemoteConnectionFormData) {
			const { connection, update } = await remoteConnectionStorageService.prepareFromForm(formData)
			return remoteConnectionStorageService.save(connection, update)
		}

		it('is a Pro datastore', () => {
			assert.strictEqual(proFeatureOf({ type: 'dynamodb', host: 'x' }), 'DynamoDB')
			assert.ok(PRO_ENGINE_TYPES.includes('dynamodb'))
			assert.ok(PRO_PROVIDER_IDS.includes('dynamodb-local'))
		})

		it('stores access keys in SecretStorage only and keeps them on an edit with empty fields', async () => {
			const saved = await saveForm({ connectionType: 'dynamodb', connectionName: 'prod', awsRegion: 'eu-west-1', awsAuthMethod: 'keys', awsAccessKeyId: 'AKIAEXAMPLE', awsSecretAccessKey: 's3cret', awsSessionToken: 'tok3n' })

			const raw = JSON.stringify(fake.globalState.get('devdb.remoteConnections'))
			for (const secret of ['AKIAEXAMPLE', 's3cret', 'tok3n']) assert.ok(!raw.includes(secret), secret)
			assert.strictEqual(saved.host, 'dynamodb.eu-west-1')

			const form = connectionToFormData(saved)
			assert.strictEqual(form.connectionType, 'dynamodb')
			assert.strictEqual(form.awsRegion, 'eu-west-1')
			assert.strictEqual(form.awsAuthMethod, 'keys')
			assert.strictEqual((form as any).awsSecretAccessKey, undefined)

			await saveForm({ ...form, connectionName: 'prod-renamed' })
			const secrets = await remoteConnectionStorageService.getSecrets((await remoteConnectionStorageService.getById(saved.id))!)
			assert.deepStrictEqual(secrets, { password: 's3cret', awsAccessKeyId: 'AKIAEXAMPLE', awsSessionToken: 'tok3n' })

			await saveForm({ ...form, awsAccessKeyId: 'AKIANEW', awsSecretAccessKey: 'n3w' })
			const rotated = await remoteConnectionStorageService.getSecrets(saved)
			assert.deepStrictEqual(rotated, { password: 'n3w', awsAccessKeyId: 'AKIANEW', awsSessionToken: undefined })
		})

		it('removes stored keys when the connection switches to a profile', async () => {
			const saved = await saveForm({ connectionType: 'dynamodb', connectionName: 'dev', awsRegion: 'us-east-1', awsAuthMethod: 'keys', awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'x' })
			await saveForm({ ...connectionToFormData(saved), awsAuthMethod: 'profile', awsProfile: 'dev-sso' })

			const loaded = (await remoteConnectionStorageService.getById(saved.id))!
			assert.strictEqual(loaded.awsProfile, 'dev-sso')
			assert.strictEqual(fake.secrets.size, 0)
		})

		it('refuses to open DynamoDB without a Pro license', async () => {
			licensed = false
			const { connection, effective } = await remoteConnectionStorageService.prepareFromForm({ connectionType: 'dynamodb', connectionName: 'x', awsEndpoint: 'http://localhost:8000' })
			const result = await createRemoteEngine(connection, effective)
			assert.match(result.error!, /DevDb Pro required: DynamoDB/)
		})

		describe('against DynamoDB Local', () => {
			let container: StartedTestContainer
			let endpoint: string

			before(async function () {
				container = await new GenericContainer('amazon/dynamodb-local:latest')
					.withName('devdb-test-container-dynamodb')
					.withCommand(['-jar', 'DynamoDBLocal.jar', '-sharedDb', '-inMemory'])
					.withExposedPorts(8000)
					.withWaitStrategy(Wait.forHttp('/', 8000).forStatusCodeMatching(() => true))
					.withReuse()
					.start()
				endpoint = `http://${container.getHost()}:${container.getMappedPort(8000)}`
			})

			it('tests a connection with a custom endpoint and no keys', async () => {
				const result = await testRemoteConnection({ connectionType: 'dynamodb', connectionName: 'local', awsEndpoint: endpoint, awsAuthMethod: 'keys' })
				assert.deepStrictEqual(result, { success: true, message: 'Connection successful' })
			})

			it('reports an unreachable endpoint', async () => {
				const result = await testRemoteConnection({ connectionType: 'dynamodb', connectionName: 'down', awsEndpoint: 'http://127.0.0.1:1', awsAuthMethod: 'keys' })
				assert.strictEqual(result.success, false)
				assert.match(result.message, /^Failed to connect to DynamoDB: /)
			})
		})
	})
})
