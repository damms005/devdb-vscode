import * as vscode from 'vscode';
import knex from 'knex';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { PostgresEngine } from '../../database-engines/postgres-engine';
import { isDjangoProject, getDatabaseConfig, getDjangoDbAlias } from '../../services/django/django-core';
import { log } from '../../services/logging-service';

export const DjangoPostgresProvider: DatabaseEngineProvider = {
	name: 'Django PostgreSQL',
	type: 'postgres',
	id: 'django-postgres',
	description: 'Django PostgreSQL with settings.py',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		if (!isDjangoProject()) {
			log('Django Postgres Provider', 'Not a Django project');
			return false;
		}

		try {
			const config = await getDatabaseConfig(getDjangoDbAlias());
			if (!config) {
				log('Django Postgres Provider', 'Failed to parse database configuration using Django shell');
				return false;
			}

			if (config.adapter !== 'postgres') {
				log('Django Postgres Provider', `Database adapter is ${config.adapter}, not postgres`);
				return false;
			}

			const connection = knex({
				client: 'pg',
				connection: {
					host: config.host,
					port: config.port,
					user: config.username,
					password: config.password,
					database: config.database,
					pool: config.pool ? { min: 0, max: config.pool } : undefined,
				},
				acquireConnectionTimeout: config.timeout || 60000,
			});

			if (!connection) {
				log('Django Postgres Provider', 'Failed to create Knex connection');
				return false;
			}

			this.engine = new PostgresEngine(connection);
		} catch (error) {
			const errorMessage = `Django PostgreSQL connection error: ${String(error)}`;
			log('Django Postgres Provider', errorMessage);
			vscode.window.showErrorMessage(errorMessage);
			return false;
		}

		try {
			const isOkay = await this.engine.isOkay();
			if (!isOkay) {
				log('Django Postgres Provider', 'Database connection validation failed');
			}
			return isOkay;
		} catch (error) {
			const errorMessage = `Django PostgreSQL connection validation error: ${String(error)}`;
			log('Django Postgres Provider', errorMessage);
			vscode.window.showErrorMessage(errorMessage);
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