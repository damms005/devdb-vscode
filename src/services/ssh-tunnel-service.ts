import * as net from 'net'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { createHash, createHmac } from 'crypto'
import { Client } from 'ssh2'

/**
 * Asks whether to trust a host key that is not in known_hosts. Resolves true to trust
 * (the implementation may pin it), false to refuse; it may also reject with a reason.
 */
export type SshHostKeyVerifier = (host: string, port: number, fingerprint: string) => Promise<boolean>

export interface SshTunnelConfig {
	sshHost: string
	sshPort: number
	sshUsername: string
	sshPassword?: string
	sshPrivateKeyPath?: string
	sshPassphrase?: string
	remoteHost: string
	remotePort: number
	/**
	 * Called for a host key that is not in known_hosts. Without it, unknown hosts are refused.
	 */
	verifyHostKey?: SshHostKeyVerifier
	/**
	 * Defaults to ~/.ssh/known_hosts.
	 */
	knownHostsPath?: string
}

export type KnownHostsMatch = 'match' | 'mismatch' | 'revoked' | 'unknown'

/**
 * OpenSSH-style SHA256 fingerprint of a raw public key blob, e.g. `SHA256:abc...`.
 */
export function getSshKeyFingerprint(key: Buffer): string {
	return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

function getSshKeyType(key: Buffer): string {
	if (key.length < 4) {
		return ''
	}
	const length = key.readUInt32BE(0)
	return key.subarray(4, 4 + length).toString()
}

function wildcardToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
	return new RegExp(`^${escaped}$`, 'i')
}

function hostPatternMatches(pattern: string, hostEntry: string): boolean {
	if (pattern.startsWith('|1|')) {
		const [, , salt, hash] = pattern.split('|')
		if (!salt || !hash) {
			return false
		}
		const digest = createHmac('sha1', Buffer.from(salt, 'base64')).update(hostEntry).digest('base64')
		return digest === hash
	}

	return wildcardToRegExp(pattern).test(hostEntry)
}

/**
 * Checks a host key against known_hosts contents (plain, wildcard and hashed `|1|` host
 * entries, `@revoked` markers; `@cert-authority` lines are ignored).
 * - `match`: a line for this host has this exact key
 * - `revoked`: the key is marked `@revoked`
 * - `mismatch`: a line for this host has a different key of the same type
 * - `unknown`: no line for this host and key type
 */
export function checkKnownHosts(contents: string, host: string, port: number, key: Buffer): KnownHostsMatch {
	const hostEntry = port === 22 ? host : `[${host}]:${port}`
	const keyType = getSshKeyType(key)
	let matched = false
	let mismatched = false

	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) {
			continue
		}

		const fields = line.split(/\s+/)
		let marker: string | undefined
		if (fields[0].startsWith('@')) {
			marker = fields.shift()
		}
		const [patterns, type, encodedKey] = fields
		if (!patterns || !type || !encodedKey || marker === '@cert-authority') {
			continue
		}

		const hostPatterns = patterns.split(',')
		const negated = hostPatterns.some(pattern => pattern.startsWith('!') && hostPatternMatches(pattern.slice(1), hostEntry))
		const positive = hostPatterns.some(pattern => !pattern.startsWith('!') && hostPatternMatches(pattern, hostEntry))
		if (negated || !positive) {
			continue
		}

		const sameKey = Buffer.from(encodedKey, 'base64').equals(key)
		if (marker === '@revoked') {
			if (sameKey) {
				return 'revoked'
			}
			continue
		}

		if (sameKey) {
			matched = true
		} else if (type === keyType) {
			mismatched = true
		}
	}

	if (matched) {
		return 'match'
	}

	return mismatched ? 'mismatch' : 'unknown'
}

function readKnownHosts(knownHostsPath: string): string {
	try {
		return fs.readFileSync(knownHostsPath, 'utf8')
	} catch {
		return ''
	}
}

export interface SshTunnel {
	localPort: number
	needsReconnect: boolean
	reconnect: () => Promise<boolean>
	close: () => void
}

function expandPath(filePath: string): string {
	if (filePath.startsWith('~')) {
		return filePath.replace('~', os.homedir())
	}
	return filePath
}

async function findAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		server.listen(0, '127.0.0.1', () => {
			const address = server.address() as net.AddressInfo
			const port = address.port
			server.close(() => resolve(port))
		})
		server.on('error', reject)
	})
}

