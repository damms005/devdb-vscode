import path from 'path'
import { z } from 'zod';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
			args: [scriptPath]
		}
	}
}

async function fetchTables(): Promise<string[]> {
	const resp = await fetch('http://localhost:50001/tables');
	if (!resp.ok) {
		throw new Error('Could not establish database connection');
	}
	const { tables } = await resp.json() as { tables: string[] };
	return tables;
}

async function fetchTableSchema(name: string): Promise<string> {
	const resp = await fetch(`http://localhost:50001/tables/${encodeURIComponent(name)}/schema`);
	if (!resp.ok) {
		throw new Error('Could not establish database connection');
	}
	const { schema } = await resp.json() as { schema: string };
	return schema;
}

const server = new McpServer({
	name: "DevDB",
	version: "1.0.1"
});

server.resource(
	"Get list of tables in current database",
	"db://tables",
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
	}
);

server.resource(
	"Get schema for specified table",
	new ResourceTemplate("db://tables/{tableName}/schema", { list: undefined }),
	async (uri, { tableName }) => {
		if (typeof tableName !== 'string') {
			return {
				contents: [{
					uri: uri.href,
					text: 'Invalid table name'
				}]
			};
		}

		try {
			const schema = await fetchTableSchema(tableName);
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
	}
);

server.tool('list-tables', 'List all tables in the current database', (async () => {
	try {
		const tables = await fetchTables();
		return {
			content: [JSON.stringify(tables)]
		};
	} catch (error) {
		return {
			content: [`Error fetching tables: ${(error as Error).message}`]
		};
	}
}) as any);

server.tool('get-table-schema', 'Get schema for specified table', { tableName: z.string() }, (async (r: any) => {
	console.log(r)
	const tableName = r.tableName;
	try {
		const schema = await fetchTableSchema(tableName);
		return {
			content: [schema]
		};
	} catch (error) {
		return {
			content: [`Error fetching schema: ${(error as Error).message}`]
		};
	}
}) as any);

async function main() {
	const transport = new StdioServerTransport();
	server.connect(transport)
	console.error('DevDB MCP Server ready');
}

main().catch((error) => {
	console.error("Fatal error in main():", error);
	process.exit(1);
});
