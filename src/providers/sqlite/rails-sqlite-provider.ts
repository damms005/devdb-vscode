import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { SqliteEngine } from '../../database-engines/sqlite-engine';
import { isRailsProject, parseDatabaseYml, getRailsEnv } from '../../services/rails/rails-core';
import { getBasePath } from '../../services/workspace';
import { log } from '../../services/logging-service';
import * as path from 'path';

export const RailsSqliteProvider: DatabaseEngineProvider = {
	name: 'Rails SQLite',
	type: 'sqlite',
	id: 'rails-sqlite',
	description: 'Rails SQLite with config/database.yml',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		try {
			log('Rails SQLite Provider', 'Checking if Rails SQLite provider can be used');

			if (!isRailsProject()) {
				log('Rails SQLite Provider', 'Not a Rails project');
				return false;
			}

			const railsEnv = getRailsEnv();
			log('Rails SQLite Provider', `Using Rails environment: ${railsEnv}`);

			const config = await parseDatabaseYml(railsEnv);

			if (!config) {
				log('Rails SQLite Provider', 'Failed to parse database configuration using Rails runner');
				vscode.window.showErrorMessage('Rails SQLite: Could not parse database configuration. Please ensure Rails is properly installed and the database.yml file is valid.');
				return false;
			}

			if (config.adapter !== 'sqlite') {
				log('Rails SQLite Provider', `Database adapter is ${config.adapter}, not sqlite`);
				return false;
			}

			if (!config.database) {
				log('Rails SQLite Provider', 'No database path specified in configuration');
				vscode.window.showErrorMessage('Rails SQLite: No database path specified in config/database.yml');
				return false;
			}

			let databasePath = config.database;
			const workspaceRoot = getBasePath();

			if (workspaceRoot && !path.isAbsolute(databasePath)) {
				databasePath = path.resolve(workspaceRoot, databasePath);
				log('Rails SQLite Provider', `Resolved relative database path to: ${databasePath}`);
			}

			try {
				this.engine = new SqliteEngine(databasePath);
			} catch (error) {
				log('Rails SQLite Provider', `Failed to create SQLite engine: ${String(error)}`);
				vscode.window.showErrorMessage(`Rails SQLite file error ${databasePath}: ${String(error)}`);
				return false;
			}

			const isOkay = await this.engine.isOkay();
			log('Rails SQLite Provider', `Database connection test result: ${isOkay}`);

			if (!isOkay) {
				vscode.window.showErrorMessage(`Rails SQLite: Database file is not accessible or corrupted: ${databasePath}`);
			}

			return isOkay;
		} catch (error) {
			log('Rails SQLite Provider', `Unexpected error in canBeUsedInCurrentWorkspace: ${String(error)}`);
			vscode.window.showErrorMessage(`Rails SQLite: Unexpected error while checking database configuration: ${String(error)}`);
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
