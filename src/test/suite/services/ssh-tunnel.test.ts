import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHmac, randomBytes } from 'crypto';
import { AddressInfo } from 'net';
import { Server, utils } from 'ssh2';
import { checkKnownHosts, createSshTunnel, getSshKeyFingerprint, SshTunnelConfig } from '../../../services/ssh-tunnel-service';

type TestSshServer = { port: number, closedClients: () => number, close: () => Promise<void> };

/**
 * In-process SSH server: password auth (`devdb`/`pw`); every port-forward request is refused.
 */
async function startSshServer(hostPrivateKey: string): Promise<TestSshServer> {
	let closed = 0;
	const server = new Server({ hostKeys: [hostPrivateKey] }, (client) => {
		client.on('authentication', (ctx) => {
			if (ctx.method === 'password' && ctx.username === 'devdb' && ctx.password === 'pw') {
				ctx.accept();
			} else {
				ctx.reject(['password']);
			}
		});
		client.on('tcpip', (_accept, reject) => reject());
		client.on('error', () => { });
		client.on('close', () => closed++);
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

	return {
		port: (server.address() as AddressInfo).port,
		closedClients: () => closed,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

function publicKeyOf(pair: { public: string }): { type: string, base64: string, blob: Buffer } {
	const [type, base64] = pair.public.trim().split(/\s+/);
	return { type, base64, blob: Buffer.from(base64, 'base64') };
}

function hashedHost(hostEntry: string): string {
	const salt = randomBytes(20);
	return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(hostEntry).digest('base64')}`;
}

describe('SSH tunnel host key verification', () => {
	const hostKey = utils.generateKeyPairSync('ed25519');
	const otherKey = utils.generateKeyPairSync('ed25519');
	const hostPublic = publicKeyOf(hostKey);
	const otherPublic = publicKeyOf(otherKey);

	let sshServer: TestSshServer;
	let tempDir: string;

	before(async () => {
		sshServer = await startSshServer(hostKey.private);
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdb-known-hosts-'));
	});

	after(async () => {
		await sshServer.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function knownHosts(lines: string[]): string {
		const file = path.join(tempDir, `known_hosts_${randomBytes(4).toString('hex')}`);
		fs.writeFileSync(file, lines.join('\n') + '\n');
		return file;
	}

	function tunnelConfig(overrides: Partial<SshTunnelConfig>): SshTunnelConfig {
		return {
			sshHost: '127.0.0.1',
			sshPort: sshServer.port,
			sshUsername: 'devdb',
			sshPassword: 'pw',
			remoteHost: '127.0.0.1',
			remotePort: 5432,
			...overrides,
		};
	}

	describe('checkKnownHosts', () => {
		it('matches plain, [host]:port, wildcard and hashed entries', () => {
			const key = hostPublic.blob;
			assert.strictEqual(checkKnownHosts(`db.example.com ${hostPublic.type} ${hostPublic.base64}`, 'db.example.com', 22, key), 'match');
			assert.strictEqual(checkKnownHosts(`[db.example.com]:2222 ${hostPublic.type} ${hostPublic.base64}`, 'db.example.com', 2222, key), 'match');
			assert.strictEqual(checkKnownHosts(`*.example.com ${hostPublic.type} ${hostPublic.base64}`, 'db.example.com', 22, key), 'match');
			assert.strictEqual(checkKnownHosts(`${hashedHost('[db.example.com]:2222')} ${hostPublic.type} ${hostPublic.base64}`, 'db.example.com', 2222, key), 'match');
		});

		it('reports a different key of the same type as a mismatch', () => {
			assert.strictEqual(checkKnownHosts(`db.example.com ${otherPublic.type} ${otherPublic.base64}`, 'db.example.com', 22, hostPublic.blob), 'mismatch');
		});

		it('ignores other hosts, negated patterns and cert-authority lines', () => {
			const key = hostPublic.blob;
			assert.strictEqual(checkKnownHosts(`other.example.com ${otherPublic.type} ${otherPublic.base64}`, 'db.example.com', 22, key), 'unknown');
			assert.strictEqual(checkKnownHosts(`*.example.com,!db.example.com ${otherPublic.type} ${otherPublic.base64}`, 'db.example.com', 22, key), 'unknown');
			assert.strictEqual(checkKnownHosts(`@cert-authority db.example.com ${otherPublic.type} ${otherPublic.base64}`, 'db.example.com', 22, key), 'unknown');
		});

		it('reports a revoked key', () => {
			const contents = [`@revoked * ${hostPublic.type} ${hostPublic.base64}`, `db.example.com ${hostPublic.type} ${hostPublic.base64}`].join('\n');
			assert.strictEqual(checkKnownHosts(contents, 'db.example.com', 22, hostPublic.blob), 'revoked');
		});
	});

	describe('createSshTunnel', () => {
		it('connects without prompting when known_hosts has the key', async () => {
			let prompted = false;
			const tunnel = await createSshTunnel(tunnelConfig({
				knownHostsPath: knownHosts([`${hashedHost(`[127.0.0.1]:${sshServer.port}`)} ${hostPublic.type} ${hostPublic.base64}`]),
				verifyHostKey: async () => { prompted = true; return false; },
			}));
			tunnel.close();

			assert.strictEqual(prompted, false);
		});

		it('refuses a key that does not match known_hosts without prompting', async () => {
			let prompted = false;
			await assert.rejects(createSshTunnel(tunnelConfig({
				knownHostsPath: knownHosts([`[127.0.0.1]:${sshServer.port} ${otherPublic.type} ${otherPublic.base64}`]),
				verifyHostKey: async () => { prompted = true; return true; },
			})), /does not match/);

			assert.strictEqual(prompted, false);
		});

		it('refuses a revoked key', async () => {
			await assert.rejects(createSshTunnel(tunnelConfig({
				knownHostsPath: knownHosts([`@revoked [127.0.0.1]:${sshServer.port} ${hostPublic.type} ${hostPublic.base64}`]),
				verifyHostKey: async () => true,
			})), /@revoked/);
		});

		it('refuses an unknown host when there is no verifier', async () => {
			await assert.rejects(createSshTunnel(tunnelConfig({ knownHostsPath: knownHosts([]) })), /is not in/);
		});

		it('asks the verifier with the SHA256 fingerprint and honours a refusal', async () => {
			const asked: Array<[string, number, string]> = [];
			await assert.rejects(createSshTunnel(tunnelConfig({
				knownHostsPath: knownHosts([]),
				verifyHostKey: async (host, port, fingerprint) => { asked.push([host, port, fingerprint]); return false; },
			})), /was not trusted/);

			assert.deepStrictEqual(asked, [['127.0.0.1', sshServer.port, getSshKeyFingerprint(hostPublic.blob)]]);
			assert.match(asked[0][2], /^SHA256:[A-Za-z0-9+/]{43}$/);
		});

		it('connects when the verifier trusts the key', async () => {
			const tunnel = await createSshTunnel(tunnelConfig({
				knownHostsPath: knownHosts([]),
				verifyHostKey: async () => true,
			}));
			tunnel.close();
		});

		it('reports SSH auth failures with the target', async () => {
			await assert.rejects(createSshTunnel(tunnelConfig({
				sshPassword: 'wrong',
				knownHostsPath: knownHosts([`[127.0.0.1]:${sshServer.port} ${hostPublic.type} ${hostPublic.base64}`]),
			})), new RegExp(`SSH connection to devdb@127.0.0.1:${sshServer.port} failed`));
		});
	});

	describe('SSH engines', () => {
		const Module = require('module');
		const originalResolve = Module._resolveFilename;

		before(() => {
			// The SSH engines import VS Code services; give them a minimal stand-in.
			Module._resolveFilename = function (request: string, ...rest: any[]) {
				return request === 'vscode' ? 'vscode' : originalResolve.call(this, request, ...rest);
			};
			require.cache['vscode'] = {
				id: 'vscode', filename: 'vscode', loaded: true,
				exports: {
					window: { createOutputChannel: () => ({ appendLine: () => { }, clear: () => { }, show: () => { } }), showErrorMessage: async () => undefined, showInputBox: async () => undefined },
					workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
				},
			} as any;
		});

		after(() => {
			Module._resolveFilename = originalResolve;
			delete require.cache['vscode'];
		});

		for (const engineModule of ['mysql-ssh-engine', 'postgres-ssh-engine']) {
			it(`${engineModule} closes the tunnel when the database connect fails`, async () => {
				const exported = require(`../../../database-engines/${engineModule}`);
				const EngineClass = exported.MysqlSshEngine ?? exported.PostgresSshEngine;
				const credentials = {
					getCredential: async (_name: string, type: string) => type === 'sshPassword' ? 'pw' : 'db-pass',
					promptForCredential: async () => undefined,
				};
				const engine = new EngineClass({
					name: 'ssh-test', type: 'x', database: 'app', host: '127.0.0.1', port: 1,
					sshHost: '127.0.0.1', sshPort: sshServer.port, sshUsername: 'devdb',
				}, credentials, async () => true);

				const closedBefore = sshServer.closedClients();
				await assert.rejects(engine.connect(), /SSH tunnel devdb@127\.0\.0\.1:\d+ is open, but (MySQL|PostgreSQL) at 127\.0\.0\.1:1/);

				// the SSH session is torn down, not leaked
				for (let waited = 0; sshServer.closedClients() === closedBefore && waited < 2000; waited += 50) {
					await new Promise(resolve => setTimeout(resolve, 50));
				}
				assert.strictEqual(sshServer.closedClients(), closedBefore + 1);
			});
		}
	});
});
