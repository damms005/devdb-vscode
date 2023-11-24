import { join } from 'path';
import { DotenvParseOutput, parse } from 'dotenv';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { SqliteEngine } from '../../database-engines/sqlite-engine';
import { fileExists, getFirstWorkspacePath, getWorkspaceFileContent } from '../../services/workspace';

export const LaravelLocalSqliteProvider: DatabaseEngineProvider = {
	name: 'Laravel Local SQLite (default)',
	type: 'sqlite',
	id: 'laravel-local-sqlite',
	description: 'Laravel with local default SQLite database',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		const configContent = getWorkspaceFileContent('config', 'database.php');
		if (!configContent) return false;

		const envFileContents = getWorkspaceFileContent('.env');
		if (!envFileContents) return false;

		const env = parse(envFileContents);
		const usesSqlite = env.DB_CONNECTION == 'sqlite';
		if (!usesSqlite) return false;

		const sqliteFilePath = await getSqliteFilePath(configContent.toString(), env)

		this.engine = new SqliteEngine(sqliteFilePath);

		return (await this.engine.getTables()).length > 0
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine
	}
}

async function getSqliteFilePath(configContent: string, envFileContent: DotenvParseOutput): Promise<string> {
	// Match /env('DB_DATABASE', database_path('database.sqlite'))/ irrespective of whitespace
	const databasePathRegex = /env\(\s*['"]DB_DATABASE['"]\s*,\s*database_path\(\s*['"]database\.sqlite['"]\s*\)\s*\)/;
	if (!databasePathRegex.test(configContent)) return '';

	const databasePathDefinedInEnv = envFileContent.DB_DATABASE;
	if (databasePathDefinedInEnv) return databasePathDefinedInEnv;

	const workspacePath = getFirstWorkspacePath()
	if (!workspacePath) return ''

	const databaseFilePath = join(workspacePath, 'database', 'database.sqlite');

	const exists = await fileExists(databaseFilePath)
	if (!exists) return '';

	return databaseFilePath
}