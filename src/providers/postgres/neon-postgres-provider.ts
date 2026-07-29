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
} from './neon-connection-helper';
import { readFileSync } from 'fs';

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

			return await this.engine.isOkay();
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
 * Looks for a Neon connection string, preferring `.env` `DATABASE_URL`, then
 * falling back to any Neon endpoint referenced in the `.devdbrc` config file.
 */
function resolveNeonConnectionString(): string | undefined {
	const envContents = getWorkspaceFileContent('.env')?.toString();
	const fromEnv = extractDatabaseUrlFromEnv(envContents);
	if (fromEnv && fromEnv.includes('neon.tech')) {
		return fromEnv;
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
