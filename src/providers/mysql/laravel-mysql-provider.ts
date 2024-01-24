import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { MysqlEngine } from '../../database-engines/mysql-engine';
import { getConnectionInEnvFile } from '../../services/laravel/env-file-parser';

export const LaravelMysqlProvider: DatabaseEngineProvider = {
	name: 'Laravel Mysql (with Sail support)',
	type: 'mysql',
	id: 'laravel-mysql',
	description: 'Laravel MySQL with default .env config or Sail config in docker-compose.yml',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		const connection = await getConnectionInEnvFile('mysql', 'mysql')
		if (!connection) return false

		try {
			this.engine = new MysqlEngine(connection);
		} catch (error) {
			vscode.window.showErrorMessage(`MySQL connection error: ${String(error)}`)
			return false
		}

		return (await this.engine.isOkay())
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine
	}
}