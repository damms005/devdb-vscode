import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { MysqlEngine } from '../../database-engines/mysql-engine';
import { isRailsProject, getRailsEnv, parseDatabaseYml, createKnexConnection } from '../../services/rails/rails-core';
import { log } from '../../services/logging-service';

export const RailsMysqlProvider: DatabaseEngineProvider = {
	name: 'Rails MySQL',
	type: 'mysql',
	id: 'rails-mysql',
	description: 'Rails MySQL with config/database.yml',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		if (!isRailsProject()) {
			return false;
		}

		log('Rails MySQL', 'Checking if Rails MySQL provider can be used in the current workspace...');

		const railsEnv = getRailsEnv();
		const config = parseDatabaseYml(railsEnv);

		if (!config) {
			log('Rails MySQL', 'Failed to parse database.yml configuration');
			return false;
		}

		if (config.adapter !== 'mysql2' && config.adapter !== 'mysql') {
			log('Rails MySQL', `Database adapter is ${config.adapter}, not mysql2 or mysql`);
			return false;
		}

		const connection = createKnexConnection(config);
		if (!connection) {
			log('Rails MySQL', 'Failed to create Knex connection');
			return false;
		}

		try {
			this.engine = new MysqlEngine(connection);
		} catch (error) {
			vscode.window.showErrorMessage(`MySQL connection error: ${String(error)}`);
			log('Rails MySQL', `MySQL connection error: ${String(error)}`);
			return false;
		}

		log('Rails MySQL', 'OK');
		return (await this.engine.isOkay());
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace();
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine;
	}
};