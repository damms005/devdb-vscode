import * as path from 'path';
import * as os from 'os';

export const MCP_CONFIG_DIR = path.join(os.homedir(), '.devdb');
export const MCP_CONFIG_FILE = path.join(MCP_CONFIG_DIR, 'mcp.json');
