import knexlib from 'knex';
import { createClient as createRedisClient } from 'redis';
import { createClient as createClickhouseClient, ClickHouseLogLevel } from '@clickhouse/client';
import { ClickhouseConfig, DatabaseEngine, DynamodbConfig, MongodbConfig, MysqlSshConfigFile, PostgresSshConfigFile, RedisConfig } from '../types';
import { MongodbEngine } from '../database-engines/mongodb-engine';
import { MysqlEngine } from '../database-engines/mysql-engine';
import { PostgresEngine } from '../database-engines/postgres-engine';
import { MysqlSshEngine } from '../database-engines/mysql-ssh-engine';
import { PostgresSshEngine } from '../database-engines/postgres-ssh-engine';
import { RedisEngine } from '../database-engines/redis-engine';
import { ClickhouseEngine } from '../database-engines/clickhouse-engine';
import { DynamodbEngine } from '../database-engines/dynamodb-engine';
import { errorMessage, remoteCredentialService } from './remote-credential-service';
import { getConnectionFor } from './connector';
import { buildSslPostgresKnexConnection, isNeonConnectionString } from '../providers/postgres/neon-connection-helper';
import { RemoteConnectionFormData, RemoteConnectionSecrets, StoredRemoteConnection, remoteConnectionStorageService } from './remote-connection-storage-service';
import { hasProLicense, proRequiredMessage } from './pro-gate';

const PROBE_TIMEOUT_MS = 10000

export type RemoteEngineResult = { engine: DatabaseEngine, error?: undefined } | { engine?: undefined, error: string }

/**
 * Returns the Pro feature name when the connection needs a DevDb Pro license.
 */
export function proFeatureOf(connection: Pick<StoredRemoteConnection, 'type' | 'host'>): string | undefined {
	if (connection.type === 'redis') return 'Redis / Valkey'
	if (connection.type === 'clickhouse') return 'ClickHouse'
	if (connection.type === 'dynamodb') return 'DynamoDB'
	if ((connection.type === 'postgres' || connection.type === 'postgres-ssh') && isNeonConnectionString(connection.host)) return 'Neon'
	return undefined
}

export function clickhouseProtocolFor(connection: Pick<StoredRemoteConnection, 'protocol' | 'port'>): 'http' | 'https' {
	return connection.protocol ?? (connection.port === 8443 ? 'https' : 'http')
}

/**
 * Opens a database engine for a remote connection. On failure it returns the driver's own
 * error message, with any password in it redacted.
 */
export async function createRemoteEngine(connection: StoredRemoteConnection, secrets: RemoteConnectionSecrets): Promise<RemoteEngineResult> {
	const proFeature = proFeatureOf(connection)
	if (proFeature && !hasProLicense()) {
		return { error: proRequiredMessage(proFeature) }
	}

	const credentials = remoteCredentialService.forConnection(connection.id)

	switch (connection.type) {
		case 'mongodb': {
			const config: MongodbConfig = {
				name: connection.name,
				type: 'mongodb',
				host: connection.host,
				port: connection.port,
				username: connection.username,
				database: connection.database ?? '',
				authSource: connection.authSource,
				schemaSampleSize: connection.schemaSampleSize,
				password: secrets.password,
				connectionString: secrets.connectionString,
			}
			const engine = new MongodbEngine(config)
			if (!(await engine.connect())) {
				return { error: `Failed to connect to MongoDB: ${connection.name}` }
			}
			return { engine }
		}

		case 'mysql-ssh': {
			const config: MysqlSshConfigFile = {
				name: connection.name,
				type: 'mysql-ssh',
				host: connection.host || 'localhost',
				port: connection.port,
				username: connection.username,
				database: connection.database ?? '',
				sshHost: connection.sshHost ?? '',
				sshPort: connection.sshPort,
				sshUsername: connection.sshUsername ?? '',
				sshPrivateKeyPath: connection.sshPrivateKeyPath,
			}
			const engine = new MysqlSshEngine(config, credentials)
			if (!(await engine.connect(secrets.password))) {
				return { error: `Failed to connect via SSH to MySQL: ${connection.name}` }
			}
			return { engine }
		}

		case 'postgres-ssh': {
			const config: PostgresSshConfigFile = {
				name: connection.name,
				type: 'postgres-ssh',
				host: connection.host || 'localhost',
				port: connection.port,
				username: connection.username,
				database: connection.database ?? '',
				sshHost: connection.sshHost ?? '',
				sshPort: connection.sshPort,
				sshUsername: connection.sshUsername ?? '',
				sshPrivateKeyPath: connection.sshPrivateKeyPath,
			}
			const engine = new PostgresSshEngine(config, credentials)
			if (!(await engine.connect(secrets.password))) {
				return { error: `Failed to connect via SSH to PostgreSQL: ${connection.name}` }
			}
			return { engine }
		}

		case 'mysql':
		case 'postgres':
			return createDirectSqlEngine(connection, secrets)

		case 'redis':
			return createRedisEngine(connection, secrets)

		case 'clickhouse':
			return createClickhouseEngine(connection, secrets)

		case 'dynamodb':
			return createDynamodbEngine(connection, secrets)
	}

	return { error: `Unsupported connection type: ${connection.type}` }
}

