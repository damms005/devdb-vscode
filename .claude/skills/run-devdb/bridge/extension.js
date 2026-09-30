// Test-only helper extension that the driver loads next to DevDb.
// It runs a small HTTP server on 127.0.0.1 so the driver can run VS Code commands (with arguments)
// and evaluate code in the extension host. It writes its port to DEVDB_DRIVER_BRIDGE_FILE.
const vscode = require('vscode');
const http = require('http');
const fs = require('fs');

// DEVDB_HOST_MAP="host=ip,host2=ip" resolves those hosts to the given IP inside this extension host
// only (DevDb runs in the same process). It replaces an /etc/hosts entry, so tests need no sudo.
const hostMap = new Map(
	(process.env.DEVDB_HOST_MAP ?? '')
		.split(',')
		.map((pair) => pair.trim().split('='))
		.filter(([host, ip]) => host && ip)
		.map(([host, ip]) => [host.toLowerCase(), ip]),
);
if (hostMap.size) {
	const dns = require('dns');
	const net = require('net');
	const answer = (ip, options) => {
		const family = net.isIPv6(ip) ? 6 : 4;
		return options && options.all ? [{ address: ip, family }] : { address: ip, family };
	};
	const lookup = dns.lookup;
	dns.lookup = function (hostname, options, callback) {
		const ip = typeof hostname === 'string' && hostMap.get(hostname.toLowerCase());
		if (!ip) return lookup.apply(this, arguments);
		if (typeof options === 'function') [callback, options] = [options, undefined];
		const result = answer(ip, typeof options === 'object' ? options : undefined);
		process.nextTick(() => (Array.isArray(result) ? callback(null, result) : callback(null, result.address, result.family)));
	};
	const lookupPromise = dns.promises.lookup;
	dns.promises.lookup = async function (hostname, options) {
		const ip = typeof hostname === 'string' && hostMap.get(hostname.toLowerCase());
		return ip ? answer(ip, typeof options === 'object' ? options : undefined) : lookupPromise.apply(this, arguments);
	};
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function serialize(value) {
	try {
		return JSON.parse(JSON.stringify(value ?? null));
	} catch {
		return String(value);
	}
}

function activate(context) {
	const file = process.env.DEVDB_DRIVER_BRIDGE_FILE;
	if (!file) return;

	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', async () => {
			try {
				const input = body ? JSON.parse(body) : {};
				let result;
				if (req.url === '/exec') {
					result = await vscode.commands.executeCommand(input.command, ...(input.args ?? []));
				} else if (req.url === '/eval') {
					result = await new AsyncFunction('vscode', 'require', input.code)(vscode, require);
				} else {
					throw new Error(`unknown route ${req.url}`);
				}
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: true, result: serialize(result) }));
			} catch (error) {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
			}
		});
	});

	server.listen(0, '127.0.0.1', () => fs.writeFileSync(file, String(server.address().port)));
	context.subscriptions.push({ dispose: () => server.close() });
}

module.exports = { activate, deactivate() {} };
