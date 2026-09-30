import * as vscode from 'vscode';
import * as fs from 'fs';
import type { Server } from 'http';
import { logToOutput } from "../output-service";
import { getDatabase } from "../messenger";
import { savePort, clearPort } from "./no-vscode/port-manager";
import logger, { MCP_LOG_FILE } from './no-vscode/logger';
import { createMcpApp, generateToken, startServerOnAvailablePort } from './http-app';

function writeMcpLog(message: string, level: 'info' | 'error' | 'warn' | 'debug' = 'info', metadata?: any) {
	logger[level](message, metadata);
	logToOutput(message, 'MCP Server');
}

let port: number | null = null;
let server: Server | null = null;

export function getProjectRoot(): string {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	const workspacePath = workspaceFolders?.[0]?.uri.fsPath;

	if (!workspacePath) {
		throw new Error('No workspace found');
	}

	return workspacePath;
}

function mcpAllowsWrites(): boolean {
	return vscode.workspace.getConfiguration('devdb').get<boolean>('mcp.allowWrites', false) === true;
}

async function confirmDestructiveQuery(warning: string): Promise<boolean> {
	const choice = await vscode.window.showWarningMessage(
		'An MCP client wants to run a query that changes data.',
		{ modal: true, detail: warning },
		'Run query'
	);
	return choice === 'Run query';
}

async function checkAndTruncateLogFile() {
	const logFilePath = MCP_LOG_FILE;

	try {
		const stats = await fs.promises.stat(logFilePath);
		await fs.promises.chmod(logFilePath, 0o600);
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

			await fs.promises.writeFile(logFilePath, truncatedData, { mode: 0o600 });
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
		const token = generateToken();
		const app = createMcpApp({
			token,
			getDatabase,
			allowWrites: mcpAllowsWrites,
			confirmDestructive: confirmDestructiveQuery,
			onRejected: message => logToOutput(message, 'MCP Server'),
		});

		const { server: httpServer, port: availablePort } = await startServerOnAvailablePort(app);

		const projectRoot = getProjectRoot();
		writeMcpLog(`MCP HTTP server listening on 127.0.0.1:${availablePort} for project ${projectRoot}`, 'info', { port: availablePort, projectRoot });

		server = httpServer;
		port = availablePort;
		savePort(availablePort, projectRoot, token);
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
		server?.close();
		server = null;
		port = null;
		logToOutput('MCP HTTP server stopped', 'MCP Server');
	}
}
