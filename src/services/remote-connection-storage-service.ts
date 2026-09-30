import * as vscode from 'vscode'
import { redactSecrets, remoteCredentialService } from './remote-credential-service'
import { getRandomString } from './random-string-generator'

export type RemoteConnectionType = 'mysql-ssh' | 'postgres-ssh' | 'mongodb' | 'mysql' | 'postgres' | 'redis' | 'clickhouse' | 'cloudflare-d1' | 'turso'

export const REMOTE_CONNECTION_TYPES: readonly RemoteConnectionType[] = ['mysql-ssh', 'postgres-ssh', 'mongodb', 'mysql', 'postgres', 'redis', 'clickhouse', 'cloudflare-d1', 'turso']

export interface StoredRemoteConnection {
	id: string
	name: string
	type: RemoteConnectionType
	host: string
	port?: number
	username?: string
	database?: string
	sshHost?: string
	sshPort?: number
	sshUsername?: string
	sshPrivateKeyPath?: string
	authSource?: string
	schemaSampleSize?: number
	/**
	 * Display copy only, with any password redacted. The full URI lives in SecretStorage
	 * under the `connectionString` credential.
	 */
	mongoConnectionString?: string
	protocol?: 'http' | 'https'
	/**
	 * Display copy only, with any password redacted. The full URI lives in SecretStorage
	 * under the `connectionString` credential.
	 */
	redisConnectionString?: string
	keyPrefix?: string
	/** Redis/Valkey TLS */
	tls?: boolean
	/** Postgres/MySQL SSL */
	ssl?: boolean
	/** Skip TLS certificate verification (self-signed / private CA) */
	allowUnauthorizedCertificate?: boolean
	/** Cloudflare account id (D1). The D1 database id is kept in `database`; the API token is the `password` secret. */
	accountId?: string
	lastConnected?: string
}

export interface RemoteConnectionListItem {
	id: string
	name: string
	type: string
	host: string
	lastConnected?: string
}

/**
 * Shape of the remote-connection dialog payload (webview -> host) for
 * `request:save-remote-connection` / `request:test-remote-connection`, and of the
 * `response:get-remote-connection` payload (host -> webview).
 */
export interface RemoteConnectionFormData {
	id?: string
	connectionType: 'ssh-tunnel' | 'direct' | 'mongodb' | 'redis' | 'clickhouse' | RemoteConnectionType
	dbEngine?: 'mysql' | 'postgres'
	connectionName: string
	sshHost?: string
	sshPort?: number | string
	sshUsername?: string
	sshPrivateKeyPath?: string
	dbHost?: string
	dbPort?: number | string
	dbUsername?: string
	dbPassword?: string
	dbName?: string
	mongoConnectionString?: string
	redisConnectionString?: string
	keyPrefix?: string
	protocol?: 'http' | 'https'
	tls?: boolean
	ssl?: boolean
	allowUnauthorizedCertificate?: boolean
	/** Cloudflare D1: account id, database id. The API token comes in `dbPassword`. */
	accountId?: string
	databaseId?: string
	/** Turso / libSQL URL. The auth token comes in `dbPassword`. */
	libsqlUrl?: string
}

export interface RemoteConnectionSecrets {
	password?: string
	connectionString?: string
}

const STORAGE_KEY = 'devdb.remoteConnections'

export function resolveRemoteConnectionType(formData: Pick<RemoteConnectionFormData, 'connectionType' | 'dbEngine' | 'dbPort'>): RemoteConnectionType {
	const connectionType = formData.connectionType
	if ((REMOTE_CONNECTION_TYPES as readonly string[]).includes(connectionType)) {
		return connectionType as RemoteConnectionType
	}

	/**
	 * Legacy payloads (no `dbEngine`) inferred the engine from the port.
	 */
	const engine = formData.dbEngine ?? (Number(formData.dbPort) === 5432 ? 'postgres' : 'mysql')

	if (connectionType === 'ssh-tunnel') {
		return engine === 'postgres' ? 'postgres-ssh' : 'mysql-ssh'
	}

	return engine
}