function buildDirectSqlKnex(connection: StoredRemoteConnection, password: string): Promise<knexlib.Knex | undefined> | knexlib.Knex {
	const isPostgres = connection.type === 'postgres'
	const details = {
		host: connection.host || 'localhost',
		port: connection.port ?? (isPostgres ? 5432 : 3306),
		user: connection.username ?? (isPostgres ? 'postgres' : 'root'),
		password,
		database: connection.database ?? '',
	}

	if (connection.ssl === true) {
		if (isPostgres) {
			return buildSslPostgresKnexConnection(details, { allowUnauthorizedCertificate: connection.allowUnauthorizedCertificate === true })
		}

		return knexlib({
			client: 'mysql2',
			connection: {
				...details,
				database: details.database || undefined,
				ssl: { rejectUnauthorized: connection.allowUnauthorizedCertificate !== true },
			},
		})
	}

	return getConnectionFor(
		connection.name, isPostgres ? 'postgres' : 'mysql2',
		details.host, details.port,
		details.user, password,
		connection.database, false
	)
}

async function createDirectSqlEngine(connection: StoredRemoteConnection, secrets: RemoteConnectionSecrets): Promise<RemoteEngineResult> {
	const label = connection.type === 'postgres' ? 'PostgreSQL' : 'MySQL'
	const knex = await buildDirectSqlKnex(connection, secrets.password ?? '')
	if (!knex) {
		return { error: `Failed to connect to ${label}: ${connection.name}` }
	}

	try {
		await knex.raw('select 1')
	} catch (error) {
		await knex.destroy().catch(() => { })
		return { error: `Failed to connect to ${label}: ${errorMessage(error)}` }
	}

	const engine = connection.type === 'postgres' ? new PostgresEngine(knex) : new MysqlEngine(knex)
	if (!(await engine.isOkay())) {
		await knex.destroy().catch(() => { })
		return { error: `${label} connection not healthy: ${connection.name}` }
	}

	return { engine }
}

function redisConfigFor(connection: StoredRemoteConnection, secrets: RemoteConnectionSecrets): RedisConfig {
	return {
		name: connection.name,
		type: 'redis',
		host: connection.host,
		port: connection.port,
		username: connection.username,
		database: connection.database !== undefined && connection.database !== '' ? Number(connection.database) : undefined,
		keyPrefix: connection.keyPrefix,
		tls: connection.tls,
		password: secrets.password,
		connectionString: secrets.connectionString,
	}
}

/**
 * Connects once with reconnects disabled so an unreachable server or bad credentials fail
 * fast with the driver's message, instead of the engine's silent retry loop.
 */
async function probeRedis(config: RedisConfig): Promise<string | undefined> {
	const socket: Record<string, any> = { reconnectStrategy: false, connectTimeout: PROBE_TIMEOUT_MS }
	const client = config.connectionString
		? createRedisClient({ url: config.connectionString, socket })
		: createRedisClient({
			socket: { ...socket, host: config.host ?? 'localhost', port: config.port ?? 6379, ...(config.tls === true ? { tls: true } : {}) },
			username: config.username,
			password: config.password,
			database: config.database ?? 0,
		})

	client.on('error', () => { })

	try {
		await client.connect()
		await client.ping()
		return undefined
	} catch (error) {
		return errorMessage(error)
	} finally {
		try { client.destroy() } catch { }
	}
}

