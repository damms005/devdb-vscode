import express, { Request, Response, NextFunction } from "express";
import * as crypto from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { DatabaseEngine } from '../../types';
import logger from './no-vscode/logger';
import { validateQuery, getQueryType } from './query-validator';

export const MCP_HOST = '127.0.0.1';

export type McpAppDeps = {
	/** Per-session bearer token clients must send. */
	token: string;
	getDatabase: () => DatabaseEngine | null | undefined;
	/** Value of the `Devdb.mcp.allowWrites` setting. */
	allowWrites: () => boolean;
	/** Asks the user to confirm a destructive query. Resolves true to run it. */
	confirmDestructive: (warning: string) => Promise<boolean>;
	onRejected?: (message: string) => void;
};

type RawQueryWithOptions = (code: string, options?: { readOnly?: boolean }) => Promise<any>;

export function generateToken(): string {
	return crypto.randomBytes(32).toString('hex');
}

/** Constant-time string compare. */
export function tokensMatch(expected: string, received: string): boolean {
	const a = crypto.createHash('sha256').update(expected).digest();
	const b = crypto.createHash('sha256').update(received).digest();
	return crypto.timingSafeEqual(a, b) && expected.length > 0;
}

export function createMcpApp(deps: McpAppDeps): express.Express {
	const app = express();
	app.disable('x-powered-by');

	// DNS rebinding and browser (CSRF) protection
	app.use((req: Request, res: Response, next: NextFunction) => {
		const port = req.socket.localPort;
		const host = req.headers.host ?? '';
		if (host !== `${MCP_HOST}:${port}` && host !== `localhost:${port}`) {
			logger.warn('Rejected MCP request with invalid Host header', { method: req.method, path: req.path });
			deps.onRejected?.('Rejected MCP request with invalid Host header');
			return res.status(403).json({ error: 'Forbidden: invalid Host header' });
		}
		if (req.headers.origin !== undefined) {
			logger.warn('Rejected MCP request with Origin header', { method: req.method, path: req.path });
			deps.onRejected?.('Rejected MCP request from a browser origin');
			return res.status(403).json({ error: 'Forbidden: cross-origin requests are not allowed' });
		}
		next();
	});

	app.use((req: Request, res: Response, next: NextFunction) => {
		const header = req.headers.authorization ?? '';
		const match = header.match(/^Bearer\s+(\S+)$/);
		if (!match || !tokensMatch(deps.token, match[1])) {
			logger.warn('Rejected MCP request with missing or invalid token', { method: req.method, path: req.path });
			return res.status(401).json({ error: 'Unauthorized' });
		}
		next();
	});

	app.use(express.json({ limit: '1mb' }));

	app.get('/tables', async function (_req: Request, res: Response) {
		logger.debug('HTTP request: GET /tables');
		const db = deps.getDatabase();
		if (!db) {
			logger.error('No database connected for /tables request');
			return res.status(500).json({ error: 'No DB connected' });
		}
		const tables = await db.getTables();
		logger.debug('Successfully fetched tables', { tableCount: tables.length });
		res.json({ tables });
	});

	app.get('/tables/:tableName/schema', async function (req: Request, res: Response) {
		const tableName = String(req.params.tableName);
		logger.debug('HTTP request: GET /tables/:tableName/schema');
		const db = deps.getDatabase();
		if (!db) {
			logger.error('No database connected for schema request');
			return res.status(500).json({ error: 'No DB connected' });
		}
		const sql = await db.getTableCreationSql(tableName);
		logger.debug('Successfully fetched table schema', { schemaLength: sql.length });
		res.json({ schema: sql });
	});

	app.post('/query', async function (req: Request, res: Response) {
		const query = req.body?.query;
		if (typeof query !== 'string' || !query) {
			logger.error('Query is required but not provided');
			return res.status(400).json({ error: 'Query is required' });
		}
		const queryType = getQueryType(query);
		logger.info('HTTP request: POST /query', { queryType, queryLength: query.length });

		const db = deps.getDatabase();
		if (!db) {
			logger.error('No database connected for query request', { queryType });
			return res.status(500).json({ error: 'No DB connected' });
		}

		const allowWrites = deps.allowWrites();
		const validation = validateQuery(query, db.getType(), { allowWrites });
		if (!validation.allowed) {
			logger.warn('Blocked query via MCP HTTP', { queryType });
			return res.status(403).json({ error: validation.warning, blocked: true });
		}
		if (validation.destructive) {
			logger.warn('Destructive query needs confirmation', { queryType, warning: validation.warning });
			const confirmed = await deps.confirmDestructive(validation.warning ?? `${queryType} statement`);
			if (!confirmed) {
				return res.status(403).json({ error: 'Query cancelled by the user', blocked: true });
			}
		}

		try {
			const rawQuery = db.rawQuery as RawQueryWithOptions;
			const result = await rawQuery.call(db, query, { readOnly: !allowWrites });
			logger.info('Query executed successfully', { queryType, resultLength: JSON.stringify(result ?? null).length });
			res.json(Array.isArray(result) && (result as { truncated?: boolean }).truncated ? { result, truncated: true } : { result });
		} catch (error) {
			logger.error('Query execution failed', { queryType, error: (error as Error).message });
			res.status(500).json({ error: `Error running query: ${(error as Error).message}` });
		}
	});

	app.get('/database-type', async function (_req: Request, res: Response) {
		logger.debug('HTTP request: GET /database-type');
		const db = deps.getDatabase();
		if (!db) {
			logger.error('No database connected for /database-type request');
			return res.status(500).json({ error: 'No DB connected' });
		}
		const type = db.getType();
		res.json({ type, allowWrites: deps.allowWrites() });
	});

	return app;
}

export async function startServerOnAvailablePort(app: express.Express, startPort: number = 50001): Promise<{ server: Server, port: number }> {
	let currentPort = startPort;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return await new Promise((resolve, reject) => {
				const srv = app.listen(currentPort, MCP_HOST, () => {
					resolve({ server: srv, port: (srv.address() as AddressInfo).port });
				});
				srv.on('error', (err: NodeJS.ErrnoException) => {
					srv.close();
					reject(err);
				});
			});
		} catch (err: any) {
			if (err.code === 'EADDRINUSE') {
				currentPort++;
				if (currentPort > 65535) {
					throw new Error('No available ports found');
				}
				continue;
			}
			throw err;
		}
	}
	throw new Error('No available ports found after 100 attempts');
}
