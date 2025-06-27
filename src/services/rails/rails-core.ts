import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import { getPathToWorkspaceFile, getWorkspaceFileContent, getBasePath } from '../workspace';
import { log } from '../logging-service';
import knexlib from 'knex';
import * as path from 'path';

export interface RailsDatabaseConfig {
	adapter: string;
	database: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	pool?: number;
	timeout?: number;
}

export function isRailsProject(): boolean {
	try {
		const gemfilePath = getPathToWorkspaceFile('Gemfile');
		if (!gemfilePath) {
			log('Rails Core', 'No Gemfile found in workspace root');
			return false;
		}

		const gemfileContent = getWorkspaceFileContent('Gemfile');
		if (!gemfileContent) {
			log('Rails Core', 'Could not read Gemfile content');
			return false;
		}

		const gemfileText = gemfileContent.toString();
		const railsGemPattern = /gem\s+['"']rails['"']/;
		if (!railsGemPattern.test(gemfileText)) {
			log('Rails Core', 'Rails gem not found in Gemfile');
			return false;
		}

		const databaseYmlPath = getPathToWorkspaceFile('config', 'database.yml');
		if (!databaseYmlPath) {
			log('Rails Core', 'config/database.yml not found');
			return false;
		}

		const databaseYmlContent = getWorkspaceFileContent('config', 'database.yml');
		if (!databaseYmlContent) {
			log('Rails Core', 'Could not read config/database.yml content');
			return false;
		}

		log('Rails Core', 'Rails project detected successfully');
		return true;
	} catch (error) {
		log('Rails Core', `Error checking Rails project: ${String(error)}`);
		return false;
	}
}

export function getRailsEnv(): string {
	return process.env.RAILS_ENV || 'development';
}

export function parseDatabaseYml(environment: string): RailsDatabaseConfig | null {
	try {
		log('Rails Core', `Parsing database.yml for environment: ${environment}`);

		const databaseYmlContent = getWorkspaceFileContent('config', 'database.yml');
		if (!databaseYmlContent) {
			log('Rails Core', 'Could not read config/database.yml');
			return null;
		}

		let yamlContent = databaseYmlContent.toString();

		// Apply basic ERB substitution for environment variables
		// Pattern: <%= ENV['VAR_NAME'] %> or <%= ENV["VAR_NAME"] %>
		const erbPattern = /<%=\s*ENV\[['"](\w+)['"]\]\s*%>/g;
		yamlContent = yamlContent.replace(erbPattern, (match, envVar) => {
			const envValue = process.env[envVar];
			if (envValue !== undefined) {
				log('Rails Core', `Substituting ERB variable ${envVar} with value from environment`);
				return envValue;
			}
			log('Rails Core', `ERB variable ${envVar} not found in environment, keeping original`);
			return match;
		});

		const parsedYaml = parseYaml(yamlContent);
		if (!parsedYaml || typeof parsedYaml !== 'object') {
			log('Rails Core', 'Invalid YAML structure in database.yml');
			return null;
		}

		const envConfig = (parsedYaml as any)[environment];
		if (!envConfig || typeof envConfig !== 'object') {
			log('Rails Core', `No configuration found for environment: ${environment}`);
			return null;
		}

		const adapter = envConfig.adapter;
		let mappedAdapter: string;
		switch (adapter) {
			case 'postgresql':
				mappedAdapter = 'postgres';
				break;
			case 'mysql2':
				mappedAdapter = 'mysql2';
				break;
			case 'sqlite3':
				mappedAdapter = 'sqlite';
				break;
			default:
				log('Rails Core', `Unsupported database adapter: ${adapter}`);
				return null;
		}

		const config: RailsDatabaseConfig = {
			adapter: mappedAdapter,
			database: envConfig.database,
			host: envConfig.host,
			port: envConfig.port,
			username: envConfig.username,
			password: envConfig.password,
			pool: envConfig.pool,
			timeout: envConfig.timeout
		};

		if (mappedAdapter === 'postgres') {
			config.host = config.host || 'localhost';
			config.port = config.port || 5432;
		} else if (mappedAdapter === 'mysql2') {
			config.host = config.host || 'localhost';
			config.port = config.port || 3306;
		}

		if (mappedAdapter === 'sqlite' && config.database) {
			const workspaceRoot = getBasePath();
			if (workspaceRoot && !path.isAbsolute(config.database)) {
				config.database = path.resolve(workspaceRoot, config.database);
				log('Rails Core', `Resolved SQLite database path to: ${config.database}`);
			}
		}

		log('Rails Core', `Successfully parsed database configuration for ${environment}`);
		return config;
	} catch (error) {
		log('Rails Core', `Error parsing database.yml: ${String(error)}`);
		return null;
	}
}

export function createKnexConnection(config: RailsDatabaseConfig): knexlib.Knex | null {
	try {
		log('Rails Core', `Creating Knex connection for adapter: ${config.adapter}`);

		if (config.adapter === 'sqlite') {
			return knexlib({
				client: 'sqlite3',
				connection: {
					filename: config.database
				},
				useNullAsDefault: true
			});
		} else if (config.adapter === 'postgres') {
			return knexlib({
				client: 'pg',
				connection: {
					host: config.host,
					port: config.port,
					user: config.username,
					password: config.password,
					database: config.database
				},
				pool: {
					min: 0,
					max: config.pool || 10
				},
				acquireConnectionTimeout: config.timeout || 60000
			});
		} else if (config.adapter === 'mysql2') {
			return knexlib({
				client: 'mysql2',
				connection: {
					host: config.host,
					port: config.port,
					user: config.username,
					password: config.password,
					database: config.database
				},
				pool: {
					min: 0,
					max: config.pool || 10
				},
				acquireConnectionTimeout: config.timeout || 60000
			});
		}

		log('Rails Core', `Unsupported adapter for Knex connection: ${config.adapter}`);
		return null;
	} catch (error) {
		log('Rails Core', `Error creating Knex connection: ${String(error)}`);
		return null;
	}
}