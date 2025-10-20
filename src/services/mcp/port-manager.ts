import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MCP_CONFIG_DIR = path.join(os.homedir(), '.devdb');
const MCP_CONFIG_FILE = path.join(MCP_CONFIG_DIR, 'mcp.json');

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
		console.error('Failed to read MCP config file:', error);
	}
	return {};
}

function writeMcpConfig(config: McpConfig): void {
	try {
		ensureConfigDir();
		fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
	} catch (error) {
		console.error('Failed to write MCP config file:', error);
		throw error;
	}
}

export function savePort(port: number, workspaceId: string): void {
	try {
		const config = readMcpConfig();
		config[workspaceId] = port;
		writeMcpConfig(config);
		console.log(`DevDB: Saved port ${port} for workspace ${workspaceId} to ${MCP_CONFIG_FILE}`);
	} catch (error) {
		console.error('Failed to save port to config:', error);
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
			console.log(`DevDB: Read port ${port} for workspace ${workspaceId} from ${MCP_CONFIG_FILE}`);
			return port;
		} else {
			console.log(`DevDB: No port found for workspace ${workspaceId} in ${MCP_CONFIG_FILE}`);
			return null;
		}
	} catch (error) {
		console.error('Failed to read port from config:', error);
		return null;
	}
}

export function clearPort(workspaceId: string): void {
	try {
		const config = readMcpConfig();
		delete config[workspaceId];
		writeMcpConfig(config);
		console.log(`DevDB: Cleared port for workspace ${workspaceId} from ${MCP_CONFIG_FILE}`);
	} catch (error) {
		console.error('Failed to clear port from config:', error);
	}
}