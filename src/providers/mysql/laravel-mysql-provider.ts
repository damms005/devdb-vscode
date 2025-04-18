import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { MysqlEngine } from '../../database-engines/mysql-engine';
import { getConnectionInEnvFile } from '../../services/laravel/env-file-parser';
import { log } from '../../services/logging-service';
import { isComposerPhpProject, isDdevProject } from '../../services/workspace';

export const LaravelMysqlProvider: DatabaseEngineProvider = {
	name: 'Laravel Mysql (with Sail support)',
	type: 'mysql',
	id: 'laravel-mysql',
	description: 'Laravel MySQL with default .env config or Sail config in docker-compose.yml',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		if (!isComposerPhpProject()) {
			return false;
		}

		if (isDdevProject()) {
			/**
			 * This is simply to improve the DX. Else, we report false negative as
			 * it tries to load from .env, which is not how DDEV projects work.
			 *
			 * @see https://discord.com/channels/664580571770388500/1348955044334141460/1349010258214781021
			 */
			return false;
		}

		log('Laravel MySQL', 'Checking if Laravel MySQL provider can be used in the current workspace...');
		const connection = await getConnectionInEnvFile('mysql', 'mysql2');
		log('Laravel MySQL', `Connection status: ${connection ? 'successful' : 'failed'}`);
		if (!connection) return false

		try {
			log('Laravel MySQL', 'Creating MySQL engine...');
			this.engine = new MysqlEngine(connection);
		} catch (error) {
			vscode.window.showErrorMessage(`MySQL connection error: ${String(error)}`);
			log('Laravel MySQL', `MySQL connection error: ${String(error)}`);
			return false
		}

		log('Laravel MySQL', 'OK');
		return (await this.engine.isOkay())
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace()
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine
	}
}
