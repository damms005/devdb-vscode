import { exec } from 'child_process';
import { promisify } from 'util';
import { getPathToWorkspaceFile, getBasePath } from '../workspace';
import { log } from '../logging-service';
import * as path from 'path';

const execAsync = promisify(exec);

export interface DjangoDatabaseConfig {
	adapter: string;
	database: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	pool?: number;
	timeout?: number;
}

export function isDjangoProject(): boolean {
	try {
		const managePyPath = getPathToWorkspaceFile('manage.py');
		if (!managePyPath) {
			log('Django Core', 'No manage.py found in workspace root');
			return false;
		}

		log('Django Core', 'Django project detected successfully');
		return true;
	} catch (error) {
		log('Django Core', `Error checking Django project: ${String(error)}`);
		return false;
	}
}

export function getDjangoDbAlias(): string {
	return process.env.DJANGO_DB_ALIAS || 'default';
}

export async function getDatabaseConfig(alias: string): Promise<DjangoDatabaseConfig | null> {
	try {
		log('Django Core', `Getting database configuration for alias: ${alias} using Django shell`);

		const workspaceRoot = getBasePath();
		if (!workspaceRoot) {
			log('Django Core', 'No workspace root found');
			return null;
		}

		const pythonPath = process.platform === 'win32'
			? path.join(workspaceRoot, 'venv', 'Scripts', 'python.exe')
			: path.join(workspaceRoot, 'venv', 'bin', 'python');

		const shellCommand = `"import json; from django.conf import settings; from pathlib import Path; db = settings.DATABASES; db['default']['NAME'] = str(db['default']['NAME']); print(json.dumps(db))"`;
		const command = `${pythonPath} manage.py shell -c ${shellCommand}`;
		let stdout: string | null = null;
		let lastError: any = null;

		try {
			log('Django Core', `Trying command: ${command}`);
			const result = await execAsync(command, { cwd: workspaceRoot });
			stdout = result.stdout;
		} catch (error) {
			lastError = error;
			log('Django Core', `Command failed: ${command}, error: ${String(error)}`);
		}

		if (!stdout || stdout.trim() === '') {
			log('Django Core', `All Django shell commands failed. Last error: ${String(lastError)}`);
			return null;
		}

		log('Django Core', 'Django shell command executed successfully');

		let databases: Record<string, any>;
		try {
			databases = JSON.parse(stdout.trim());
		} catch (parseError) {
			log('Django Core', `Failed to parse JSON output from Django shell: ${String(parseError)}`);
			return null;
		}

		if (!databases || typeof databases !== 'object') {
			log('Django Core', 'Invalid database configuration structure returned from Django shell');
			return null;
		}

		const dbConfig = databases[alias];
		if (!dbConfig || typeof dbConfig !== 'object') {
			log('Django Core', `No configuration found for database alias: ${alias}`);
			return null;
		}

		const engine = dbConfig.ENGINE;
		if (!engine) {
			log('Django Core', `No ENGINE specified for database alias: ${alias}`);
			return null;
		}

		let mappedAdapter: string;
		switch (engine) {
			case 'django.db.backends.postgresql':
				mappedAdapter = 'postgres';
				break;
			case 'django.db.backends.mysql':
				mappedAdapter = 'mysql';
				break;
			case 'django.db.backends.sqlite3':
				mappedAdapter = 'sqlite';
				break;
			default:
				log('Django Core', `Unsupported database engine: ${engine}`);
				return null;
		}

		const config: DjangoDatabaseConfig = {
			adapter: mappedAdapter,
			database: dbConfig.NAME,
			host: dbConfig.HOST,
			port: dbConfig.PORT,
			username: dbConfig.USER,
			password: dbConfig.PASSWORD,
			pool: dbConfig.CONN_MAX_AGE,
			timeout: dbConfig.OPTIONS?.connect_timeout
		};

		// Apply default values for missing host/port configuration
		if (mappedAdapter === 'postgres') {
			config.host = config.host || 'localhost';
			config.port = config.port || 5432;
		} else if (mappedAdapter === 'mysql') {
			config.host = config.host || 'localhost';
			config.port = config.port || 3306;
		}

		// Handle SQLite database path resolution
		if (mappedAdapter === 'sqlite' && config.database) {
			// Handle special case of in-memory database
			if (config.database === ':memory:') {
				log('Django Core', 'In-memory SQLite database detected, not supported');
				return null;
			}

			// Resolve relative paths to absolute paths
			if (!path.isAbsolute(config.database)) {
				config.database = path.resolve(workspaceRoot, config.database);
				log('Django Core', `Resolved SQLite database path to: ${config.database}`);
			}
		}

		log('Django Core', `Successfully parsed database configuration for ${alias} using Django shell`);
		return config;
	} catch (error) {
		log('Django Core', `Error getting database configuration using Django shell: ${String(error)}`);
		return null;
	}
}
