import * as vscode from 'vscode';
import { parse } from 'dotenv';
import { LibsqlEngine } from '../../database-engines/libsql-engine';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { getWorkspaceFileContent } from '../../services/workspace';
import { logToOutput } from '../../services/output-service';
import { hasProLicense } from '../../services/pro-gate';
import { errorMessage } from '../../services/remote-credential-service';

const LOG_TAG = 'Turso / libSQL';

const ENV_FILES = ['.env', '.env.local', '.dev.vars'] as const;

const DRIZZLE_CONFIG_FILES = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.cjs', 'drizzle.config.mts', 'drizzle.config.cts'] as const;

const URL_KEYS = ['TURSO_DATABASE_URL', 'TURSO_DB_URL', 'LIBSQL_URL', 'DATABASE_URL'];
const TOKEN_KEYS = ['TURSO_AUTH_TOKEN', 'TURSO_DB_AUTH_TOKEN', 'LIBSQL_AUTH_TOKEN', 'DATABASE_AUTH_TOKEN'];

export type TursoConnection = { url: string, authToken?: string, source: string };

export function isLibsqlUrl(url: string | undefined): boolean {
	return Boolean(url && /^(libsql|https?|wss?):\/\/[^\s]+$/i.test(url.trim()));
}

/**
 * Reads the libSQL URL and token from `.env`-style content. `DATABASE_URL` only counts when it
 * is a libsql:// URL, so a Postgres or MySQL URL is never taken for Turso.
 */
export function tursoConnectionFromEnv(env: Record<string, string>): { url: string, authToken?: string } | undefined {
	for (const key of URL_KEYS) {
		const url = env[key]?.trim();
		if (!url) continue;
		if (key === 'DATABASE_URL' ? !/^libsql:\/\//i.test(url) : !isLibsqlUrl(url)) continue;

		const authToken = TOKEN_KEYS.map(tokenKey => env[tokenKey]?.trim()).find(Boolean);
		return { url, authToken };
	}

	return undefined;
}

/**
 * Reads `dbCredentials` of a drizzle config with `dialect: 'turso'`. A value may be a string
 * literal or `process.env.NAME` (optionally with `!` or `?? ''`), resolved from `env`.
 */
export function tursoConnectionFromDrizzleConfig(source: string, env: Record<string, string>): { url: string, authToken?: string } | undefined {
	if (!/\bdialect\s*:\s*['"`]turso['"`]/.test(source)) return undefined;

	const resolveValue = (key: string): string | undefined => {
		const match = source.match(new RegExp(`\\b${key}\\s*:\\s*(?:['"\`]([^'"\`]+)['"\`]|process\\.env(?:\\.([A-Za-z_][A-Za-z0-9_]*)|\\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\\]))`));
		if (!match) return undefined;
		if (match[1]) return match[1];

		return env[match[2] ?? match[3]]?.trim() || undefined;
	};

	const url = resolveValue('url');
	if (!isLibsqlUrl(url)) return undefined;

	return { url: url!, authToken: resolveValue('authToken') };
}

function readEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const file of [...ENV_FILES].reverse()) {
		const content = getWorkspaceFileContent(file);
		if (content) Object.assign(env, parse(content));
	}

	return env;
}

/**
 * Finds a libSQL connection: `.env`/`.env.local`/`.dev.vars` first, then a drizzle config with
 * `dialect: 'turso'`.
 */
export function resolveTursoConnection(): TursoConnection | undefined {
	const env = readEnv();

	const fromEnv = tursoConnectionFromEnv(env);
	if (fromEnv) return { ...fromEnv, source: '.env' };

	for (const file of DRIZZLE_CONFIG_FILES) {
		const content = getWorkspaceFileContent(file)?.toString();
		if (!content) continue;

		const fromDrizzle = tursoConnectionFromDrizzleConfig(content, env);
		if (fromDrizzle) return { ...fromDrizzle, source: file };
	}

	return undefined;
}

export function describeLibsqlUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return 'libSQL';
	}
}

/**
 * Turso / libSQL from the workspace. Pro: without a license it only reports that a database
 * was found (no request is sent), so the webview can show it as a locked row.
 */
export const TursoProvider: DatabaseEngineProvider = {
	name: 'Turso / libSQL',
	type: 'sqlite',
	id: 'turso',
	description: 'Turso / libSQL database from .env or drizzle.config',
	engine: undefined as LibsqlEngine | undefined,

	async boot(): Promise<void> {
		this.engine = undefined;
	},

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		const connection = resolveTursoConnection();
		if (!connection) return false;

		this.description = `${describeLibsqlUrl(connection.url)} (from ${connection.source})`;

		if (!hasProLicense()) {
			logToOutput('Turso / libSQL database found; it needs a DevDb Pro license', LOG_TAG);
			return true;
		}

		const engine = new LibsqlEngine({ url: connection.url, authToken: connection.authToken });
		if (!(await engine.isOkay())) {
			logToOutput(`Could not reach ${describeLibsqlUrl(connection.url)}`, LOG_TAG);
			await engine.disconnect();
			return false;
		}

		this.engine = engine;
		return true;
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace();
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		if (this.engine) return this.engine;

		const connection = resolveTursoConnection();
		if (!connection) return undefined;

		const engine = new LibsqlEngine({ url: connection.url, authToken: connection.authToken });
		try {
			await engine.getTables();
		} catch (error) {
			vscode.window.showErrorMessage(`Turso / libSQL: ${errorMessage(error)}`);
			return undefined;
		}

		this.engine = engine;
		return engine;
	},
};
