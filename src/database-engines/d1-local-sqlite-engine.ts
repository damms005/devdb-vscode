import { SqliteEngine } from './sqlite-engine';

/**
 * Tables D1 keeps for itself (`_cf_METADATA`, `_cf_KV`). D1 does not let Workers read them.
 */
export function isD1InternalTable(table: string): boolean {
	return /^_cf_/i.test(table);
}

/**
 * The local SQLite file Miniflare writes for a D1 binding. It is plain SQLite, so it uses the
 * SQLite engine, but hides D1's internal tables.
 */
export class D1LocalSqliteEngine extends SqliteEngine {
	async getTables(): Promise<string[]> {
		return (await super.getTables()).filter(table => !isD1InternalTable(table));
	}
}
