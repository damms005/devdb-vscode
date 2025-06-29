import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { SqliteEngine } from '../../database-engines/sqlite-engine';
import { isDjangoProject, getDatabaseConfig, getDjangoDbAlias } from '../../services/django/django-core';
import { getBasePath } from '../../services/workspace';
import { log } from '../../services/logging-service';
import * as path from 'path';

export const DjangoSqliteProvider: DatabaseEngineProvider = {
	name: 'Django SQLite',
	type: 'sqlite',
	id: 'django-sqlite',
	description: 'Django SQLite with settings.py',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		try {
			log('Django SQLite Provider', 'Checking if Django SQLite provider can be used');

			if (!isDjangoProject()) {
				log('Django SQLite Provider', 'Not a Django project');
				return false;
			}

			const djangoDbAlias = getDjangoDbAlias();
			log('Django SQLite Provider', `Using Django database alias: ${djangoDbAlias}`);

			const config = await getDatabaseConfig(djangoDbAlias);

			if (!config) {
				log('Django SQLite Provider', 'Failed to parse database configuration using Django shell');
				vscode.window.showErrorMessage('Django SQLite: Could not parse database configuration. Please ensure Django is properly installed and the settings.py file is valid.');
				return false;
			}

			if (config.adapter !== 'sqlite') {
				log('Django SQLite Provider', `Database adapter is ${config.adapter}, not sqlite`);
				return false;
			}

			if (!config.database) {
				log('Django SQLite Provider', 'No database path specified in configuration');
				vscode.window.showErrorMessage('Django SQLite: No database path specified in settings.py');
				return false;
			}

			// Handle special cases like :memory: databases
			if (config.database === ':memory:') {
				log('Django SQLite Provider', 'In-memory SQLite database is not supported');
				vscode.window.showErrorMessage('Django SQLite: In-memory databases (:memory:) are not supported');
				return false;
			}

			let databasePath = config.database;
			const workspaceRoot = getBasePath();

			if (workspaceRoot && !path.isAbsolute(databasePath)) {
				databasePath = path.resolve(workspaceRoot, databasePath);
				log('Django SQLite Provider', `Resolved relative database path to: ${databasePath}`);
			}

			try {
				this.engine = new SqliteEngine(databasePath);
			} catch (error) {
				log('Django SQLite Provider', `Failed to create SQLite engine: ${String(error)}`);
				vscode.window.showErrorMessage(`Django SQLite file error ${databasePath}: ${String(error)}`);
				return false;
			}

			const isOkay = await this.engine.isOkay();
			log('Django SQLite Provider', `Database connection test result: ${isOkay}`);

			if (!isOkay) {
				vscode.window.showErrorMessage(`Django SQLite: Database file is not accessible or corrupted: ${databasePath}`);
			}

			return isOkay;
		} catch (error) {
			log('Django SQLite Provider', `Unexpected error in canBeUsedInCurrentWorkspace: ${String(error)}`);
			vscode.window.showErrorMessage(`Django SQLite: Unexpected error while checking database configuration: ${String(error)}`);
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