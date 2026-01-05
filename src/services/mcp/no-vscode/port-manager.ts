import * as fs from 'fs';
import logger from "./logger"
import { MCP_CONFIG_DIR, MCP_CONFIG_FILE } from './config';

interface McpConfig {
	[projectRoot: string]: number;
}

function ensureConfigDir(): void {
	if (!fs.existsSync(MCP_CONFIG_DIR)) {
		fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true });
	}
}

function readMcpConfig(): McpConfig {
	try {
		if (fs.existsSync(MCP_CONFIG_FILE)) {
			const content = fs.readFileSync(MCP_CONFIG_FILE, 'utf8');
			return JSON.parse(content);
		}
	} catch (error) {
		logger.error('Failed to read MCP config file:', error);
	}
	return {};
}

function writeMcpConfig(config: McpConfig): void {
	try {
		ensureConfigDir();
		fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
	} catch (error) {
		logger.error('Failed to write MCP config file:', error);
		throw error;
	}
}

export function savePort(port: number, projectRoot: string): void {
	try {
		const config = readMcpConfig();

		for (const existingProjectRoot in config) {
			if (config[existingProjectRoot] === port) {
				delete config[existingProjectRoot];
				logger.info(`DevDB: Removed port ${port} from project ${existingProjectRoot}`);
			}
		}

		config[projectRoot] = port;
		writeMcpConfig(config);
	} catch (error) {
		logger.error('Failed to save port to config:', error);
		throw error;
	}
}

export function getPort(projectRoot: string): number | null {
	try {
		const config = readMcpConfig();
		const port = config[projectRoot];

		if (port) {
			logger.info(`DevDB: Read port ${port} for project ${projectRoot} from ${MCP_CONFIG_FILE}`);
			return port;
		} else {
			logger.info(`DevDB: No port found for project ${projectRoot} in ${MCP_CONFIG_FILE}`);
			return null;
		}
	} catch (error) {
		logger.error('Failed to read port from config:', error);
		return null;
	}
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
		logger.error('Failed to clear port from config:', error);
	}
}

export function getConfigDir() {
	return MCP_CONFIG_DIR;
}