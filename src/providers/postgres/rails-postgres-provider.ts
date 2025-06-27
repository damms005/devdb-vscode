import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { PostgresEngine } from '../../database-engines/postgres-engine';
import { isRailsProject, parseDatabaseYml, getRailsEnv, createKnexConnection } from '../../services/rails/rails-core';

export const RailsPostgresProvider: DatabaseEngineProvider = {
	name: 'Rails PostgreSQL',
	type: 'postgres',
	id: 'rails-postgres',
	description: 'Rails PostgreSQL with config/database.yml',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		if (!isRailsProject()) {
			return false;
		}

		const config = parseDatabaseYml(getRailsEnv());
		if (!config) return false;

		if (config.adapter !== 'postgres') {
			return false;
		}

		try {
			const connection = createKnexConnection(config);
			if (!connection) {
				return false;
			}

			this.engine = new PostgresEngine(connection);
		} catch (error) {
			vscode.window.showErrorMessage(`Postgres connection error: ${String(error)}`);
			return false;
		}

		return (await this.engine.isOkay());
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace();
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine;
	}
};