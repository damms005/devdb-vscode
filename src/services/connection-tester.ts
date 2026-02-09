import { DatabaseEngine, MongodbConfig, MysqlSshConfigFile, PostgresSshConfigFile } from '../types';
import { MongodbEngine } from '../database-engines/mongodb-engine';
import { MysqlEngine } from '../database-engines/mysql-engine';
import { PostgresEngine } from '../database-engines/postgres-engine';
import { MysqlSshEngine } from '../database-engines/mysql-ssh-engine';
import { PostgresSshEngine } from '../database-engines/postgres-ssh-engine';
import { remoteCredentialService } from './remote-credential-service';
import { getConnectionFor } from './connector';

export async function testRemoteConnection(formData: any): Promise<{ success: boolean; message: string }> {
	try {
		const connectionType = formData.connectionType as string
		const port = formData.dbPort ? Number(formData.dbPort) : undefined
		const isPostgres = port === 5432

		let engine: DatabaseEngine | null = null

		if (connectionType === 'mongodb') {
			const config: MongodbConfig = {
				name: formData.connectionName,
				type: 'mongodb',
				host: formData.dbHost,
				port,
				username: formData.dbUsername,
				database: formData.dbName ?? '',
				password: formData.dbPassword ?? undefined,
				connectionString: formData.mongoConnectionString,
			}
			const mongoEngine = new MongodbEngine(config)
			if (!(await mongoEngine.connect())) {
				return { success: false, message: 'Failed to connect to MongoDB' }
			}
			engine = mongoEngine
		} else if (connectionType === 'ssh-tunnel') {
			if (isPostgres) {
				const config: PostgresSshConfigFile = {
					name: formData.connectionName,
					type: 'postgres-ssh',
					host: formData.dbHost || 'localhost',
					port,
					username: formData.dbUsername,
					database: formData.dbName ?? '',
					sshHost: formData.sshHost ?? '',
					sshPort: formData.sshPort ? Number(formData.sshPort) : undefined,
					sshUsername: formData.sshUsername ?? '',
					sshPrivateKeyPath: formData.sshPrivateKeyPath,
				}
				const sshEngine = new PostgresSshEngine(config, remoteCredentialService)
				if (!(await sshEngine.connect())) {
					return { success: false, message: 'Failed to connect via SSH to PostgreSQL' }
				}
				engine = sshEngine
			} else {
				const config: MysqlSshConfigFile = {
					name: formData.connectionName,
					type: 'mysql-ssh',
					host: formData.dbHost || 'localhost',
					port,
					username: formData.dbUsername,
					database: formData.dbName ?? '',
					sshHost: formData.sshHost ?? '',
					sshPort: formData.sshPort ? Number(formData.sshPort) : undefined,
					sshUsername: formData.sshUsername ?? '',
					sshPrivateKeyPath: formData.sshPrivateKeyPath,
				}
				const sshEngine = new MysqlSshEngine(config, remoteCredentialService)
				if (!(await sshEngine.connect())) {
					return { success: false, message: 'Failed to connect via SSH to MySQL' }
				}
				engine = sshEngine
			}
		} else {
			const client = isPostgres ? 'postgres' : 'mysql2'
			const defaultPort = isPostgres ? 5432 : 3306
			const defaultUser = isPostgres ? 'postgres' : 'root'
			const knex = await getConnectionFor(
				formData.connectionName, client,
				formData.dbHost || 'localhost', port ?? defaultPort,
				formData.dbUsername ?? defaultUser, formData.dbPassword ?? '',
				formData.dbName, false
			)
			if (!knex) {
				return { success: false, message: `Failed to connect to ${isPostgres ? 'PostgreSQL' : 'MySQL'}` }
			}
			if (isPostgres) {
				const pgEngine = new PostgresEngine(knex)
				if (!(await pgEngine.isOkay())) {
					return { success: false, message: 'PostgreSQL connection not healthy' }
				}
				engine = pgEngine
			} else {
				const mysqlEngine = new MysqlEngine(knex)
				if (!(await mysqlEngine.isOkay())) {
					return { success: false, message: 'MySQL connection not healthy' }
				}
				engine = mysqlEngine
			}
		}

		if (engine) {
			try { await engine.disconnect() } catch {}
		}

		return { success: true, message: 'Connection successful' }
	} catch (error) {
		return { success: false, message: String(error) }
	}
}
