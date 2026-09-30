import { createHash, createHmac } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

/**
 * One entry of `d1_databases` in a wrangler config file.
 */
export type D1Binding = {
	binding: string
	databaseName?: string
	databaseId?: string
	previewDatabaseId?: string
	migrationsDir?: string
	/** Absolute path of the wrangler config file that declares the binding. */
	configFile: string
}

/** In wrangler's own lookup order. */
export const WRANGLER_CONFIG_FILES = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'] as const;

/**
 * Miniflare stores each local D1 database as a Durable Object of this class. The class name
 * is also the namespace's `uniqueKey` (miniflare `src/plugins/d1/index.ts`).
 */
const D1_OBJECT_CLASS = 'D1DatabaseObject';
const D1_UNIQUE_KEY = `miniflare-${D1_OBJECT_CLASS}`;

/**
 * Removes `//` and `/* *\/` comments and trailing commas from JSONC text, outside strings.
 */
export function stripJsonc(text: string): string {
	return removeTrailingCommas(scanJson(text, (ch, next, i) => {
		if (ch === '/' && next === '/') {
			const end = text.indexOf('\n', i);
			return { skipTo: end === -1 ? text.length : end };
		}
		if (ch === '/' && next === '*') {
			const end = text.indexOf('*/', i + 2);
			return { skipTo: end === -1 ? text.length : end + 2 };
		}
		return undefined;
	}));
}

function removeTrailingCommas(text: string): string {
	return scanJson(text, (ch, _next, i) => {
		if (ch !== ',') return undefined;
		const following = text.slice(i + 1).match(/^\s*(.)/)?.[1];
		return following === '}' || following === ']' ? { skipTo: i + 1 } : undefined;
	});
}

/**
 * Copies JSON text, keeping string literals intact, and lets `onCode` drop a range of code.
 */
function scanJson(text: string, onCode: (ch: string, next: string | undefined, index: number) => { skipTo: number } | undefined): string {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') {
				j += text[j] === '\\' ? 2 : 1;
			}
			out += text.slice(i, j + 1);
			i = j + 1;
			continue;
		}

		const skip = onCode(ch, text[i + 1], i);
		if (skip) {
			i = skip.skipTo;
			continue;
		}

		out += ch;
		i++;
	}

	return out;
}

/**
 * Parses a TOML value that is a string, number or boolean. Returns undefined for anything else.
 */
function parseTomlScalar(raw: string): string | undefined {
	const value = raw.trim();
	const quoted = value.match(/^"((?:[^"\\]|\\.)*)"|^'([^']*)'/);
	if (quoted) {
		return quoted[1] !== undefined ? JSON.parse(`"${quoted[1]}"`) : quoted[2];
	}

	const bare = value.match(/^([^\s#,}]+)/);
	return bare ? bare[1] : undefined;
}

/**
 * Parses `key = value, key2 = value2` pairs of a TOML inline table body.
 */
function parseTomlInlineTable(body: string): Record<string, string> {
	const result: Record<string, string> = {};
	const pair = /([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^,}\s]+)/g;
	for (const match of body.matchAll(pair)) {
		const value = parseTomlScalar(match[2]);
		if (value !== undefined) result[match[1]] = value;
	}

	return result;
}

/**
 * Reads the top-level `d1_databases` entries of a wrangler.toml. Supports both
 * `[[d1_databases]]` tables and an inline `d1_databases = [ { ... } ]` array. Entries under
 * `[env.<name>]` are ignored.
 */
export function parseD1FromToml(text: string): Record<string, string>[] {
	const entries: Record<string, string>[] = [];
	let current: Record<string, string> | null = null;
	let inTopLevel = true;
	const lines = text.split(/\r?\n/);

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].replace(/^\s+/, '');
		if (!line || line.startsWith('#')) continue;

		const header = line.match(/^(\[\[?)\s*([^\]]+?)\s*\]\]?/);
		if (header) {
			const name = header[2];
			current = null;
			if (header[1] === '[[' && name === 'd1_databases') {
				current = {};
				entries.push(current);
				inTopLevel = false;
			} else {
				inTopLevel = false;
			}
			continue;
		}

		const keyValue = line.match(/^([A-Za-z0-9_-]+)\s*=\s*([\s\S]*)$/);
		if (!keyValue) continue;

		if (current) {
			const value = parseTomlScalar(keyValue[2]);
			if (value !== undefined) current[keyValue[1]] = value;
			continue;
		}

		if (inTopLevel && keyValue[1] === 'd1_databases') {
			let body = keyValue[2];
			while (!/\]\s*(#.*)?$/.test(body.trim()) && index + 1 < lines.length) {
				body += '\n' + lines[++index];
			}
			for (const table of body.matchAll(/\{([^}]*)\}/g)) {
				entries.push(parseTomlInlineTable(table[1]));
			}
		}
	}

	return entries;
}

export function parseD1FromJsonc(text: string): Record<string, string>[] {
	const parsed = JSON.parse(stripJsonc(text));
	return Array.isArray(parsed?.d1_databases) ? parsed.d1_databases : [];
}

