import * as vscode from 'vscode'

/**
 * Persistent store for trusted SSH host key fingerprints. Until the host calls
 * {@link setSshHostKeyStore} (e.g. with `context.globalState`), trust lasts for the session.
 */
let hostKeyStore: vscode.Memento | null = null
const sessionPins = new Map<string, string>()

export function setSshHostKeyStore(store: vscode.Memento): void {
	hostKeyStore = store
}

function pinKey(host: string, port: number): string {
	return `devdb.sshHostKey.${host}:${port}`
}

/**
 * Trust-on-first-use for an SSH host that is not in known_hosts: a pinned fingerprint is
 * accepted silently, a different one is refused, and an unseen one opens a modal with
 * the SHA256 fingerprint (Trust/Cancel). A trusted fingerprint is pinned.
 */
export async function promptToTrustSshHostKey(host: string, port: number, fingerprint: string): Promise<boolean> {
	const key = pinKey(host, port)
	const pinned = hostKeyStore?.get<string>(key) ?? sessionPins.get(key)

	if (pinned) {
		if (pinned === fingerprint) {
			return true
		}
		throw new Error(`SSH host key for ${host}:${port} changed (trusted ${pinned}, got ${fingerprint}). Refusing to connect: the server key changed or the connection is intercepted.`)
	}

	const choice = await vscode.window.showWarningMessage(
		`Unknown SSH host ${host}:${port}`,
		{
			modal: true,
			detail: `This host is not in ~/.ssh/known_hosts.\n\nKey fingerprint:\n${fingerprint}\n\nCompare it with the server's key before you continue. Trust this host and connect?`,
		},
		'Trust'
	)

	if (choice !== 'Trust') {
		return false
	}

	sessionPins.set(key, fingerprint)
	await hostKeyStore?.update(key, fingerprint)

	return true
}
