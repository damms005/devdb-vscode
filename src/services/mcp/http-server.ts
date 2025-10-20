import express, { Request, Response, NextFunction } from "express";
import { createServer } from "net";
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { logToOutput } from "../output-service";
import { getConnectedDatabase } from "../messenger";
import { savePort } from "./no-vscode/port-manager";

let port: number | null = null;

export function getWorkspaceId(): string {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	const workspacePath = workspaceFolders?.[0]?.uri.fsPath;

	if (!workspacePath) {
		throw new Error('No workspace found');
	}

	return crypto.createHash('md5').update(workspacePath).digest('hex').substring(0, 12);
}

function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(port, () => {
			server.once('close', () => {
				resolve(true);
			});
			server.close();
		});
		server.on('error', () => {
			resolve(false);
		});
	});
}

async function findAvailablePort(startPort: number = 50001): Promise<number> {
	let currentPort = startPort;
	while (!(await isPortAvailable(currentPort))) {
		currentPort++;
		if (currentPort > 65535) {
			throw new Error('No available ports found');
		}
	}
	return currentPort;
}

export async function startHttpServer() {
	if (port) {
		logToOutput('MCP HTTP server is already running', 'MCP Server');
		return port;
	}

	logToOutput('Starting HTTP server for MCP', 'MCP Server');

	try {
		const availablePort = await findAvailablePort(50001);
		const app = express();
		app.use(express.json());

		app.use((req: Request, res: Response, next: NextFunction) => {
			const clientIp = req.ip || req.socket.remoteAddress;
			if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1') {
				next();
			} else {
				logToOutput(`Rejected connection from non-localhost IP: ${clientIp}`, 'MCP Server');
				res.status(403).send('Access denied: This server only accepts connections from localhost');
			}
		});

		app.get('/tables', async function (req: any, res: any) {
			const db = await getConnectedDatabase();
			if (!db) return res.status(500).json({ error: 'No DB connected' });
			const tables = await db.getTables();
			res.json({ tables });
		});

		app.get('/tables/:tableName/schema', async function (req: any, res: any) {
			const { tableName } = req.params;
			const db = await getConnectedDatabase();
			if (!db) return res.status(500).json({ error: 'No DB connected' });
			const sql = await db.getTableCreationSql(tableName);
			res.json({ schema: sql });
		});

		app.post('/query', async function (req: any, res: any) {
			const { query } = req.body;

			if (!query) return res.status(400).json({ error: 'Query is required' });
			try {
				const db = await getConnectedDatabase();
				if (!db) return res.status(500).json({ message: 'No DB connected' });
				const result = await db.rawQuery(query);
				res.json({ result });
			} catch (error) {
				res.status(500).json({ error: `Error running query: ${(error as Error).message}` });
			}
		});

		const server = app.listen(availablePort, () => {
			logToOutput(`MCP HTTP server listening on port ${availablePort} for workspace ${workspaceId}`, 'MCP Server');
		});

		server.on('error', (error: any) => {
			logToOutput(`MCP HTTP server error: ${error.message}`, 'MCP Server');
			throw error;
		});

		port = availablePort;
		const workspaceId = getWorkspaceId();
		savePort(availablePort, workspaceId);
		return availablePort;
	} catch (error: any) {
		logToOutput(`Failed to start MCP HTTP server: ${error.message}`, 'MCP Server');
		throw error;
	}
}

export function getCurrentPort(): number | null {
	return port;
}

export function stopHttpServer(): void {
	if (port) {
		port = null;
		logToOutput('MCP HTTP server stopped', 'MCP Server');
	}
}