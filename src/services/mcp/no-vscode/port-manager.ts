import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as winston from 'winston';

const MCP_CONFIG_DIR = path.join(os.homedir(), '.devdb');
const MCP_CONFIG_FILE = path.join(MCP_CONFIG_DIR, 'mcp.json');

const logger = winston.createLogger({
	level: 'info',
	format: winston.format.json(),
	defaultMeta: { service: 'devdb-mcp-port-manager' },
	transports: [
		new winston.transports.File({ filename: path.join(MCP_CONFIG_DIR, 'error.log'), level: 'error' }),
		new winston.transports.File({ filename: path.join(MCP_CONFIG_DIR, 'combined.log') }),
	],
});

if (process.env.DEBUG_MODE === 'true') {
	logger.add(new winston.transports.Console({
		format: winston.format.simple(),
	}));
}

interface McpConfig {
	[workspaceId: string]: number;
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

export function savePort(port: number, workspaceId: string): void {
	try {
		const config = readMcpConfig();
		config[workspaceId] = port;
		writeMcpConfig(config);
		logger.info(`DevDB: Saved port ${port} for workspace ${workspaceId} to ${MCP_CONFIG_FILE}`);
	} catch (error) {
		logger.error('Failed to save port to config:', error);
		throw error;
	}
}

export function getPort(): number | null {
	try {
		if (!process.env.WORKSPACE_ID) {
			throw new Error('WORKSPACE_ID environment variable is required for MCP server process');
		}

		const workspaceId = process.env.WORKSPACE_ID;
		const config = readMcpConfig();
		const port = config[workspaceId];

		if (port) {
			logger.info(`DevDB: Read port ${port} for workspace ${workspaceId} from ${MCP_CONFIG_FILE}`);
			return port;
		} else {
			logger.info(`DevDB: No port found for workspace ${workspaceId} in ${MCP_CONFIG_FILE}`);
			return null;
		}
	} catch (error) {
		logger.error('Failed to read port from config:', error);
		return null;
	}
}

export function clearPort(workspaceId: string): void {
	try {
		const config = readMcpConfig();
		delete config[workspaceId];
		writeMcpConfig(config);
		logger.info(`DevDB: Cleared port for workspace ${workspaceId} from ${MCP_CONFIG_FILE}`);
	} catch (error) {
		logger.error('Failed to clear port from config:', error);
	}
}