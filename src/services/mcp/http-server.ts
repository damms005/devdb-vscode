import express, { Request, Response, NextFunction } from "express";
import { logToOutput } from "../output-service";
import { getConnectedDatabase } from "../messenger";

let port: number | null = null;

export function startHttpServer() {
	if (port) {
		logToOutput('MCP HTTP server is already running', 'MCP Server');
		return;
	}

	logToOutput('Starting MCP HTTP server', 'MCP Server');

	const DEVDB_MCP_PORT = 50001;
	const app = express();
	app.use(express.json());

	app.use((req: Request, res: Response, next: NextFunction) => {
		const clientIp = req.ip || req.socket.remoteAddress;
		if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1') {
			next();
		} else {
			logToOutput(`Rejected connection from non-localhost IP: ${clientIp}`, 'MCP Server');
			res.status(403).send('Access denied: This server only accepts connections from localhost');
		}
	});

	app.get('/tables', async function (req: any, res: any) {
		const db = await getConnectedDatabase();
		if (!db) return res.status(500).json({ error: 'No DB connected' });
		const tables = await db.getTables();
		res.json({ tables });
	});

	app.get('/tables/:tableName/schema', async function (req: any, res: any) {
		const { tableName } = req.params;
		const db = await getConnectedDatabase();
		if (!db) return res.status(500).json({ error: 'No DB connected' });
		const sql = await db.getTableCreationSql(tableName);
		res.json({ schema: sql });
	});

	app.listen(DEVDB_MCP_PORT, () => {
		logToOutput(`MCP HTTP server listening on port ${DEVDB_MCP_PORT}`, 'MCP Server');
	});

	port = DEVDB_MCP_PORT;
	logToOutput('MCP HTTP server started', 'MCP Server');
}