function connectionStringOf(formData: RemoteConnectionFormData, type: RemoteConnectionType): string | undefined {
	const value = type === 'mongodb'
		? formData.mongoConnectionString
		: type === 'redis' ? formData.redisConnectionString : undefined

	return value?.trim() || undefined
}

function toBoolean(value: unknown): boolean | undefined {
	return value === true || value === 'true' ? true : undefined
}

/**
 * Splits an `authToken` query parameter off a libSQL URL, so the token goes to SecretStorage.
 */
export function splitLibsqlUrl(url: string): { url: string, authToken?: string } {
	const match = url.match(/[?&]authToken=([^&#]*)/i)
	if (!match) return { url }

	const stripped = url
		.replace(/([?&])authToken=[^&#]*&?/i, '$1')
		.replace(/[?&]$/, '')

	return { url: stripped, authToken: decodeURIComponent(match[1]) || undefined }
}

function hostFor(formData: RemoteConnectionFormData, type: RemoteConnectionType): string {
	if (type === 'cloudflare-d1') return 'api.cloudflare.com'
	if (type === 'turso') return splitLibsqlUrl(formData.libsqlUrl?.trim() ?? '').url

	return formData.dbHost || 'localhost'
}

/**
 * Converts dialog form data to a stored connection plus the secrets that must go to
 * SecretStorage. The stored connection never holds a password.
 */
export function connectionFromFormData(formData: RemoteConnectionFormData): { connection: StoredRemoteConnection, secrets: RemoteConnectionSecrets } {
	const type = resolveRemoteConnectionType(formData)
	const port = formData.dbPort !== undefined && formData.dbPort !== null && formData.dbPort !== '' ? Number(formData.dbPort) : undefined
	const connectionString = connectionStringOf(formData, type)
	const redacted = connectionString ? redactSecrets(connectionString) : undefined

	const connection: StoredRemoteConnection = {
		id: formData.id || getRandomString('rc-'),
		name: formData.connectionName,
		type,
		host: hostFor(formData, type),
		port: type === 'cloudflare-d1' || type === 'turso' ? undefined : port,
		username: formData.dbUsername || undefined,
		database: type === 'cloudflare-d1'
			? formData.databaseId?.trim() || undefined
			: formData.dbName !== undefined && formData.dbName !== null && String(formData.dbName) !== '' ? String(formData.dbName) : undefined,
		accountId: type === 'cloudflare-d1' ? formData.accountId?.trim() || undefined : undefined,
		sshHost: type.endsWith('-ssh') ? formData.sshHost || undefined : undefined,
		sshPort: type.endsWith('-ssh') && formData.sshPort ? Number(formData.sshPort) : undefined,
		sshUsername: type.endsWith('-ssh') ? formData.sshUsername || undefined : undefined,
		sshPrivateKeyPath: type.endsWith('-ssh') ? formData.sshPrivateKeyPath || undefined : undefined,
		mongoConnectionString: type === 'mongodb' ? redacted : undefined,
		redisConnectionString: type === 'redis' ? redacted : undefined,
		keyPrefix: type === 'redis' ? formData.keyPrefix || undefined : undefined,
		tls: type === 'redis' ? toBoolean(formData.tls) : undefined,
		protocol: type === 'clickhouse' ? formData.protocol || undefined : undefined,
		ssl: type === 'mysql' || type === 'postgres' ? toBoolean(formData.ssl) : undefined,
		allowUnauthorizedCertificate: toBoolean(formData.allowUnauthorizedCertificate),
	}

	for (const key of Object.keys(connection) as (keyof StoredRemoteConnection)[]) {
		if (connection[key] === undefined) delete connection[key]
	}

	return {
		connection,
		secrets: {
			password: formData.dbPassword || (type === 'turso' ? splitLibsqlUrl(formData.libsqlUrl?.trim() ?? '').authToken : undefined) || undefined,
			connectionString,
		},
	}
}

/**
 * Converts a stored connection back to dialog form data for editing. Passwords are
 * never sent back; connection strings are sent in their redacted form.
 */
export function connectionToFormData(stored: StoredRemoteConnection): RemoteConnectionFormData {
	let connectionType: RemoteConnectionFormData['connectionType']
	if (stored.type === 'mysql-ssh' || stored.type === 'postgres-ssh') {
		connectionType = 'ssh-tunnel'
	} else if (stored.type === 'mysql' || stored.type === 'postgres') {
		connectionType = 'direct'
	} else {
		connectionType = stored.type
	}

	const dbEngine = stored.type === 'postgres' || stored.type === 'postgres-ssh'
		? 'postgres'
		: stored.type === 'mysql' || stored.type === 'mysql-ssh' ? 'mysql' : undefined

	return {
		id: stored.id,
		connectionType,
		dbEngine,
		connectionName: stored.name,
		sshHost: stored.sshHost,
		sshPort: stored.sshPort,
		sshUsername: stored.sshUsername,
		sshPrivateKeyPath: stored.sshPrivateKeyPath,
		dbHost: stored.host,
		dbPort: stored.port,
		dbUsername: stored.username,
		dbName: stored.database,
		mongoConnectionString: stored.mongoConnectionString,
		redisConnectionString: stored.redisConnectionString,
		keyPrefix: stored.keyPrefix,
		protocol: stored.protocol,
		tls: stored.tls ?? false,
		ssl: stored.ssl ?? false,
		allowUnauthorizedCertificate: stored.allowUnauthorizedCertificate ?? false,
		accountId: stored.type === 'cloudflare-d1' ? stored.accountId : undefined,
		databaseId: stored.type === 'cloudflare-d1' ? stored.database : undefined,
		libsqlUrl: stored.type === 'turso' ? stored.host : undefined,
	}
}

function listHostOf(connection: StoredRemoteConnection): string {
	if (connection.type === 'cloudflare-d1') return `D1 ${connection.database ?? ''}`.trim()
	if (connection.sshHost) return `${connection.sshHost} → ${connection.host || '127.0.0.1'}`

	return connection.host || 'localhost'
}

class RemoteConnectionStorageService {
	private context: vscode.ExtensionContext | null = null
	private migration: Promise<void> | null = null

	setExtensionContext(context: vscode.ExtensionContext) {
		this.context = context
		this.migration = null
	}

	private read(): StoredRemoteConnection[] {
		return this.context?.globalState.get<StoredRemoteConnection[]>(STORAGE_KEY, []) ?? []
	}

	async getAll(): Promise<StoredRemoteConnection[]> {
		if (!this.context) return []

		if (!this.migration) {
			this.migration = this.migrate().catch((error) => {
				this.migration = null
				throw error
			})
		}
		await this.migration

		return this.read()
	}

	/**
	 * One-time (per session) upgrade of entries written by older versions: moves name-keyed
	 * secrets to id-keyed ones and moves credential-bearing connection strings out of globalState.
	 */
	private async migrate(): Promise<void> {
		if (!this.context) return

		const connections = this.read().map(connection => ({ ...connection }))
		let changed = false

		for (const connection of connections) {
			await remoteCredentialService.migrateLegacyCredentials(connection.id, connection.name)

			for (const field of ['mongoConnectionString', 'redisConnectionString'] as const) {
				const value = connection[field]
				if (!value) continue

				const redacted = redactSecrets(value)
				if (redacted === value) continue

				await remoteCredentialService.storeCredential(connection.id, 'connectionString', value)
				connection[field] = redacted
				changed = true
			}
		}

		if (changed) {
			await this.context.globalState.update(STORAGE_KEY, connections)
		}
	}

	async getListItems(): Promise<RemoteConnectionListItem[]> {
		const connections = await this.getAll()
		return connections.map(conn => ({
			id: conn.id,
			name: conn.name,
			type: conn.type,
			host: listHostOf(conn),
			lastConnected: conn.lastConnected,
		}))
	}

	/**
	 * Persists a connection. A `password`/`connectionString` value replaces the stored secret;
	 * `undefined` keeps the current secret. Pass `connectionString: null` to remove it.
	 */
	async save(connection: StoredRemoteConnection, secrets: { password?: string, connectionString?: string | null } = {}): Promise<StoredRemoteConnection> {
		if (!this.context) throw new Error('Extension context not set')

		const toStore: StoredRemoteConnection = { ...connection }
		for (const field of ['mongoConnectionString', 'redisConnectionString'] as const) {
			if (toStore[field]) toStore[field] = redactSecrets(toStore[field] as string)
		}

		const connections = await this.getAll()
		const existingIndex = connections.findIndex(c => c.id === toStore.id)

		if (existingIndex >= 0) {
			toStore.lastConnected ??= connections[existingIndex].lastConnected
			connections[existingIndex] = toStore
		} else {
			connections.push(toStore)
		}

		await this.context.globalState.update(STORAGE_KEY, connections)

		if (secrets.password) {
			await remoteCredentialService.storeCredential(toStore.id, 'password', secrets.password)
		}

		if (secrets.connectionString) {
			await remoteCredentialService.storeCredential(toStore.id, 'connectionString', secrets.connectionString)
		} else if (secrets.connectionString === null) {
			await remoteCredentialService.deleteCredential(toStore.id, 'connectionString')
		}

		return toStore
	}

	/**
	 * Returns the secrets for a connection. Falls back to the stored connection string for
	 * entries without a secret (e.g. a URI that never had a password).
	 */
	async getSecrets(connection: StoredRemoteConnection): Promise<RemoteConnectionSecrets> {
		const password = await remoteCredentialService.getCredential(connection.id, 'password')
		const connectionString = await remoteCredentialService.getCredential(connection.id, 'connectionString')
			?? connection.mongoConnectionString
			?? connection.redisConnectionString

		return { password, connectionString }
	}

	/**
	 * Builds the connection for dialog form data and works out its secrets. On edit, an empty
	 * password keeps the stored one, and the unchanged (redacted) connection string keeps the
	 * stored URI. `update` is what {@link save} must write; `effective` is what a connect uses.
	 */
	async prepareFromForm(formData: RemoteConnectionFormData): Promise<{
		connection: StoredRemoteConnection,
		update: { password?: string, connectionString?: string | null },
		effective: RemoteConnectionSecrets,
	}> {
		const existing = formData.id ? await this.getById(formData.id) : undefined
		const { connection, secrets } = connectionFromFormData(formData)
		const stored = existing ? await this.getSecrets(existing) : {}
		const existingDisplay = existing?.mongoConnectionString ?? existing?.redisConnectionString

		const update: { password?: string, connectionString?: string | null } = { password: secrets.password }
		const effective: RemoteConnectionSecrets = { password: secrets.password ?? stored.password }

		if (secrets.connectionString && existingDisplay && secrets.connectionString === existingDisplay) {
			effective.connectionString = stored.connectionString
		} else if (secrets.connectionString) {
			update.connectionString = secrets.connectionString
			effective.connectionString = secrets.connectionString
		} else if (existing) {
			update.connectionString = null
		}

		return { connection, update, effective }
	}

	async delete(connectionId: string): Promise<void> {
		if (!this.context) return

		const connections = await this.getAll()
		const connection = connections.find(c => c.id === connectionId)

		if (connection) {
			await remoteCredentialService.deleteAllCredentials(connection.id, connection.name)
		}

		const filtered = connections.filter(c => c.id !== connectionId)
		await this.context.globalState.update(STORAGE_KEY, filtered)
	}

	async updateLastConnected(connectionId: string): Promise<void> {
		if (!this.context) return

		const connections = await this.getAll()
		const connection = connections.find(c => c.id === connectionId)

		if (connection) {
			connection.lastConnected = new Date().toISOString()
			await this.context.globalState.update(STORAGE_KEY, connections)
		}
	}

	async getById(connectionId: string): Promise<StoredRemoteConnection | undefined> {
		const connections = await this.getAll()
		return connections.find(c => c.id === connectionId)
	}
}

export { RemoteConnectionStorageService }

export const remoteConnectionStorageService = new RemoteConnectionStorageService()
