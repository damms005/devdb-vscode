import * as vscode from 'vscode'

export type CredentialType = 'password' | 'sshPassword' | 'sshPassphrase' | 'connectionString' | 'awsAccessKeyId' | 'awsSessionToken'

const CREDENTIAL_TYPES: CredentialType[] = ['password', 'sshPassword', 'sshPassphrase', 'connectionString', 'awsAccessKeyId', 'awsSessionToken']

const credentialLabels: Record<CredentialType, string> = {
	password: 'database password',
	sshPassword: 'SSH password',
	sshPassphrase: 'SSH key passphrase',
	connectionString: 'connection string',
	awsAccessKeyId: 'AWS access key ID',
	awsSessionToken: 'AWS session token',
}

/**
 * Masks credentials embedded in URIs (`scheme://user:secret@host` -> `scheme://user:****@host`)
 * and `password=` query/DSN parameters, so connection strings and driver error messages can be
 * shown or persisted without leaking secrets.
 */
export function redactSecrets(text: string): string {
	return text
		.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+@/gi, '$1****@')
		.replace(/((?:^|[?&;\s])(?:password|pwd|pass)=)[^&;\s]+/gi, '$1****')
}

export function errorMessage(error: unknown): string {
	if (error instanceof AggregateError && error.errors.length) {
		return redactSecrets(error.errors.map((e: any) => String(e?.message ?? e)).join('; '))
	}
	const message = error instanceof Error ? error.message : String(error)
	return redactSecrets(message.split('\n')[0].trim() || String(error))
}

/**
 * Secrets for remote connections live in VS Code SecretStorage, keyed by the connection id so a
 * rename never orphans them. Entries written by older versions were keyed by connection name;
 * {@link migrateLegacyCredentials} moves those to the id-based key.
 */
export class RemoteCredentialService {
	private context: vscode.ExtensionContext | null = null

	setExtensionContext(context: vscode.ExtensionContext) {
		this.context = context
	}

	getSecretStorage(): vscode.SecretStorage | undefined {
		return this.context?.secrets
	}

	protected getKey(connectionId: string, credType: CredentialType): string {
		return `devdb.connection.${connectionId}.${credType}`
	}

	private getLegacyKey(connectionName: string, credType: CredentialType): string {
		return `devdb.${connectionName}.${credType}`
	}

	async getCredential(connectionId: string, credType: CredentialType): Promise<string | undefined> {
		return this.getSecretStorage()?.get(this.getKey(connectionId, credType))
	}

	async storeCredential(connectionId: string, credType: CredentialType, value: string): Promise<void> {
		await this.getSecretStorage()?.store(this.getKey(connectionId, credType), value)
	}

	async deleteCredential(connectionId: string, credType: CredentialType): Promise<void> {
		await this.getSecretStorage()?.delete(this.getKey(connectionId, credType))
	}

	async deleteAllCredentials(connectionId: string, legacyConnectionName?: string): Promise<void> {
		const secrets = this.getSecretStorage()
		if (!secrets) return

		for (const credType of CREDENTIAL_TYPES) {
			await secrets.delete(this.getKey(connectionId, credType))
			if (legacyConnectionName) {
				await secrets.delete(this.getLegacyKey(legacyConnectionName, credType))
			}
		}
	}

	/**
	 * Moves secrets stored under the old name-based key to the id-based key. An id-keyed value that
	 * already exists wins; the legacy entry is removed either way.
	 */
	async migrateLegacyCredentials(connectionId: string, connectionName: string): Promise<void> {
		const secrets = this.getSecretStorage()
		if (!secrets) return

		for (const credType of CREDENTIAL_TYPES) {
			const legacyKey = this.getLegacyKey(connectionName, credType)
			const legacyValue = await secrets.get(legacyKey)
			if (legacyValue === undefined) continue

			const key = this.getKey(connectionId, credType)
			if ((await secrets.get(key)) === undefined) {
				await secrets.store(key, legacyValue)
			}
			await secrets.delete(legacyKey)
		}
	}

	/**
	 * Returns a credential service bound to one connection id. Engines that look secrets up by
	 * display name (the SSH engines) get the id-keyed secrets, while prompts still show the name.
	 */
	forConnection(connectionId: string): RemoteCredentialService {
		return new ConnectionCredentialService(this, connectionId)
	}

	async promptForCredential(connectionName: string, credType: CredentialType): Promise<string | undefined> {
		const label = credentialLabels[credType]
		const value = await vscode.window.showInputBox({
			prompt: `Enter ${label} for ${connectionName}`,
			password: true,
			ignoreFocusOut: true,
		})

		if (value !== undefined && value !== '') {
			await this.storeCredential(connectionName, credType, value)
			return value
		}

		return undefined
	}
}

class ConnectionCredentialService extends RemoteCredentialService {
	constructor(private readonly parent: RemoteCredentialService, private readonly connectionId: string) {
		super()
	}

	getSecretStorage(): vscode.SecretStorage | undefined {
		return this.parent.getSecretStorage()
	}

	protected getKey(_connectionName: string, credType: CredentialType): string {
		return super.getKey(this.connectionId, credType)
	}
}

export const remoteCredentialService = new RemoteCredentialService()
