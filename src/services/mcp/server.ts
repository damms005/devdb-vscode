import path from 'path'
import { z } from 'zod';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getPort } from "./port-manager";
import { getConnectedDatabase } from "../messenger";
import { getWorkspaceId } from './http-server';

const server = new McpServer({
	name: "DevDB",
	version: "1.0.2"
});

server.registerTool('run-query', { title: 'Run a query', description: 'Run a query', inputSchema: { query: z.string() } }, (async (r: any) => {
	const query = r.query;
	try {
		const db = await getConnectedDatabase();
		if (!db) return {
			content: [{
				type: 'text',
				text: 'No DB connected'
			}]
		};
		const result = await db.rawQuery(query);
		return {
			content: [{
				type: 'text',
				text: JSON.stringify(result)
			}]
		};
	} catch (error) {
		return {
			content: [{
				type: 'text',
				text: `Error running query: ${(error as Error).message}`
			}]
		};
	}
}) as any);

server.registerResource(
	"tables",
	new ResourceTemplate("db://tables", { list: undefined }),
	{ title: 'Get tables', description: 'Get list of tables in current database' },
	async (uri) => {
		try {
			const tables = await fetchTables();
			return {
				contents: [{
					uri: uri.href,
					text: JSON.stringify(tables)
				}]
			};
		} catch (error) {
			return {
				contents: [{
					uri: uri.href,
					text: `Error fetching tables: ${(error as Error).message}`
				}]
			};
		}
	},
);

server.registerResource(
	"schema",
	new ResourceTemplate("db://tables/{table}/schema", { list: undefined }),
	{ title: 'Get table schema', description: 'Get schema for specified table' },
	async (uri, { table }) => {
		if (typeof table !== 'string') {
			return {
				contents: [{
					uri: uri.href,
					text: 'Invalid table name'
				}]
			};
		}

		try {
			const schema = await fetchTableSchema(table);
			return {
				contents: [{
					uri: uri.href,
					text: schema
				}]
			};
		} catch (error) {
			return {
				contents: [{
					uri: uri.href,
					text: `Error fetching schema: ${(error as Error).message}`
				}]
			};
		}
	},
);

async function main() {
	const transport = new StdioServerTransport();
	server.connect(transport)
	console.info('DevDB MCP Server ready');
}

main().catch((error) => {
	console.error("Fatal error in main():", error);
	process.exit(1);
});


export function getMcpConfig() {
	/**
	 * Get actual path even after building
	 *
	 * @see https://github.com/damms005/devdb-vscode/blob/f0f6e12616c860027e882eed9c602066e998aa1f/esbuild.js#L8
	 */
	const scriptPath = path.join(__dirname, 'services/mcp/server.js')

	return {
		'devdb-mcp-server': {
			command: 'node',
			args: [scriptPath],
			env: {
				'WORKSPACE_ID': getWorkspaceId()
			}
		}
	}
}

function getServerUrl(): string {
	const port = getPort();
	if (!port) {
		throw new Error('MCP HTTP server port not available. Make sure the HTTP server is running.');
	}
	return `http://localhost:${port}`;
}

async function fetchTables(): Promise<string[]> {
	const baseUrl = getServerUrl();
	const resp = await fetch(`${baseUrl}/tables`);
	if (!resp.ok) {
		throw new Error('Could not establish database connection');
	}
	const { tables } = await resp.json() as { tables: string[] };
	return tables;
}

async function fetchTableSchema(name: string): Promise<string> {
	const baseUrl = getServerUrl();
	const resp = await fetch(`${baseUrl}/tables/${encodeURIComponent(name)}/schema`);
	if (!resp.ok) {
		throw new Error('Could not establish database connection');
	}
	const { schema } = await resp.json() as { schema: string };
	return schema;
}