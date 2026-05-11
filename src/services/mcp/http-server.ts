import express, { Request, Response, NextFunction } from "express";
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logToOutput } from "../output-service";
import { getConnectedDatabase } from "../messenger";
import { savePort, clearPort } from "./no-vscode/port-manager";
import logger from './no-vscode/logger';
import { validateQuery, getQueryType } from './query-validator';

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

async function startServerOnAvailablePort(app: express.Express, startPort: number = 50001): Promise<{ server: ReturnType<typeof app.listen>, port: number }> {
	let currentPort = startPort;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return await new Promise((resolve, reject) => {
				const srv = app.listen(currentPort, () => {
					resolve({ server: srv, port: currentPort });
				});
				srv.on('error', (err: NodeJS.ErrnoException) => {
					if (err.code === 'EADDRINUSE') {
						srv.close();
						reject(err);
					} else {
						reject(err);
					}
				});
			});
		} catch (err: any) {
			if (err.code === 'EADDRINUSE') {
				currentPort++;
				if (currentPort > 65535) {
					throw new Error('No available ports found');
				}
				continue;
			}
			throw err;
		}
	}
	throw new Error('No available ports found after 100 attempts');
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
			logger.info('HTTP request: POST /query', { queryType: getQueryType(query), queryLength: query?.length });
			logger.debug('Full query text', { query });

			if (!query) {
				logger.error('Query is required but not provided');
				return res.status(400).json({ error: 'Query is required' });
			}
			const validation = validateQuery(query);
			if (!validation.allowed) {
				logger.warn('Blocked destructive query via MCP HTTP', { queryType: getQueryType(query) });
				return res.status(403).json({ error: validation.warning, blocked: true });
			}
			if (validation.warning) {
				logger.warn('Destructive query warning', { queryType: getQueryType(query), warning: validation.warning });
			}
			try {
				const db = await getConnectedDatabase();
				if (!db) {
					logger.error('No database connected for query request', { queryType: getQueryType(query) });
					return res.status(500).json({ message: 'No DB connected' });
				}
				const result = await db.rawQuery(query);
				logger.info('Query executed successfully', { queryType: getQueryType(query), resultLength: JSON.stringify(result).length });
				res.json({ result });
			} catch (error) {
				logger.error('Query execution failed', { queryType: getQueryType(query), error: (error as Error).message });
				logger.debug('Failed query text', { query });
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

		const { server: httpServer, port: availablePort } = await startServerOnAvailablePort(app);

		const projectRoot = getProjectRoot();
		writeMcpLog(`MCP HTTP server listening on port ${availablePort} for project ${projectRoot}`, 'info', { port: availablePort, projectRoot });

		port = availablePort;
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