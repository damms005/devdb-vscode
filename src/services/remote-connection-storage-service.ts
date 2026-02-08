import * as vscode from 'vscode'
import { remoteCredentialService } from './remote-credential-service'

export interface StoredRemoteConnection {
	id: string
	name: string
	type: 'mysql-ssh' | 'postgres-ssh' | 'mongodb' | 'mysql' | 'postgres'
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
	mongoConnectionString?: string
	lastConnected?: string
}

export interface RemoteConnectionListItem {
	id: string
	name: string
	type: string
	host: string
	lastConnected?: string
}

const STORAGE_KEY = 'devdb.remoteConnections'

class RemoteConnectionStorageService {
	private context: vscode.ExtensionContext | null = null

	setExtensionContext(context: vscode.ExtensionContext) {
		this.context = context
	}

	async getAll(): Promise<StoredRemoteConnection[]> {
		if (!this.context) return []
		return this.context.globalState.get<StoredRemoteConnection[]>(STORAGE_KEY, [])
	}

	async getListItems(): Promise<RemoteConnectionListItem[]> {
		const connections = await this.getAll()
		return connections.map(conn => ({
			id: conn.id,
			name: conn.name,
			type: conn.type,
			host: conn.sshHost ? `${conn.sshHost} → ${conn.host || '127.0.0.1'}` : (conn.host || 'localhost'),
			lastConnected: conn.lastConnected,
		}))
	}

	async save(connection: StoredRemoteConnection, password?: string): Promise<StoredRemoteConnection> {
		if (!this.context) throw new Error('Extension context not set')

		const connections = await this.getAll()
		const existingIndex = connections.findIndex(c => c.id === connection.id)

		if (existingIndex >= 0) {
			connections[existingIndex] = connection
		} else {
			connections.push(connection)
		}

		await this.context.globalState.update(STORAGE_KEY, connections)

		if (password) {
			await remoteCredentialService.storeCredential(connection.name, 'password', password)
		}

		return connection
	}

	async delete(connectionId: string): Promise<void> {
		if (!this.context) return

		const connections = await this.getAll()
		const connection = connections.find(c => c.id === connectionId)

		if (connection) {
			await remoteCredentialService.deleteAllCredentials(connection.name)
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

export const remoteConnectionStorageService = new RemoteConnectionStorageService()
