import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { PostgresEngine } from '../../database-engines/postgres-engine';
import { getConnectionInEnvFile } from '../../services/laravel/env-file-parser';

export const LaravelPostgresProvider: DatabaseEngineProvider = {
	name: 'Laravel Postgres',
	type: 'postgres',
	id: 'laravel-postgres',
	description: 'Laravel Postgres with default .env config',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		const connection = await getConnectionInEnvFile('pgsql', 'postgres')
		if (!connection) return false

		this.engine = new PostgresEngine(connection);

		return (await this.engine.getTables()).length > 0
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine
	}
}