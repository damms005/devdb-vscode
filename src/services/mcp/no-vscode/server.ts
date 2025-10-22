import { z } from 'zod';
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getPort } from "./port-manager";
import logger from './logger';

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
	logger.info('Executing query', { query });
	try {
		const result = await executeQuery(query);
		logger.info('Query executed successfully', { query, resultLength: JSON.stringify(result).length });
		return {
			content: [{
				type: 'text',
				text: JSON.stringify(result)
			}]
		};
	} catch (error) {
		logger.error('Query execution failed', { query, error: String(error) });
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
		logger.info('Fetching tables resource', { uri: uri.href });
		try {
			const tables = await fetchTables();
			logger.info('Tables resource fetched successfully', { uri: uri.href, tableCount: tables.length });
			return {
				contents: [{
					uri: uri.href,
					text: JSON.stringify(tables)
				}]
			};
		} catch (error) {
			logger.error('Tables resource fetch failed', { uri: uri.href, error: String(error) });
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
		logger.info('Fetching schema resource', { uri: uri.href, table });
		if (typeof table !== 'string') {
			logger.error('Schema resource invalid table name', { uri: uri.href, table });
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
			logger.info('Schema resource fetched successfully', { uri: uri.href, table, schemaLength: schema.length });
			return {
				contents: [{
					uri: uri.href,
					text: schema
				}]
			};
		} catch (error) {
			logger.error('Schema resource fetch failed', { uri: uri.href, table, error: String(error) });
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

server.registerResource(
	"database-type",
	"db://database-type",
	{ title: 'Get database type', description: 'Get the database type (e.g. mysql2, postgres, mssql, etc.) to determine SQL syntax to use for raw queries' },
	async (uri) => {
		logger.info('Fetching database type resource', { uri: uri.href });
		try {
			const databaseType = await fetchDatabaseType();
			logger.info('Database type fetched successfully', { uri: uri.href, databaseType });
			return {
				contents: [{
					uri: uri.href,
					text: JSON.stringify({ type: databaseType })
				}]
			};
		} catch (error) {
			logger.error('Database type fetch failed', { uri: uri.href, error: String(error) });
			return {
				contents: [{
					uri: uri.href,
					text: `Error in 'database-type' resource: ${String(error)}`
				}],
				isError: true
			};
		}
	},
);

async function main() {
	logger.info('Starting MCP server');
	const transport = new StdioServerTransport();
	await server.connect(transport);
	logger.info('MCP server connected successfully');
}

main().catch((error) => {
	logger.error('Failed to start MCP server', { error: String(error) });
	process.exit(1);
});

function getServerUrl(): string {
	const port = getPort();
	if (!port) {
		logger.error('MCP HTTP server port not available');
		throw new Error('MCP HTTP server port not available. Make sure the HTTP server is running.');
	}
	logger.debug('Using server URL', { port, url: `http://localhost:${port}` });
	return `http://localhost:${port}`;
}

async function fetchTables(): Promise<string[]> {
	const baseUrl = getServerUrl();
	logger.debug('Fetching tables from HTTP server', { baseUrl });
	const resp = await fetch(`${baseUrl}/tables`);
	if (!resp.ok) {
		logger.error('Failed to fetch tables from HTTP server', { baseUrl, status: resp.status, statusText: resp.statusText });
		throw new Error('Could not establish database connection');
	}
	const { tables } = await resp.json() as { tables: string[] };
	logger.debug('Tables fetched successfully', { baseUrl, tableCount: tables.length });
	return tables;
}

async function fetchTableSchema(name: string): Promise<string> {
	const baseUrl = getServerUrl();
	logger.debug('Fetching table schema from HTTP server', { baseUrl, tableName: name });
	const resp = await fetch(`${baseUrl}/tables/${encodeURIComponent(name)}/schema`);
	if (!resp.ok) {
		logger.error('Failed to fetch table schema from HTTP server', { baseUrl, tableName: name, status: resp.status, statusText: resp.statusText });
		throw new Error('Could not establish database connection');
	}
	const { schema } = await resp.json() as { schema: string };
	logger.debug('Table schema fetched successfully', { baseUrl, tableName: name, schemaLength: schema.length });
	return schema;
}

async function executeQuery(query: string): Promise<any> {
	const baseUrl = getServerUrl();
	logger.debug('Executing query via HTTP server', { baseUrl, query });
	const resp = await fetch(`${baseUrl}/query`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ query })
	});
	if (!resp.ok) {
		const errorData: { message: string } = await resp.json().catch(() => ({ message: 'Unknown DevDb MCP error' })) as any;
		logger.error('Query execution failed via HTTP server', { baseUrl, query, status: resp.status, statusText: resp.statusText, error: errorData.message });
		throw new Error(errorData.message);
	}
	const { result } = await resp.json() as { result: any };
	logger.debug('Query executed successfully via HTTP server', { baseUrl, query, resultLength: JSON.stringify(result).length });
	return result;
}

async function fetchDatabaseType(): Promise<string> {
	const baseUrl = getServerUrl();
	logger.debug('Fetching database type from HTTP server', { baseUrl });
	const resp = await fetch(`${baseUrl}/database-type`);
	if (!resp.ok) {
		logger.error('Failed to fetch database type from HTTP server', { baseUrl, status: resp.status, statusText: resp.statusText });
		throw new Error('Could not establish database connection');
	}
	const { type } = await resp.json() as { type: string };
	logger.debug('Database type fetched successfully', { baseUrl, type });
	return type;
}