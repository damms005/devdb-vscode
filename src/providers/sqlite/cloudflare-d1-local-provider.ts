import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { basename } from 'path';
import { D1LocalSqliteEngine } from '../../database-engines/d1-local-sqlite-engine';
import { DatabaseEngine, DatabaseEngineProvider, EngineProviderCache, EngineProviderOption } from '../../types';
import { getBasePath } from '../../services/workspace';
import { logToOutput } from '../../services/output-service';
import {
	displayPath,
	findWranglerConfigFiles,
	LocalD1Database,
	resolveLocalD1Databases,
	unmappedLocalD1Files,
} from '../cloudflare/wrangler-config';

const LOG_TAG = 'Cloudflare D1 (local)';

/**
 * Local D1 bindings whose SQLite file does not exist yet, keyed by option id.
 */
const pendingDatabases = new Map<string, LocalD1Database>();

export function missingD1FileMessage(database: Pick<LocalD1Database, 'binding' | 'databaseName' | 'migrationsDir'>): string {
	const name = database.databaseName ?? database.binding;
	const migrate = `wrangler d1 migrations apply ${name} --local`;

	return `Cloudflare D1 (local) — ${database.binding} binding has no local database yet. Run \`${migrate}\` or \`wrangler dev\` first, then refresh DevDb.`;
}

/**
 * Builds the provider options for every local D1 binding in the workspace, plus any D1 SQLite
 * file that no binding maps to.
 */
export async function discoverLocalD1Options(root: string): Promise<{ cache: EngineProviderCache[], pending: Map<string, LocalD1Database> }> {
	const cache: EngineProviderCache[] = [];
	const pending = new Map<string, LocalD1Database>();

	for (const configFile of findWranglerConfigFiles(root)) {
		let databases: LocalD1Database[];
		try {
			databases = resolveLocalD1Databases(configFile);
		} catch (error) {
			logToOutput(`Could not read ${displayPath(root, configFile)}: ${String(error)}`, LOG_TAG);
			continue;
		}

		const project = displayPath(root, configFile);

		for (const database of databases) {
			const id = `d1-local:${configFile}:${database.binding}`;
			const description = `Cloudflare D1 (local) — ${database.binding} binding`;

			if (database.exists) {
				cache.push({
					id,
					type: 'sqlite',
					description,
					details: `${database.databaseName ?? database.binding} · ${displayPath(root, database.file)}`,
					engine: new D1LocalSqliteEngine(database.file),
				});
				continue;
			}

			pending.set(id, database);
			cache.push({
				id,
				type: 'sqlite',
				description,
				details: `Not created yet — run wrangler d1 migrations apply ${database.databaseName ?? database.binding} --local (${project})`,
				engine: new D1LocalSqliteEngine(database.file),
			});
		}

		for (const file of unmappedLocalD1Files(configFile, databases)) {
			const tables = await listTables(file);
			cache.push({
				id: `d1-local:${file}`,
				type: 'sqlite',
				description: `Cloudflare D1 (local) — unmapped file ${basename(file).slice(0, 8)}…`,
				details: `Tables: ${tables.length ? tables.join(', ') : '(none)'} · ${displayPath(root, file)}`,
				engine: new D1LocalSqliteEngine(file),
			});
		}
	}

	return { cache, pending };
}

async function listTables(file: string): Promise<string[]> {
	const engine = new D1LocalSqliteEngine(file);
	try {
		return await engine.getTables();
	} catch {
		return [];
	} finally {
		await engine.disconnect().catch(() => undefined);
	}
}

export const CloudflareD1LocalProvider: DatabaseEngineProvider = {
	name: 'Cloudflare D1 (local)',
	type: 'sqlite',
	id: 'cloudflare-d1-local',
	description: 'Local D1 databases written by wrangler dev / Miniflare',
	engine: undefined,
	cache: undefined,

	async boot(): Promise<void> {
		this.cache = undefined;
		this.engine = undefined;
		pendingDatabases.clear();
	},

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		const root = getBasePath();
		if (!root) return false;

		const { cache, pending } = await discoverLocalD1Options(root);
		this.cache = cache;
		pending.forEach((database, id) => pendingDatabases.set(id, database));

		return cache.length > 0;
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace();
	},

	async getDatabaseEngine(option?: EngineProviderOption): Promise<DatabaseEngine | undefined> {
		if (!option) return this.engine;

		const match = (this.cache ?? []).find(cache => cache.id === option.option.id);
		if (!match) {
			vscode.window.showErrorMessage(`Could not find option with id ${option.option.id}`);
			return undefined;
		}

		const pending = pendingDatabases.get(match.id);
		if (pending && !existsSync(pending.file)) {
			vscode.window.showWarningMessage(missingD1FileMessage(pending));
			return undefined;
		}

		this.engine = match.engine;
		return this.engine;
	},
};
