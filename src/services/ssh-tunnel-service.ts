import * as net from 'net'
import * as os from 'os'
import * as fs from 'fs'
import { Client } from 'ssh2'

export interface SshTunnelConfig {
	sshHost: string
	sshPort: number
	sshUsername: string
	sshPassword?: string
	sshPrivateKeyPath?: string
	sshPassphrase?: string
	remoteHost: string
	remotePort: number
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
	const maxRetries = 3
	const retryDelays = [1000, 2000, 4000]

	let privateKey: Buffer | undefined
	if (config.sshPrivateKeyPath) {
		const keyPath = expandPath(config.sshPrivateKeyPath)
		privateKey = fs.readFileSync(keyPath)
	}

	function buildConnectConfig(): Record<string, any> {
		const connectConfig: Record<string, any> = {
			host: config.sshHost,
			port: config.sshPort,
			username: config.sshUsername,
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
				reject(err)
			})

			client.connect(buildConnectConfig())
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
