import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { SqliteEngine } from '../../database-engines/sqlite-engine';
import { isRailsProject, parseDatabaseYml, getRailsEnv } from '../../services/rails/rails-core';
import { getBasePath } from '../../services/workspace';
import * as path from 'path';

export const RailsSqliteProvider: DatabaseEngineProvider = {
	name: 'Rails SQLite',
	type: 'sqlite',
	id: 'rails-sqlite',
	description: 'Rails SQLite with config/database.yml',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		if (!isRailsProject()) {
			return false;
		}

		const railsEnv = getRailsEnv();
		const config = parseDatabaseYml(railsEnv);

		if (!config) {
			return false;
		}

		if (config.adapter !== 'sqlite') {
			return false;
		}

		if (!config.database) {
			vscode.window.showErrorMessage('Rails SQLite: No database path specified in config/database.yml');
			return false;
		}

		let databasePath = config.database;
		const workspaceRoot = getBasePath();

		if (workspaceRoot && !path.isAbsolute(databasePath)) {
			databasePath = path.resolve(workspaceRoot, databasePath);
		}

		try {
			this.engine = new SqliteEngine(databasePath);
		} catch (error) {
			vscode.window.showErrorMessage(`Rails SQLite file error ${databasePath}: ${String(error)}`);
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