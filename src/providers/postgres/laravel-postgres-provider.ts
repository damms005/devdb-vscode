import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { PostgresEngine } from '../../database-engines/postgres-engine';
import { getConnectionInEnvFile } from '../../services/laravel/env-file-parser';
import { isDdevProject } from '../../services/ddev/ddev-service';

export const LaravelPostgresProvider: DatabaseEngineProvider = {
	name: 'Laravel PostgreSQL',
	type: 'postgres',
	id: 'laravel-postgres',
	description: 'Laravel PostgreSQL with default .env config',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		if (isDdevProject()) {
			/**
			 * This is simply to improve the DX. Else, we report false negative as
			 * it tries to load from .env, which is not how DDEV projects work.
			 *
			 * @see https://discord.com/channels/664580571770388500/1348955044334141460/1349010258214781021
			 */
			return false;
		}

		const connection = await getConnectionInEnvFile('pgsql', 'postgres')
		if (!connection) return false

		try {
			this.engine = new PostgresEngine(connection);
		} catch (error) {
			vscode.window.showErrorMessage(`Postgres connection error: ${String(error)}`)
			return false
		}

		return (await this.engine.isOkay())
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace()
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine
	}
}