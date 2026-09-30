import * as fs from 'fs';
import * as path from 'path';
import * as winston from 'winston';
import { MCP_CONFIG_DIR } from './config';

export const MCP_LOG_FILE = path.join(MCP_CONFIG_DIR, 'mcp-log.txt');

const URI_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s:@\/]*)(:[^\s@\/]*)?@/gi;
const SECRET_PARAMS = /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)=([^\s&;"']+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/=-]+/g;

/** Removes credentials from URIs and key=value secrets in a string. */
export function redactSecrets(text: string): string {
	return text
		.replace(URI_CREDENTIALS, (_m, scheme) => `${scheme}***:***@`)
		.replace(SECRET_PARAMS, (_m, key) => `${key}=***`)
		.replace(BEARER, 'Bearer ***');
}

function redactValue(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') {
		return redactSecrets(value);
	}
	if (depth > 5 || !value || typeof value !== 'object' || value instanceof Error) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(item => redactValue(item, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] = /^(password|token|secret|authorization|connectionString|uri|url)$/i.test(key) && typeof item === 'string'
			? redactSecrets(item)
			: redactValue(item, depth + 1);
	}
	return out;
}

const redact = winston.format((info) => {
	for (const key of Object.keys(info)) {
		info[key] = redactValue(info[key]);
	}
	return info;
});

function ensurePrivateLogFile(): void {
	try {
		fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true, mode: 0o700 });
		if (fs.existsSync(MCP_LOG_FILE)) {
			fs.chmodSync(MCP_LOG_FILE, 0o600);
		}
	} catch {
		// logging must not break the MCP server
	}
}

ensurePrivateLogFile();

const logger = winston.createLogger({
	level: 'info',
	format: winston.format.combine(
		redact(),
		winston.format.timestamp(),
		winston.format.errors({ stack: true }),
		winston.format.json()
	),
	defaultMeta: { service: 'devdb-mcp-server' },
	transports: [
		new winston.transports.File({ filename: MCP_LOG_FILE, options: { flags: 'a', mode: 0o600 } }),
	],
});


export default logger
