import { z } from 'zod';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getPort } from "./port-manager";

const server = new McpServer({
	name: "DevDB",
	version: "1.0.2"
}, {
	capabilities: {
		"resources": {
			"subscribe": false,
			"listChanged": false,
		}
	}
});

server.registerTool('run-query', { title: 'Run a query', description: 'Run a query', inputSchema: { query: z.string() } }, (async (r: any) => {
	const query = r.query;
	try {
		const result = await executeQuery(query);
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
				text: String(error)
			}],
			isError: true
		};
	}
}) as any);

server.registerResource(
	"tables",
	"db://tables",
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
					text: `Error in 'tables' resource: ${String(error)}`
				}],
				isError: true
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
					text: "Error in 'schema' resource: Invalid table name"
				}],
				isError: true
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
					text: `Error in 'schema' resource: ${String(error)}`
				}],
				isError: true
			};
		}
	},
);

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	console.error('Failed to start MCP server:', error);
	process.exit(1);
});

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

async function executeQuery(query: string): Promise<any> {
	const baseUrl = getServerUrl();
	const resp = await fetch(`${baseUrl}/query`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ query })
	});
	if (!resp.ok) {
		const errorData = await resp.json().catch(() => ({ message: 'Unknown DevDb MCP error' }));
		throw new Error((errorData as { message: string }).message);
	}
	const { result } = await resp.json() as { result: any };
	return result;
}