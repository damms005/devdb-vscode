import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { MysqlEngine } from '../../database-engines/mysql-engine';
import { isRailsProject, getRailsEnv, parseDatabaseYml } from '../../services/rails/rails-core';
import knex from 'knex';
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
		const config = await parseDatabaseYml(railsEnv);

		if (!config) {
			log('Rails MySQL', 'Failed to parse database.yml configuration using Rails runner');
			vscode.window.showErrorMessage('Failed to parse Rails database configuration. Please ensure Rails is properly installed and the database.yml file is valid.');
			return false;
		}

		if (config.adapter !== 'mysql2') {
			log('Rails MySQL', `Database adapter is ${config.adapter}, not mysql2`);
			return false;
		}

		try {
			log('Rails MySQL', 'Creating Knex connection with Rails configuration...');
			const connection = knex({
				client: 'mysql2',
				connection: {
					host: config.host,
					port: config.port,
					user: config.username,
					password: config.password,
					database: config.database,
					pool: config.pool ? { min: 0, max: config.pool } : undefined
				},
				acquireConnectionTimeout: config.timeout || 60000
			});

			this.engine = new MysqlEngine(connection);
			log('Rails MySQL', 'MySQL engine created successfully');
		} catch (error) {
			const errorMessage = `MySQL connection error: ${String(error)}`;
			vscode.window.showErrorMessage(errorMessage);
			log('Rails MySQL', errorMessage);
			return false;
		}

		try {
			const isOkay = await this.engine.isOkay();
			if (!isOkay) {
				log('Rails MySQL', 'MySQL connection validation failed');
				vscode.window.showErrorMessage('Failed to connect to MySQL database. Please check your Rails database configuration.');
				return false;
			}
			log('Rails MySQL', 'MySQL connection validated successfully');
			return true;
		} catch (error) {
			const errorMessage = `MySQL connection validation error: ${String(error)}`;
			log('Rails MySQL', errorMessage);
			vscode.window.showErrorMessage('Failed to validate MySQL connection. Please check your database server and configuration.');
			return false;
		}
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace();
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine;
	}
};
