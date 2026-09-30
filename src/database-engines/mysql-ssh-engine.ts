import knexlib from 'knex'
import { Column, DatabaseEngine, KnexClient, MysqlSshConfigFile, QueryResponse, RawQueryOptions, SerializedMutation } from '../types'
import { MysqlEngine } from './mysql-engine'
import { SQLiteTransaction } from './sqlite-engine'
import { createSshTunnel, SshHostKeyVerifier, SshTunnel } from '../services/ssh-tunnel-service'
import { promptToTrustSshHostKey } from '../services/ssh-host-key-prompt'
import { RemoteCredentialService } from '../services/remote-credential-service'
import { getConnectionFor } from '../services/connector'
import * as fs from 'fs'
import * as os from 'os'

export class MysqlSshEngine implements DatabaseEngine {
	private tunnel: SshTunnel | null = null
	private wrappedEngine: MysqlEngine | null = null
	private config: MysqlSshConfigFile
	private credentialService: RemoteCredentialService
	private verifyHostKey: SshHostKeyVerifier

	/**
	 * @param verifyHostKey asked to trust a host key that is not in known_hosts; defaults to a VS Code modal.
	 */
	constructor(config: MysqlSshConfigFile, credentialService: RemoteCredentialService, verifyHostKey: SshHostKeyVerifier = promptToTrustSshHostKey) {
		this.config = config
		this.credentialService = credentialService
		this.verifyHostKey = verifyHostKey
	}

	async connect(dbPassword?: string): Promise<boolean> {
		const password = dbPassword
			?? await this.credentialService.getCredential(this.config.name, 'password')
			?? await this.credentialService.promptForCredential(this.config.name, 'password')

		let sshAuth: { privateKey?: Buffer; passphrase?: string; password?: string } = {}

		if (this.config.sshPrivateKeyPath) {
			const keyPath = this.config.sshPrivateKeyPath.startsWith('~')
				? this.config.sshPrivateKeyPath.replace('~', os.homedir())
				: this.config.sshPrivateKeyPath
			const privateKey = fs.readFileSync(keyPath)
			const passphrase = await this.credentialService.getCredential(this.config.name, 'sshPassphrase')
			sshAuth = { privateKey, passphrase: passphrase ?? undefined }
		} else {
			const sshPassword = await this.credentialService.getCredential(this.config.name, 'sshPassword')
				?? await this.credentialService.promptForCredential(this.config.name, 'sshPassword')
			sshAuth = { password: sshPassword ?? undefined }
		}

		const sshTarget = `${this.config.sshUsername}@${this.config.sshHost}:${this.config.sshPort ?? 22}`
		const dbTarget = `${this.config.host ?? '127.0.0.1'}:${this.config.port ?? 3306}`

		try {
			this.tunnel = await createSshTunnel({
				sshHost: this.config.sshHost,
				sshPort: this.config.sshPort ?? 22,
				sshUsername: this.config.sshUsername,
				sshPassword: sshAuth.password,
				sshPrivateKeyPath: this.config.sshPrivateKeyPath,
				sshPassphrase: sshAuth.passphrase,
				remoteHost: this.config.host ?? '127.0.0.1',
				remotePort: this.config.port ?? 3306,
				verifyHostKey: this.verifyHostKey,
			})
		} catch (err) {
			throw new Error(`SSH tunnel failed: ${err instanceof Error ? err.message : String(err)}`)
		}

		try {
			const connection = await getConnectionFor(
				this.config.name, 'mysql2',
				'127.0.0.1', this.tunnel.localPort,
				this.config.username ?? 'root', password ?? '',
				this.config.database, false
			)

			if (!connection) throw new Error('could not create the database client')

			this.wrappedEngine = new MysqlEngine(connection)
			await this.wrappedEngine.getConnection()!.raw('SELECT VERSION()')
		} catch (err) {
			await this.disconnect()
			throw new Error(`SSH tunnel ${sshTarget} is open, but MySQL at ${dbTarget} (seen from the SSH host) refused the connection: ${err instanceof Error ? err.message : String(err)}`)
		}

		return true
	}

	private async ensureConnected(): Promise<void> {
		if (!this.tunnel?.needsReconnect) return

		if (this.wrappedEngine) {
			try { await this.wrappedEngine.disconnect() } catch { }
			this.wrappedEngine = null
		}

		const reconnected = await this.tunnel.reconnect()
		if (!reconnected) throw new Error('SSH tunnel reconnection failed')

		const dbPassword = await this.credentialService.getCredential(this.config.name, 'password')
		const connection = await getConnectionFor(
			this.config.name, 'mysql2',
			'127.0.0.1', this.tunnel.localPort,
			this.config.username ?? 'root', dbPassword ?? '',
			this.config.database, false
		)

		if (!connection) throw new Error('Failed to re-establish database connection')

		this.wrappedEngine = new MysqlEngine(connection)
	}

	async disconnect(): Promise<void> {
		if (this.wrappedEngine) {
			await this.wrappedEngine.disconnect()
			this.wrappedEngine = null
		}
		if (this.tunnel) {
			this.tunnel.close()
			this.tunnel = null
		}
	}

	getType(): KnexClient {
		return 'mysql2'
	}

	getConnection(): knexlib.Knex | null {
		return this.wrappedEngine?.getConnection() ?? null
	}

	async isOkay(): Promise<boolean> {
		await this.ensureConnected()
		return this.wrappedEngine?.isOkay() ?? Promise.resolve(false)
	}

	async getTables(): Promise<string[]> {
		await this.ensureConnected()
		return this.wrappedEngine?.getTables() ?? []
	}

	async getColumns(table: string): Promise<Column[]> {
		await this.ensureConnected()
		return this.wrappedEngine?.getColumns(table) ?? []
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return this.wrappedEngine?.getNumericColumnTypeNamesLowercase() ?? []
	}

	async getTableCreationSql(table: string): Promise<string> {
		await this.ensureConnected()
		return this.wrappedEngine?.getTableCreationSql(table) ?? ''
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		await this.ensureConnected()
		return this.wrappedEngine?.getTotalRows(table, columns, whereClause) ?? 0
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		await this.ensureConnected()
		return this.wrappedEngine?.getRows(table, columns, limit, offset, whereClause)
	}

	async commitChange(serializedMutation: SerializedMutation, transaction: knexlib.Knex.Transaction | SQLiteTransaction): Promise<void> {
		await this.ensureConnected()
		if (!this.wrappedEngine) throw new Error('Not connected')
		return this.wrappedEngine.commitChange(serializedMutation, transaction as knexlib.Knex.Transaction)
	}

	async getVersion(): Promise<string | undefined> {
		await this.ensureConnected()
		return this.wrappedEngine?.getVersion()
	}

	async rawQuery(code: string, options?: RawQueryOptions): Promise<any> {
		await this.ensureConnected()
		if (!this.wrappedEngine) throw new Error('Not connected')
		return this.wrappedEngine.rawQuery(code, options)
	}
}