async function createRedisEngine(connection: StoredRemoteConnection, secrets: RemoteConnectionSecrets): Promise<RemoteEngineResult> {
	const config = redisConfigFor(connection, secrets)

	const probeError = await probeRedis(config)
	if (probeError) {
		return { error: `Failed to connect to Redis: ${probeError}` }
	}

	const engine = new RedisEngine(config)
	if (!(await engine.connect())) {
		return { error: `Failed to connect to Redis: ${connection.name}` }
	}

	return { engine }
}

/**
 * ClickHouse's `/ping` does not check credentials, so run a real query to validate them.
 */
async function probeClickhouse(config: ClickhouseConfig): Promise<string | undefined> {
	const client = createClickhouseClient({
		url: `${config.protocol ?? 'http'}://${config.host ?? 'localhost'}:${config.port ?? 8123}`,
		username: config.username ?? 'default',
		password: config.password ?? '',
		database: config.database ?? 'default',
		request_timeout: PROBE_TIMEOUT_MS,
		log: { level: ClickHouseLogLevel.OFF },
	})

	try {
		const result = await client.query({ query: 'SELECT 1', format: 'JSONEachRow' })
		await result.json()
		return undefined
	} catch (error) {
		return errorMessage(error)
	} finally {
		await client.close().catch(() => { })
	}
}

async function createClickhouseEngine(connection: StoredRemoteConnection, secrets: RemoteConnectionSecrets): Promise<RemoteEngineResult> {
	const config: ClickhouseConfig = {
		name: connection.name,
		type: 'clickhouse',
		host: connection.host || 'localhost',
		port: connection.port ?? 8123,
		protocol: clickhouseProtocolFor(connection),
		username: connection.username ?? 'default',
		database: connection.database ?? 'default',
		password: secrets.password,
	}

	const probeError = await probeClickhouse(config)
	if (probeError) {
		return { error: `Failed to connect to ClickHouse: ${probeError}` }
	}

	const engine = new ClickhouseEngine(config)
	if (!(await engine.connect())) {
		return { error: `Failed to connect to ClickHouse: ${connection.name}` }
	}

	return { engine }
}

export function dynamodbConfigFor(connection: StoredRemoteConnection, secrets: RemoteConnectionSecrets): DynamodbConfig {
	return {
		name: connection.name,
		type: 'dynamodb',
		region: connection.awsRegion,
		endpoint: connection.awsEndpoint,
		authMethod: connection.awsAuthMethod ?? 'profile',
		profile: connection.awsProfile,
		accessKeyId: secrets.awsAccessKeyId,
		secretAccessKey: secrets.password,
		sessionToken: secrets.awsSessionToken,
	}
}

async function createDynamodbEngine(connection: StoredRemoteConnection, secrets: RemoteConnectionSecrets): Promise<RemoteEngineResult> {
	const config = dynamodbConfigFor(connection, secrets)
	if (config.authMethod === 'keys' && (!config.accessKeyId || !config.secretAccessKey) && !config.endpoint) {
		return { error: 'Failed to connect to DynamoDB: enter an access key ID and a secret access key' }
	}

	const engine = new DynamodbEngine(config)
	try {
		await engine.connect()
	} catch (error) {
		return { error: `Failed to connect to DynamoDB: ${errorMessage(error)}` }
	}

	return { engine }
}

export async function testRemoteConnection(formData: RemoteConnectionFormData): Promise<{ success: boolean; message: string }> {
	try {
		const { connection, effective } = await remoteConnectionStorageService.prepareFromForm(formData)
		const result = await createRemoteEngine(connection, effective)

		if (!result.engine) {
			return { success: false, message: result.error }
		}

		try { await result.engine.disconnect() } catch { }

		return { success: true, message: 'Connection successful' }
	} catch (error) {
		return { success: false, message: errorMessage(error) }
	}
}
