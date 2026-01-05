import express, { Request, Response, NextFunction } from "express";
import { createServer } from "net";
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logToOutput } from "../output-service";
import { getConnectedDatabase } from "../messenger";
import { savePort, clearPort } from "./no-vscode/port-manager";
import logger from './no-vscode/logger';

function writeMcpLog(message: string, level: 'info' | 'error' | 'warn' | 'debug' = 'info', metadata?: any) {
	logger[level](message, metadata);
	logToOutput(message, 'MCP Server');
}

let port: number | null = null;

export function getProjectRoot(): string {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	const workspacePath = workspaceFolders?.[0]?.uri.fsPath;

	if (!workspacePath) {
		throw new Error('No workspace found');
	}

	return workspacePath;
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

async function checkAndTruncateLogFile() {
	const logFilePath = path.join(os.homedir(), '.devdb', 'mcp-log.txt');
	
	try {
		const stats = await fs.promises.stat(logFilePath);
		if (stats.size > 5 * 1024) {
			const data = await fs.promises.readFile(logFilePath, 'utf8');
			const lines = data.split('\n');
			let truncatedData = '';
			
			for (let i = lines.length - 1; i >= 0; i--) {
				const testData = lines[i] + '\n' + truncatedData;
				if (Buffer.byteLength(testData, 'utf8') > 1024) {
					break;
				}
				truncatedData = testData;
			}
			
			await fs.promises.writeFile(logFilePath, truncatedData);
			logger.info('Log file truncated', { originalSize: stats.size, newSize: Buffer.byteLength(truncatedData, 'utf8') });
		}
	} catch (error) {
		if ((error as any).code !== 'ENOENT') {
			logger.error('Failed to check/truncate log file', { error: (error as Error).message });
		}
	}
}

export async function startHttpServer() {
	await checkAndTruncateLogFile();
	
	if (port) {
		writeMcpLog('MCP HTTP server is already running', 'info', { port });
		return port;
	}

	writeMcpLog('Starting HTTP server for MCP');

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

		app.get('/database-type', async function (_req: any, res: any) {
			logger.debug('HTTP request: GET /database-type');
			const db = await getConnectedDatabase();
			if (!db) {
				logger.error('No database connected for /database-type request');
				return res.status(500).json({ error: 'No DB connected' });
			}
			const type = db.getType();
			logger.debug('Successfully fetched database type', { type });
			res.json({ type });
		});

		const server = app.listen(availablePort, () => {
			const projectRoot = getProjectRoot();
			writeMcpLog(`MCP HTTP server listening on port ${availablePort} for project ${projectRoot}`, 'info', { port: availablePort, projectRoot });
		});

		server.on('error', (error: any) => {
			writeMcpLog(`MCP HTTP server error: ${error.message}`, 'error', { error: error.message, port: availablePort });
			throw error;
		});

		port = availablePort;
		const projectRoot = getProjectRoot();
		logger.info('Saving port for project', { port: availablePort, projectRoot });
		savePort(availablePort, projectRoot);
		return availablePort;
	} catch (error: any) {
		writeMcpLog(`Failed to start MCP HTTP server: ${error.message}`, 'error', { error: error.message });
		throw error;
	}
}

export function getCurrentPort(): number | null {
	return port;
}

export function stopHttpServer(): void {
	if (port) {
		logger.info('Stopping MCP HTTP server', { port });
		try {
			const projectRoot = getProjectRoot();
			clearPort(projectRoot);
		} catch (error: any) {
			logger.error('Failed to clear port entry', { error: error.message });
		}
		port = null;
		logToOutput('MCP HTTP server stopped', 'MCP Server');
	}
}