import { z } from 'zod';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getPort } from "./port-manager";
import logger from './logger';
import * as path from 'path';
import * as fs from 'fs';

const server = new McpServer({
	name: "DevDB",
	version: "1.1.0"
}, {
	capabilities: {
		tools: {
			listChanged: false
		}
	}
});

server.registerTool(
	'get-tables',
	{
		title: 'Get tables',
		description: 'Get list of tables in database',
		inputSchema: {
			projectRoot: z.string().describe('Absolute path to the root of the project. e.g. /Users/path/to/project')
		}
	},
	async ({ projectRoot }) => {
		if (!path.isAbsolute(projectRoot)) {
			return {
				content: [{
					type: 'text',
					text: 'Error: projectRoot must be an absolute path'
				}],
				isError: true
			};
		}

		if (!fs.existsSync(projectRoot)) {
			return {
				content: [{
					type: 'text',
					text: 'Error: projectRoot does not exist'
				}],
				isError: true
			};
		}

		try {
			const tables = await fetchTables(projectRoot);
			return {
				content: [{
					type: 'text',
					text: JSON.stringify(tables)
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
	}
);

server.registerTool(
	'get-schema',
	{
		title: 'Get table schema',
		description: 'Get schema for specified table',
		inputSchema: {
			projectRoot: z.string().describe('Absolute path to the root of the project. e.g. /Users/path/to/project'),
			table: z.string().describe('Name of the table to get schema for')
		}
	},
	async ({ projectRoot, table }) => {
		if (!path.isAbsolute(projectRoot)) {
			return {
				content: [{
					type: 'text',
					text: 'Error: projectRoot must be an absolute path'
				}],
				isError: true
			};
		}

		if (!fs.existsSync(projectRoot)) {
			return {
				content: [{
					type: 'text',
					text: 'Error: projectRoot does not exist'
				}],
				isError: true
			};
		}

		try {
			const schema = await fetchTableSchema(projectRoot, table);
			return {
				content: [{
					type: 'text',
					text: schema
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
	}
);

server.registerTool(
	'get-database-type',
	{
		title: 'Get database type',
		description: 'Get database type to determine SQL syntax',
		inputSchema: {
			projectRoot: z.string().describe('Absolute path to the root of the project. e.g. /Users/path/to/project')
		}
	},
	async ({ projectRoot }) => {
		if (!path.isAbsolute(projectRoot)) {
			return {
				content: [{
					type: 'text',
					text: 'Error: projectRoot must be an absolute path'
				}],
				isError: true
			};
		}

		if (!fs.existsSync(projectRoot)) {
			return {
				content: [{
					type: 'text',
					text: 'Error: projectRoot does not exist'
				}],
				isError: true
			};
		}

		try {
			const type = await fetchDatabaseType(projectRoot);
			return {
				content: [{
					type: 'text',
					text: type
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
	}
);

server.registerTool(
	'run-query',
	{
		title: 'Run a query',
		description: 'Run a SQL query',
		inputSchema: {
			projectRoot: z.string().describe('Absolute path to the root of the project. e.g. /Users/path/to/project'),
			query: z.string().describe('SQL query to run')
		}
	},
	async ({ projectRoot, query }) => {
		if (!path.isAbsolute(projectRoot)) {
			return {
				content: [{
					type: 'text',
					text: 'Error: projectRoot must be an absolute path'
				}],
				isError: true
			};
		}

		if (!fs.existsSync(projectRoot)) {
			return {
				content: [{
					type: 'text',
					text: 'Error: projectRoot does not exist'
				}],
				isError: true
			};
		}

		logger.info('Executing new query', { query });
		try {
			const result = await executeQuery(projectRoot, query);
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
	}
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

function getServerUrl(projectRoot: string): string {
	const port = getPort(projectRoot);
	if (!port) {
		logger.error('MCP HTTP server port not available', { projectRoot });
		throw new Error(`MCP server not running for project: ${projectRoot}`);
	}
	logger.debug('Using server URL', { port, projectRoot, url: `http://localhost:${port}` });
	return `http://localhost:${port}`;
}

async function fetchTables(projectRoot: string): Promise<string[]> {
	const baseUrl = getServerUrl(projectRoot);
	logger.debug('Fetching tables from HTTP server', { baseUrl, projectRoot });
	const resp = await fetch(`${baseUrl}/tables`);
	if (!resp.ok) {
		logger.error('Failed to fetch tables from HTTP server', { baseUrl, projectRoot, status: resp.status, statusText: resp.statusText });
		throw new Error('Could not establish database connection');
	}
	const { tables } = await resp.json() as { tables: string[] };
	logger.debug('Tables fetched successfully', { baseUrl, projectRoot, tableCount: tables.length });
	return tables;
}

async function fetchTableSchema(projectRoot: string, name: string): Promise<string> {
	const baseUrl = getServerUrl(projectRoot);
	logger.debug('Fetching table schema from HTTP server', { baseUrl, projectRoot, tableName: name });
	const resp = await fetch(`${baseUrl}/tables/${encodeURIComponent(name)}/schema`);
	if (!resp.ok) {
		logger.error('Failed to fetch table schema from HTTP server', { baseUrl, projectRoot, tableName: name, status: resp.status, statusText: resp.statusText });
		throw new Error('Could not establish database connection');
	}
	const { schema } = await resp.json() as { schema: string };
	logger.debug('Table schema fetched successfully', { baseUrl, projectRoot, tableName: name, schemaLength: schema.length });
	return schema;
}

async function executeQuery(projectRoot: string, query: string): Promise<any> {
	const baseUrl = getServerUrl(projectRoot);
	logger.debug('Executing query via HTTP server', { baseUrl, projectRoot, query });
	const resp = await fetch(`${baseUrl}/query`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ query })
	});
	if (!resp.ok) {
		const errorData: { message: string } = await resp.json().catch(() => ({ message: 'Unknown DevDb MCP error' })) as any;
		logger.error('Query execution failed via HTTP server', { baseUrl, projectRoot, query, status: resp.status, statusText: resp.statusText, error: errorData.message });
		throw new Error(errorData.message);
	}
	const { result } = await resp.json() as { result: any };
	logger.debug('Query executed successfully via HTTP server', { baseUrl, projectRoot, query, resultLength: JSON.stringify(result).length });
	return result;
}

async function fetchDatabaseType(projectRoot: string): Promise<string> {
	const baseUrl = getServerUrl(projectRoot);
	logger.debug('Fetching database type from HTTP server', { baseUrl, projectRoot });
	const resp = await fetch(`${baseUrl}/database-type`);
	if (!resp.ok) {
		logger.error('Failed to fetch database type from HTTP server', { baseUrl, projectRoot, status: resp.status, statusText: resp.statusText });
		throw new Error('Could not establish database connection');
	}
	const { type } = await resp.json() as { type: string };
	logger.debug('Database type fetched successfully', { baseUrl, projectRoot, type });
	return type;
}