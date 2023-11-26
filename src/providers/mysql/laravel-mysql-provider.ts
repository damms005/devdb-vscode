import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { MysqlEngine } from '../../database-engines/mysql-engine';
import { getMysqlConnection } from '../../services/laravel/sail';

export const LaravelMysqlProvider: DatabaseEngineProvider = {
	name: 'Laravel Mysql (with Sail support)',
	type: 'mysql',
	id: 'laravel-mysql',
	description: 'Laravel MySQL with default .env config or Sail config in docker-compose.yml',
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