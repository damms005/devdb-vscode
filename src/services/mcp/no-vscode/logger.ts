import * as path from 'path';
import * as winston from 'winston';
import { MCP_CONFIG_DIR } from './config';

const logger = winston.createLogger({
	level: 'info',
	format: winston.format.json(),
	defaultMeta: { service: 'devdb-mcp-port-manager' },
	transports: [
		new winston.transports.File({ filename: path.join(MCP_CONFIG_DIR, 'error.log'), level: 'error' }),
		new winston.transports.File({ filename: path.join(MCP_CONFIG_DIR, 'combined.log') }),
	],
});

if (process.env.DEBUG_MODE === 'true') {
	logger.add(new winston.transports.Console({
		format: winston.format.simple(),
	}));
}

export default logger