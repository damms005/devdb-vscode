import * as vscode from 'vscode'

type CredentialType = 'password' | 'sshPassword' | 'sshPassphrase'

const credentialLabels: Record<CredentialType, string> = {
	password: 'database password',
	sshPassword: 'SSH password',
	sshPassphrase: 'SSH key passphrase',
}

export class RemoteCredentialService {
	private context: vscode.ExtensionContext | null = null

	setExtensionContext(context: vscode.ExtensionContext) {
		this.context = context
	}

	private getKey(connectionName: string, credType: CredentialType): string {
		return `devdb.${connectionName}.${credType}`
	}

	async getCredential(connectionName: string, credType: CredentialType): Promise<string | undefined> {
		if (!this.context) return undefined
		return this.context.secrets.get(this.getKey(connectionName, credType))
	}

	async storeCredential(connectionName: string, credType: CredentialType, value: string): Promise<void> {
		if (!this.context) return
		await this.context.secrets.store(this.getKey(connectionName, credType), value)
	}

	async deleteCredential(connectionName: string, credType: CredentialType): Promise<void> {
		if (!this.context) return
		await this.context.secrets.delete(this.getKey(connectionName, credType))
	}

	async deleteAllCredentials(connectionName: string): Promise<void> {
		const types: CredentialType[] = ['password', 'sshPassword', 'sshPassphrase']
		for (const credType of types) {
			await this.deleteCredential(connectionName, credType)
		}
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

export const remoteCredentialService = new RemoteCredentialService()
