import * as vscode from 'vscode';
import knex from 'knex';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { PostgresEngine } from '../../database-engines/postgres-engine';
import { isRailsProject, parseDatabaseYml, getRailsEnv } from '../../services/rails/rails-core';
import { log } from '../../services/logging-service';

export const RailsPostgresProvider: DatabaseEngineProvider = {
	name: 'Rails PostgreSQL',
	type: 'postgres',
	id: 'rails-postgres',
	description: 'Rails PostgreSQL with config/database.yml',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		if (!isRailsProject()) {
			log('Rails Postgres Provider', 'Not a Rails project');
			return false;
		}

		try {
			const config = await parseDatabaseYml(getRailsEnv());
			if (!config) {
				log('Rails Postgres Provider', 'Failed to parse database configuration using Rails runner');
				return false;
			}

			if (config.adapter !== 'postgres') {
				log('Rails Postgres Provider', `Database adapter is ${config.adapter}, not postgres`);
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
				log('Rails Postgres Provider', 'Failed to create Knex connection');
				return false;
			}

			this.engine = new PostgresEngine(connection);
		} catch (error) {
			const errorMessage = `Rails PostgreSQL connection error: ${String(error)}`;
			log('Rails Postgres Provider', errorMessage);
			vscode.window.showErrorMessage(errorMessage);
			return false;
		}

		try {
			const isOkay = await this.engine.isOkay();
			if (!isOkay) {
				log('Rails Postgres Provider', 'Database connection validation failed');
			}
			return isOkay;
		} catch (error) {
			const errorMessage = `Rails PostgreSQL connection validation error: ${String(error)}`;
			log('Rails Postgres Provider', errorMessage);
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
