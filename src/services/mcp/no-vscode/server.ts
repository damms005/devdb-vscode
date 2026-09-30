import { z } from 'zod';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getServerEntry } from "./port-manager";
import logger from './logger';
import * as path from 'path';
import * as fs from 'fs';
import { validateQuery, getQueryType } from '../query-validator';

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
		description: 'Run a read-only query (SQL, or a Redis command for Redis). Writes are blocked unless the user enables Devdb.mcp.allowWrites.',
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

		let engine: { type: string, allowWrites: boolean };
		try {
			engine = await fetchEngineInfo(projectRoot);
		} catch (error) {
			return {
				content: [{ type: 'text', text: String(error) }],
				isError: true,
			};
		}

		const validation = validateQuery(query, engine.type, { allowWrites: engine.allowWrites });
		if (!validation.allowed) {
			logger.warn('Blocked query via MCP stdio', { queryType: getQueryType(query) });
			return {
				content: [{ type: 'text', text: validation.warning || 'Query blocked' }],
				isError: true,
			};
		}
		if (validation.warning) {
			logger.warn('Destructive query warning', { queryType: getQueryType(query), warning: validation.warning });
		}

		logger.info('Executing new query', { queryType: getQueryType(query), queryLength: query.length });
		try {
			const result = await executeQuery(projectRoot, query);
			logger.info('Query executed successfully', { queryType: getQueryType(query), resultLength: JSON.stringify(result).length });
			return {
				content: [{
					type: 'text',
					text: JSON.stringify(result)
				}]
			};
		} catch (error) {
			logger.error('Query execution failed', { queryType: getQueryType(query), error: String(error) });
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

/**
 * Sends an authenticated request to the extension host HTTP server of the project.
 */
async function callServer(projectRoot: string, route: string, init: { method?: string, body?: string } = {}): Promise<{ resp: Response, baseUrl: string }> {
	const entry = getServerEntry(projectRoot);
	if (!entry) {
		logger.error('MCP HTTP server port not available', { projectRoot });
		throw new Error(`MCP server not running for project: ${projectRoot}`);
	}
	if (!entry.token) {
		logger.error('MCP HTTP server token not available', { projectRoot });
		throw new Error('MCP server token not found. Reload the VS Code window to restart DevDb.');
	}
	const baseUrl = `http://127.0.0.1:${entry.port}`;
	const resp = await fetch(`${baseUrl}${route}`, {
		method: init.method ?? 'GET',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${entry.token}`,
		},
		body: init.body,
	});
	return { resp, baseUrl };
}

async function fetchTables(projectRoot: string): Promise<string[]> {
	const { resp, baseUrl } = await callServer(projectRoot, '/tables');
	if (!resp.ok) {
		logger.error('Failed to fetch tables from HTTP server', { baseUrl, projectRoot, status: resp.status, statusText: resp.statusText });
		throw new Error('Could not establish database connection');
	}
	const { tables } = await resp.json() as { tables: string[] };
	logger.debug('Tables fetched successfully', { baseUrl, projectRoot, tableCount: tables.length });
	return tables;
}

async function fetchTableSchema(projectRoot: string, name: string): Promise<string> {
	const { resp, baseUrl } = await callServer(projectRoot, `/tables/${encodeURIComponent(name)}/schema`);
	if (!resp.ok) {
		logger.error('Failed to fetch table schema from HTTP server', { baseUrl, projectRoot, status: resp.status, statusText: resp.statusText });
		throw new Error('Could not establish database connection');
	}
	const { schema } = await resp.json() as { schema: string };
	logger.debug('Table schema fetched successfully', { baseUrl, projectRoot, schemaLength: schema.length });
	return schema;
}

async function executeQuery(projectRoot: string, query: string): Promise<any> {
	const { resp, baseUrl } = await callServer(projectRoot, '/query', { method: 'POST', body: JSON.stringify({ query }) });
	if (!resp.ok) {
		const errorData = await resp.json().catch(() => ({})) as { error?: string, message?: string };
		const message = errorData.error ?? errorData.message ?? 'Unknown DevDb MCP error';
		logger.error('Query execution failed via HTTP server', { baseUrl, projectRoot, queryType: getQueryType(query), status: resp.status, statusText: resp.statusText, error: message });
		throw new Error(message);
	}
	const { result } = await resp.json() as { result: any };
	logger.debug('Query executed successfully via HTTP server', { baseUrl, projectRoot, queryType: getQueryType(query), resultLength: JSON.stringify(result ?? null).length });
	return result;
}

/**
 * Engine type and write permission come from the extension host. When it cannot tell, MCP stays read-only.
 */
async function fetchEngineInfo(projectRoot: string): Promise<{ type: string, allowWrites: boolean }> {
	const { resp, baseUrl } = await callServer(projectRoot, '/database-type');
	if (!resp.ok) {
		logger.error('Failed to fetch database type from HTTP server', { baseUrl, projectRoot, status: resp.status, statusText: resp.statusText });
		throw new Error('Could not establish database connection');
	}
	const { type, allowWrites } = await resp.json() as { type: string, allowWrites?: unknown };
	logger.debug('Database type fetched successfully', { baseUrl, projectRoot, type });
	return { type, allowWrites: allowWrites === true };
}

async function fetchDatabaseType(projectRoot: string): Promise<string> {
	return (await fetchEngineInfo(projectRoot)).type;
}