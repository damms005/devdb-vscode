import path from 'path'
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export function getMcpConfig() {
	/**
	 * Get actual path even after building
	 *
	 * @see https://github.com/damms005/devdb-vscode/blob/f0f6e12616c860027e882eed9c602066e998aa1f/esbuild.js#L8
	 */
	const scriptPath = path.join(__dirname, 'services/mcp/api.js')
	return {
		'devdb-mcp-server': {
			command: 'node',
			args: [scriptPath]
		}
	}
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
			const resp = await fetch('http://localhost:50001/tables');
			if (!resp.ok) {
				return {
					contents: [{
						uri: uri.href,
						text: 'Could not establish database connection'
					}]
				};
			}

			const { tables } = await resp.json() as { tables: string[] };
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
			const resp = await fetch(`http://localhost:50001/tables/${encodeURIComponent(tableName)}/schema`);
			if (!resp.ok) {
				return {
					contents: [{
						uri: uri.href,
						text: 'Could not establish database connection'
					}]
				};
			}

			const { schema } = await resp.json() as { schema: string };
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

async function main() {
	const transport = new StdioServerTransport();
	server.connect(transport)
	console.error('DevDB MCP Server ready');
}

main().catch((error) => {
	console.error("Fatal error in main():", error);
	process.exit(1);
});