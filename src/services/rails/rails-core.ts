import { exec } from 'child_process';
import { promisify } from 'util';
import { getPathToWorkspaceFile, getWorkspaceFileContent, getBasePath } from '../workspace';
import { log } from '../logging-service';
import * as path from 'path';

const execAsync = promisify(exec);

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

export interface RubyEnvConfig {
	env_name: string;
	name: string;
	adapter_class: string | null;
	configuration_hash: {
		adapter: string;
		database: string;
		host: string;
		port: number;
		username: string;
		password: string;
		pool: number;
		timeout: number;
	}
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

export async function parseDatabaseYml(environment: string): Promise<RailsDatabaseConfig | null> {
	try {
		log('Rails Core', `Getting database configuration for environment: ${environment} using Rails runner`);

		const workspaceRoot = getBasePath();
		if (!workspaceRoot) {
			log('Rails Core', 'No workspace root found');
			return null;
		}

		const command = `bin/rails runner -w 'require "json"; puts JSON.pretty_generate(ActiveRecord::Base.configurations.as_json)'`;
		const fallbackCommand = `bundle exec rails runner -w 'require "json"; puts JSON.pretty_generate(ActiveRecord::Base.configurations.as_json)'`;

		let stdout: string;
		try {
			const result = await execAsync(command, { cwd: workspaceRoot });
			stdout = result.stdout;
		} catch (error) {
			log('Rails Core', `Primary Rails runner command failed, trying fallback: ${fallbackCommand}`);
			try {
				const result = await execAsync(fallbackCommand, { cwd: workspaceRoot });
				stdout = result.stdout;
			} catch (fallbackError) {
				log('Rails Core', `Both Rails runner commands failed. Primary error: ${String(error)}, Fallback error: ${String(fallbackError)}`);
				return null;
			}
		}

		if (!stdout || stdout.trim() === '') {
			log('Rails Core', 'Rails runner command returned empty output');
			return null;
		}

		log('Rails Core', 'Rails runner command executed successfully');

		let configurations: RubyEnvConfig[];
		try {
			configurations = JSON.parse(stdout)?.configurations;
		} catch (parseError) {
			log('Rails Core', `Failed to parse JSON output from Rails runner: ${String(parseError)}`);
			return null;
		}

		if (!configurations || typeof configurations !== 'object') {
			log('Rails Core', 'Invalid configuration structure returned from Rails runner');
			return null;
		}

		const envConfig = configurations.find(config => config.env_name === environment);
		if (!envConfig || typeof envConfig !== 'object') {
			log('Rails Core', `No configuration found for environment: ${environment}`);
			return null;
		}

		const adapter = envConfig.configuration_hash?.adapter;
		if (!adapter) {
			log('Rails Core', `No adapter specified for environment: ${environment}`);
			return null;
		}

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
			database: envConfig.configuration_hash?.database,
			host: envConfig.configuration_hash?.host,
			port: envConfig.configuration_hash?.port,
			username: envConfig.configuration_hash?.username,
			password: envConfig.configuration_hash?.password,
			pool: envConfig.configuration_hash?.pool,
			timeout: envConfig.configuration_hash?.timeout
		};

		if (mappedAdapter === 'postgres') {
			config.host = config.host || 'localhost';
			config.port = config.port || 5432;
		} else if (mappedAdapter === 'mysql2') {
			config.host = config.host || 'localhost';
			config.port = config.port || 3306;
		}

		if (mappedAdapter === 'sqlite' && config.database) {
			if (!path.isAbsolute(config.database)) {
				config.database = path.resolve(workspaceRoot, config.database);
				log('Rails Core', `Resolved SQLite database path to: ${config.database}`);
			}
		}

		log('Rails Core', `Successfully parsed database configuration for ${environment} using Rails runner`);
		return config;
	} catch (error) {
		log('Rails Core', `Error getting database configuration using Rails runner: ${String(error)}`);
		return null;
	}
}

