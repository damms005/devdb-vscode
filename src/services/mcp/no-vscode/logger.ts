import * as path from 'path';
import * as winston from 'winston';
import { MCP_CONFIG_DIR } from './config';

const logger = winston.createLogger({
	level: 'info',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.errors({ stack: true }),
		winston.format.json()
	),
	defaultMeta: { service: 'devdb-mcp-server' },
	transports: [
		new winston.transports.File({ filename: path.join(MCP_CONFIG_DIR, 'mcp-log.txt') }),
	],
});


export default logger