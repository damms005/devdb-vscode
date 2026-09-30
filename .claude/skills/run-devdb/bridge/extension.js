// Test-only helper extension that the driver loads next to DevDb.
// It runs a small HTTP server on 127.0.0.1 so the driver can run VS Code commands (with arguments)
// and evaluate code in the extension host. It writes its port to DEVDB_DRIVER_BRIDGE_FILE.
const vscode = require('vscode');
const http = require('http');
const fs = require('fs');

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
					result = await new AsyncFunction('vscode', input.code)(vscode);
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
