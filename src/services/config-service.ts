import * as vscode from 'vscode';
import { CosmiconfigResult, cosmiconfig } from 'cosmiconfig';
import { SqliteConfig, MysqlConfig, MssqlConfig, PostgresConfig } from '../types';
import { getPathToWorkspaceFile } from './workspace';

export const DEVDB_CONFIG_FILE_NAME = '.devdbrc'

export function getConfigFilePath() {
	return getPathToWorkspaceFile(DEVDB_CONFIG_FILE_NAME)
}

export async function getConfigFileContent(): Promise<(SqliteConfig | MysqlConfig | MssqlConfig | PostgresConfig)[] | undefined> {
	const configFilePath = getConfigFilePath()
	if (!configFilePath) return

	try {
		const result: CosmiconfigResult = await cosmiconfig('devdb').load(configFilePath)
		if (!result) return

		return result.config as (SqliteConfig | MysqlConfig)[]
	} catch (error) {
	}
}

/**
 * Adds a SQLite database to the config file if it doesn't already exist
 */
export async function addSqlDatabaseToConfig(sqliteFilePath: string) {
	if (!sqliteFilePath) return

	const config = await getConfigFileContent() || []
	const configExists = config.some(config => config.type === 'sqlite' && config.path === sqliteFilePath)

	if (configExists) return

	config.push({
		type: 'sqlite',
		path: sqliteFilePath
	})

	await vscode.workspace.fs.writeFile(
		vscode.Uri.file(getConfigFilePath() as string),
		Buffer.from(JSON.stringify(config, null, 2))
	)
}