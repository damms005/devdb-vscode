import * as vscode from 'vscode';
import { PostgresEngine } from '../../database-engines/postgres-engine';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { logToOutput } from '../../services/output-service';
import { getConfigFilePath } from '../../services/config-service';
import { getWorkspaceFileContent } from '../../services/workspace';
import {
	buildNeonConnectionFromString,
	extractDatabaseUrlFromEnv,
	findNeonConnectionStringIn,
	isNeonConnectionString,
} from './neon-connection-helper';
import { readFileSync } from 'fs';

/**
 * `.env`-style files scanned for a Neon connection string, in priority order.
 */
const ENV_FILES_TO_SCAN = ['.env', '.env.local'] as const;

/**
 * Neon compute autosuspends when idle; the first query after a wake can fail
 * while the endpoint resumes. These control a short retry-with-backoff on the
 * initial health check so a cold start does not surface as a failed connection.
 */
const COLD_START_MAX_ATTEMPTS = 3;
const COLD_START_BACKOFF_MS = 750;

export const NeonPostgresProvider: DatabaseEngineProvider = {
	name: 'Neon - PostgreSQL',
	type: 'postgres',
	id: 'neon-postgres',
	description: 'Serverless PostgreSQL hosted on Neon',
	engine: undefined as PostgresEngine | undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		try {
			const connectionString = resolveNeonConnectionString();
			if (!connectionString) {
				logToOutput('No Neon connection string found in .env or .devdbrc', 'Neon Postgres');
				return false;
			}

			const connection = buildNeonConnectionFromString(connectionString);
			if (!connection) {
				logToOutput('Failed to parse Neon connection string', 'Neon Postgres');
				return false;
			}

			this.engine = new PostgresEngine(connection);

			return await isEngineOkayWithColdStartRetry(this.engine);
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to initialize Neon PostgreSQL engine: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace();
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine;
	},
};

/**
 * Looks for a Neon connection string, preferring `.env`/`.env.local`
 * `DATABASE_URL` (and related keys), then falling back to any Neon endpoint
 * referenced in the `.devdbrc` config file.
 */
function resolveNeonConnectionString(): string | undefined {
	for (const envFile of ENV_FILES_TO_SCAN) {
		const envContents = getWorkspaceFileContent(envFile)?.toString();
		const fromEnv = extractDatabaseUrlFromEnv(envContents);
		if (fromEnv && isNeonConnectionString(fromEnv)) {
			return fromEnv;
		}
	}

	const configFilePath = getConfigFilePath();
	if (configFilePath) {
		try {
			return findNeonConnectionStringIn(readFileSync(configFilePath).toString());
		} catch {
			return undefined;
		}
	}

	return undefined;
}

/**
 * Runs the engine health check, retrying with linear backoff to absorb a Neon
 * cold-start stall on the first query after the compute resumes.
 */
async function isEngineOkayWithColdStartRetry(engine: DatabaseEngine): Promise<boolean> {
	for (let attempt = 1; attempt <= COLD_START_MAX_ATTEMPTS; attempt++) {
		if (await engine.isOkay()) {
			return true;
		}

		if (attempt < COLD_START_MAX_ATTEMPTS) {
			logToOutput(`Neon health check attempt ${attempt} failed; retrying (possible cold start)`, 'Neon Postgres');
			await delay(COLD_START_BACKOFF_MS * attempt);
		}
	}

	return false;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
