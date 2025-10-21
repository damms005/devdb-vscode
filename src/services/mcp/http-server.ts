import express, { Request, Response, NextFunction } from "express";
import { createServer } from "net";
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { logToOutput } from "../output-service";
import { getConnectedDatabase } from "../messenger";
import { savePort } from "./no-vscode/port-manager";
import logger from './no-vscode/logger';

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
		logger.info('MCP HTTP server is already running', { port });
		logToOutput('MCP HTTP server is already running', 'MCP Server');
		return port;
	}

	logger.info('Starting HTTP server for MCP');
	logToOutput('Starting HTTP server for MCP', 'MCP Server');

	try {
		const availablePort = await findAvailablePort(50001);
		logger.info('Found available port for MCP HTTP server', { availablePort });
		const app = express();
		app.use(express.json());

		app.use((req: Request, res: Response, next: NextFunction) => {
			const clientIp = req.ip || req.socket.remoteAddress;
			if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1') {
				next();
			} else {
				logger.warn('Rejected connection from non-localhost IP', { clientIp, method: req.method, url: req.url });
				logToOutput(`Rejected connection from non-localhost IP: ${clientIp}`, 'MCP Server');
				res.status(403).send('Access denied: This server only accepts connections from localhost');
			}
		});

		app.get('/tables', async function (req: any, res: any) {
			logger.debug('HTTP request: GET /tables');
			const db = await getConnectedDatabase();
			if (!db) {
				logger.error('No database connected for /tables request');
				return res.status(500).json({ error: 'No DB connected' });
			}
			const tables = await db.getTables();
			logger.debug('Successfully fetched tables', { tableCount: tables.length });
			res.json({ tables });
		});

		app.get('/tables/:tableName/schema', async function (req: any, res: any) {
			const { tableName } = req.params;
			logger.debug('HTTP request: GET /tables/:tableName/schema', { tableName });
			const db = await getConnectedDatabase();
			if (!db) {
				logger.error('No database connected for schema request', { tableName });
				return res.status(500).json({ error: 'No DB connected' });
			}
			const sql = await db.getTableCreationSql(tableName);
			logger.debug('Successfully fetched table schema', { tableName, schemaLength: sql.length });
			res.json({ schema: sql });
		});

		app.post('/query', async function (req: any, res: any) {
			const { query } = req.body;
			logger.info('HTTP request: POST /query', { query });

			if (!query) {
				logger.error('Query is required but not provided');
				return res.status(400).json({ error: 'Query is required' });
			}
			try {
				const db = await getConnectedDatabase();
				if (!db) {
					logger.error('No database connected for query request', { query });
					return res.status(500).json({ message: 'No DB connected' });
				}
				const result = await db.rawQuery(query);
				logger.info('Query executed successfully', { query, resultLength: JSON.stringify(result).length });
				res.json({ result });
			} catch (error) {
				logger.error('Query execution failed', { query, error: (error as Error).message });
				res.status(500).json({ error: `Error running query: ${(error as Error).message}` });
			}
		});

		const server = app.listen(availablePort, () => {
			const workspaceId = getWorkspaceId();
			logger.info('MCP HTTP server started successfully', { port: availablePort, workspaceId });
			logToOutput(`MCP HTTP server listening on port ${availablePort} for workspace ${workspaceId}`, 'MCP Server');
		});

		server.on('error', (error: any) => {
			logger.error('MCP HTTP server error', { error: error.message, port: availablePort });
			logToOutput(`MCP HTTP server error: ${error.message}`, 'MCP Server');
			throw error;
		});

		port = availablePort;
		const workspaceId = getWorkspaceId();
		logger.info('Saving port for workspace', { port: availablePort, workspaceId });
		savePort(availablePort, workspaceId);
		return availablePort;
	} catch (error: any) {
		logger.error('Failed to start MCP HTTP server', { error: error.message });
		logToOutput(`Failed to start MCP HTTP server: ${error.message}`, 'MCP Server');
		throw error;
	}
}

export function getCurrentPort(): number | null {
	return port;
}

export function stopHttpServer(): void {
	if (port) {
		logger.info('Stopping MCP HTTP server', { port });
		port = null;
		logToOutput('MCP HTTP server stopped', 'MCP Server');
	}
}