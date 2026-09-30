import * as fs from 'fs';
import * as crypto from 'crypto';
import logger from "./logger"
import { MCP_CONFIG_DIR, MCP_CONFIG_FILE } from './config';

export type McpServerEntry = {
	port: number;
	/** Per-session bearer token the HTTP server requires. */
	token?: string;
};

interface McpConfig {
	/** Legacy entries hold only the port number. */
	[projectRoot: string]: number | McpServerEntry;
}

function ensureConfigDir(): void {
	if (!fs.existsSync(MCP_CONFIG_DIR)) {
		fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true, mode: 0o700 });
	}
}

function readMcpConfig(): McpConfig {
	try {
		if (fs.existsSync(MCP_CONFIG_FILE)) {
			const content = fs.readFileSync(MCP_CONFIG_FILE, 'utf8');
			return JSON.parse(content);
		}
	} catch (error) {
		logger.error('Failed to read MCP config file', { error: String(error) });
	}
	return {};
}

function writeMcpConfig(config: McpConfig): void {
	try {
		ensureConfigDir();
		const tmpFile = `${MCP_CONFIG_FILE}.${crypto.randomBytes(6).toString('hex')}.tmp`;
		fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
		fs.renameSync(tmpFile, MCP_CONFIG_FILE);
		fs.chmodSync(MCP_CONFIG_FILE, 0o600);
	} catch (error) {
		logger.error('Failed to write MCP config file', { error: String(error) });
		throw error;
	}
}

function toEntry(value: number | McpServerEntry | undefined): McpServerEntry | null {
	if (typeof value === 'number') {
		return { port: value };
	}
	if (value && typeof value === 'object' && typeof value.port === 'number') {
		return value;
	}
	return null;
}

export function savePort(port: number, projectRoot: string, token?: string): void {
	try {
		const config = readMcpConfig();

		for (const existingProjectRoot in config) {
			if (toEntry(config[existingProjectRoot])?.port === port) {
				delete config[existingProjectRoot];
				logger.info(`DevDB: Removed port ${port} from project ${existingProjectRoot}`);
			}
		}

		config[projectRoot] = token ? { port, token } : port;
		writeMcpConfig(config);
	} catch (error) {
		logger.error('Failed to save port to config', { error: String(error) });
		throw error;
	}
}

export function getServerEntry(projectRoot: string): McpServerEntry | null {
	try {
		const entry = toEntry(readMcpConfig()[projectRoot]);

		if (entry) {
			logger.info(`DevDB: Read port ${entry.port} for project ${projectRoot} from ${MCP_CONFIG_FILE}`);
		} else {
			logger.info(`DevDB: No port found for project ${projectRoot} in ${MCP_CONFIG_FILE}`);
		}
		return entry;
	} catch (error) {
		logger.error('Failed to read port from config', { error: String(error) });
		return null;
	}
}

export function getPort(projectRoot: string): number | null {
	return getServerEntry(projectRoot)?.port ?? null;
}

export function clearPort(projectRoot: string): void {
	try {
		const config = readMcpConfig();
		if (config[projectRoot]) {
			delete config[projectRoot];
			writeMcpConfig(config);
			logger.info(`DevDB: Cleared port for project ${projectRoot}`);
		}
	} catch (error) {
		logger.error('Failed to clear port from config', { error: String(error) });
	}
}

export function getConfigDir() {
	return MCP_CONFIG_DIR;
}
