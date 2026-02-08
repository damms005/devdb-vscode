import knexlib from 'knex'
import { Column, DatabaseEngine, KnexClient, MysqlSshConfigFile, QueryResponse, SerializedMutation } from '../types'
import { MysqlEngine } from './mysql-engine'
import { SQLiteTransaction } from './sqlite-engine'
import { createSshTunnel, SshTunnel } from '../services/ssh-tunnel-service'
import { RemoteCredentialService } from '../services/remote-credential-service'
import { getConnectionFor } from '../services/connector'
import * as fs from 'fs'
import * as os from 'os'

export class MysqlSshEngine implements DatabaseEngine {
	private tunnel: SshTunnel | null = null
	private wrappedEngine: MysqlEngine | null = null
	private config: MysqlSshConfigFile
	private credentialService: RemoteCredentialService

	constructor(config: MysqlSshConfigFile, credentialService: RemoteCredentialService) {
		this.config = config
		this.credentialService = credentialService
	}

	async connect(): Promise<boolean> {
		try {
			const dbPassword = await this.credentialService.getCredential(this.config.name, 'password')
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

			this.tunnel = await createSshTunnel({
				sshHost: this.config.sshHost,
				sshPort: this.config.sshPort ?? 22,
				sshUsername: this.config.sshUsername,
				sshPassword: sshAuth.password,
				sshPrivateKeyPath: this.config.sshPrivateKeyPath,
				sshPassphrase: sshAuth.passphrase,
				remoteHost: this.config.host ?? '127.0.0.1',
				remotePort: this.config.port ?? 3306,
			})

			const connection = await getConnectionFor(
				this.config.name, 'mysql2',
				'127.0.0.1', this.tunnel.localPort,
				this.config.username ?? 'root', dbPassword ?? '',
				this.config.database, false
			)

			if (!connection) return false

			this.wrappedEngine = new MysqlEngine(connection)
			return this.wrappedEngine.isOkay()
		} catch {
			return false
		}
	}

	async disconnect(): Promise<void> {
		if (this.wrappedEngine) {
			await this.wrappedEngine.disconnect()
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
		return this.wrappedEngine?.isOkay() ?? Promise.resolve(false)
	}

	async getTables(): Promise<string[]> {
		return this.wrappedEngine?.getTables() ?? []
	}

	async getColumns(table: string): Promise<Column[]> {
		return this.wrappedEngine?.getColumns(table) ?? []
	}

	getNumericColumnTypeNamesLowercase(): string[] {
		return this.wrappedEngine?.getNumericColumnTypeNamesLowercase() ?? []
	}

	async getTableCreationSql(table: string): Promise<string> {
		return this.wrappedEngine?.getTableCreationSql(table) ?? ''
	}

	async getTotalRows(table: string, columns: Column[], whereClause?: Record<string, any>): Promise<number> {
		return this.wrappedEngine?.getTotalRows(table, columns, whereClause) ?? 0
	}

	async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
		return this.wrappedEngine?.getRows(table, columns, limit, offset, whereClause)
	}

	async commitChange(serializedMutation: SerializedMutation, transaction: knexlib.Knex.Transaction | SQLiteTransaction): Promise<void> {
		if (!this.wrappedEngine) throw new Error('Not connected')
		return this.wrappedEngine.commitChange(serializedMutation, transaction as knexlib.Knex.Transaction)
	}

	async getVersion(): Promise<string | undefined> {
		return this.wrappedEngine?.getVersion()
	}

	async rawQuery(code: string): Promise<any> {
		if (!this.wrappedEngine) throw new Error('Not connected')
		return this.wrappedEngine.rawQuery(code)
	}
}