export async function createSshTunnel(config: SshTunnelConfig): Promise<SshTunnel> {
	const localPort = await findAvailablePort()
	const knownHostsPath = config.knownHostsPath ?? path.join(os.homedir(), '.ssh', 'known_hosts')
	const target = `${config.sshHost}:${config.sshPort}`
	let trustedFingerprint: string | undefined
	const maxRetries = 3
	const retryDelays = [1000, 2000, 4000]

	let privateKey: Buffer | undefined
	if (config.sshPrivateKeyPath) {
		const keyPath = expandPath(config.sshPrivateKeyPath)
		privateKey = fs.readFileSync(keyPath)
	}

	/**
	 * Resolves when the host key is trusted; rejects with the reason otherwise. A key the
	 * user trusted once is remembered for this tunnel's reconnects.
	 */
	async function verifyHostKey(key: Buffer): Promise<void> {
		const fingerprint = getSshKeyFingerprint(key)
		const known = checkKnownHosts(readKnownHosts(knownHostsPath), config.sshHost, config.sshPort, key)

		if (known === 'match') {
			return
		}

		if (known === 'revoked') {
			throw new Error(`SSH host key for ${target} (${fingerprint}) is marked @revoked in ${knownHostsPath}. Refusing to connect.`)
		}

		if (known === 'mismatch') {
			throw new Error(`SSH host key for ${target} does not match ${knownHostsPath} (got ${fingerprint}). Refusing to connect: the server key changed or the connection is intercepted.`)
		}

		if (trustedFingerprint !== undefined) {
			if (trustedFingerprint === fingerprint) {
				return
			}
			throw new Error(`SSH host key for ${target} changed during the session (got ${fingerprint}, trusted ${trustedFingerprint}). Refusing to connect.`)
		}

		if (!config.verifyHostKey) {
			throw new Error(`SSH host ${target} is not in ${knownHostsPath} (fingerprint ${fingerprint}). Add it with ssh-keyscan or connect once with ssh, then retry.`)
		}

		if (!(await config.verifyHostKey(config.sshHost, config.sshPort, fingerprint))) {
			throw new Error(`SSH host key for ${target} (${fingerprint}) was not trusted. Connection cancelled.`)
		}

		trustedFingerprint = fingerprint
	}

	function buildConnectConfig(onHostKeyRejected: (error: Error) => void): Record<string, any> {
		const connectConfig: Record<string, any> = {
			host: config.sshHost,
			port: config.sshPort,
			username: config.sshUsername,
			hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
				verifyHostKey(key).then(
					() => verify(true),
					(error: Error) => {
						onHostKeyRejected(error)
						verify(false)
					}
				)
			},
		}

		if (privateKey) {
			connectConfig.privateKey = privateKey
			if (config.sshPassphrase) {
				connectConfig.passphrase = config.sshPassphrase
			}
		} else if (config.sshPassword) {
			connectConfig.password = config.sshPassword
		}

		return connectConfig
	}

	function connect(): Promise<{ client: Client; server: net.Server }> {
		return new Promise((resolve, reject) => {
			const client = new Client()
			let hostKeyError: Error | undefined

			const server = net.createServer((sock) => {
				client.forwardOut('127.0.0.1', localPort, config.remoteHost, config.remotePort, (err, stream) => {
					if (err) {
						sock.end()
						return
					}
					sock.pipe(stream).pipe(sock)
				})
			})

			client.on('ready', () => {
				server.listen(localPort, '127.0.0.1', () => {
					resolve({ client, server })
				})
			})

			client.on('error', (err) => {
				server.close()
				reject(hostKeyError ?? new Error(`SSH connection to ${config.sshUsername}@${target} failed: ${err.message}`))
			})

			client.connect(buildConnectConfig((error) => {
				hostKeyError = error
			}))
		})
	}

	let { client, server } = await connect()
	let closed = false
	let _needsReconnect = false

	function markDisconnected() {
		if (closed) return
		_needsReconnect = true
		server.close()
	}

	client.on('close', markDisconnected)
	client.on('end', markDisconnected)

	return {
		localPort,
		get needsReconnect() { return _needsReconnect },
		async reconnect(): Promise<boolean> {
			for (let attempt = 0; attempt < maxRetries; attempt++) {
				if (attempt > 0) {
					await new Promise(res => setTimeout(res, retryDelays[attempt - 1]))
				}

				try {
					const result = await connect()
					client = result.client
					server = result.server
					_needsReconnect = false

					client.on('close', markDisconnected)
					client.on('end', markDisconnected)

					return true
				} catch {
					// retry
				}
			}
			return false
		},
		close() {
			closed = true
			server.close()
			client.end()
		}
	}
}