export function readD1Bindings(configFile: string): D1Binding[] {
	const text = readFileSync(configFile, 'utf8');
	const raw = configFile.endsWith('.toml') ? parseD1FromToml(text) : parseD1FromJsonc(text);

	return raw
		.filter(entry => typeof entry?.binding === 'string' && entry.binding)
		.map(entry => ({
			binding: entry.binding,
			databaseName: stringOrUndefined(entry.database_name),
			databaseId: stringOrUndefined(entry.database_id),
			previewDatabaseId: stringOrUndefined(entry.preview_database_id),
			migrationsDir: stringOrUndefined(entry.migrations_dir),
			configFile,
		}));
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

/**
 * The Durable Object id workerd derives with `idFromName(name)` for a namespace with the
 * given unique key (workerd `server.c++` ActorIdFactoryImpl): key = SHA-256(uniqueKey),
 * base = HMAC-SHA256(key, name)[0..16], mac = HMAC-SHA256(key, base)[0..16], id = hex(base + mac).
 */
export function durableObjectIdFromName(uniqueKey: string, name: string): string {
	const key = createHash('sha256').update(uniqueKey).digest();
	const base = createHmac('sha256', key).update(name).digest().subarray(0, 16);
	const mac = createHmac('sha256', key).update(base).digest().subarray(0, 16);

	return Buffer.concat([base, mac]).toString('hex');
}

/**
 * The name wrangler gives Miniflare for a local D1 binding: `preview_database_id ??
 * database_id ?? binding` (wrangler `d1DatabaseEntry`).
 */
export function localD1ObjectName(binding: Pick<D1Binding, 'binding' | 'databaseId' | 'previewDatabaseId'>): string {
	return binding.previewDatabaseId ?? binding.databaseId ?? binding.binding;
}

export function localD1FileName(binding: Pick<D1Binding, 'binding' | 'databaseId' | 'previewDatabaseId'>): string {
	return `${durableObjectIdFromName(D1_UNIQUE_KEY, localD1ObjectName(binding))}.sqlite`;
}

/**
 * `<persist root>/v3/d1/miniflare-D1DatabaseObject`
 */
export function d1ObjectDirectory(persistRoot: string): string {
	return join(persistRoot, 'v3', 'd1', `miniflare-${D1_OBJECT_CLASS}`);
}

/**
 * Persist roots to search for a wrangler project: `--persist-to` values found in the
 * project's package.json scripts (relative to the project directory), then the default
 * `<config dir>/.wrangler/state`.
 */
export function persistRootsFor(configFile: string): string[] {
	const projectDir = dirname(configFile);
	const roots: string[] = [];

	const packageJson = join(projectDir, 'package.json');
	if (existsSync(packageJson)) {
		try {
			const scripts = JSON.parse(readFileSync(packageJson, 'utf8'))?.scripts ?? {};
			for (const script of Object.values(scripts)) {
				if (typeof script !== 'string') continue;
				for (const match of script.matchAll(/--persist-to(?:=|\s+)("[^"]+"|'[^']+'|[^\s&|;]+)/g)) {
					roots.push(resolve(projectDir, match[1].replace(/^["']|["']$/g, '')));
				}
			}
		} catch {
			// unreadable package.json: fall back to the default root
		}
	}

	roots.push(join(projectDir, '.wrangler', 'state'));

	return [...new Set(roots)];
}

export type LocalD1Database = D1Binding & {
	/** Expected SQLite file; it exists when `exists` is true. */
	file: string
	exists: boolean
}

/**
 * Maps each binding to its local SQLite file. The first persist root that holds the file wins;
 * without a file, the expected path under the first persist root is returned.
 */
export function resolveLocalD1Databases(configFile: string): LocalD1Database[] {
	const roots = persistRootsFor(configFile);

	return readD1Bindings(configFile).map(binding => {
		const fileName = localD1FileName(binding);
		const candidates = roots.map(root => join(d1ObjectDirectory(root), fileName));
		const found = candidates.find(candidate => existsSync(candidate));

		return { ...binding, file: found ?? candidates[candidates.length - 1], exists: Boolean(found) };
	});
}

/**
 * SQLite files in the D1 object directories of a project that no binding maps to (e.g. a
 * database_id that changed, or a binding removed from the config).
 */
export function unmappedLocalD1Files(configFile: string, mapped: LocalD1Database[]): string[] {
	const mappedFiles = new Set(mapped.filter(db => db.exists).map(db => resolve(db.file)));
	const files: string[] = [];

	for (const root of persistRootsFor(configFile)) {
		const directory = d1ObjectDirectory(root);
		if (!existsSync(directory)) continue;

		for (const name of readdirSync(directory)) {
			if (!/^[0-9a-f]{64}\.sqlite$/.test(name)) continue;
			const file = resolve(directory, name);
			if (!mappedFiles.has(file) && statSync(file).isFile()) files.push(file);
		}
	}

	return files;
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.wrangler', 'dist', 'vendor', '.next', '.svelte-kit', '.turbo']);

/**
 * Finds wrangler config files in the workspace root and up to `maxDepth` levels below it
 * (monorepos keep one per worker).
 */
export function findWranglerConfigFiles(root: string, maxDepth = 3): string[] {
	const found: string[] = [];

	const visit = (directory: string, depth: number) => {
		const configFile = WRANGLER_CONFIG_FILES.map(name => join(directory, name)).find(file => existsSync(file));
		if (configFile) found.push(configFile);
		if (depth >= maxDepth) return;

		let children: string[] = [];
		try {
			children = readdirSync(directory, { withFileTypes: true })
				.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name))
				.map(entry => join(directory, entry.name));
		} catch {
			return;
		}
		children.forEach(child => visit(child, depth + 1));
	};

	visit(root, 0);

	return found;
}

export function displayPath(root: string, file: string): string {
	const rel = relative(root, file);
	return rel && !rel.startsWith('..') ? rel : file;
}
