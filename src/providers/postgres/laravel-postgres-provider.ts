import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { MysqlEngine } from '../../database-engines/mysql-engine';
import { getMysqlConnection } from '../../services/laravel/sail';

export const LaravelPostgresProvider: DatabaseEngineProvider = {
	name: 'Laravel Postgres (with Sail support)',
	type: 'postgres',
	id: 'laravel-postgres',
	description: 'Laravel Postgres with default .env config or Sail config in docker-compose.yml',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		const connection = await getMysqlConnection()
		if (!connection) return false

		this.engine = new MysqlEngine(connection);

		return (await this.engine.getTables()).length > 0
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine
	}
}