import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { MysqlEngine } from '../../database-engines/mysql-engine';
import { isDjangoProject, getDatabaseConfig, getDjangoDbAlias } from '../../services/django/django-core';
import knex from 'knex';
import { log } from '../../services/logging-service';

export const DjangoMysqlProvider: DatabaseEngineProvider = {
	name: 'Django MySQL',
	type: 'mysql',
	id: 'django-mysql',
	description: 'Django MySQL with settings.py',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		if (!isDjangoProject()) {
			return false;
		}

		log('Django MySQL', 'Checking if Django MySQL provider can be used in the current workspace...');

		const djangoDbAlias = getDjangoDbAlias();
		const config = await getDatabaseConfig(djangoDbAlias);

		if (!config) {
			log('Django MySQL', 'Failed to parse Django database configuration using Django shell');
			vscode.window.showErrorMessage('Failed to parse Django database configuration. Please ensure Django is properly installed and the settings.py file is valid.');
			return false;
		}

		if (config.adapter !== 'mysql') {
			log('Django MySQL', `Database adapter is ${config.adapter}, not mysql`);
			return false;
		}

		try {
			log('Django MySQL', 'Creating Knex connection with Django configuration...');
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
			log('Django MySQL', 'MySQL engine created successfully');
		} catch (error) {
			const errorMessage = `MySQL connection error: ${String(error)}`;
			vscode.window.showErrorMessage(errorMessage);
			log('Django MySQL', errorMessage);
			return false;
		}

		try {
			const isOkay = await this.engine.isOkay();
			if (!isOkay) {
				log('Django MySQL', 'MySQL connection validation failed');
				vscode.window.showErrorMessage('Failed to connect to MySQL database. Please check your Django database configuration.');
				return false;
			}
			log('Django MySQL', 'MySQL connection validated successfully');
			return true;
		} catch (error) {
			const errorMessage = `MySQL connection validation error: ${String(error)}`;
			log('Django MySQL', errorMessage);
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