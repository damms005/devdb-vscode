import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider, EngineProviderCache, EngineProviderOption, MysqlConfigFileEntry, SqliteConfig } from '../types';
import { SqliteEngine } from '../database-engines/sqlite-engine';
import { getConfigFileContent } from '../services/config-service';
import { brief } from '../services/string';
import { MysqlEngine } from '../database-engines/mysql-engine';
import { connectToMysql } from '../services/mysql';

export const ConfigFileProvider: DatabaseEngineProvider = {
	name: 'Config File',
	type: 'sqlite',
	id: 'config-file-provider',
	description: 'Databases defined in your config file',
	engine: undefined,
	cache: undefined,

	async boot(): Promise<void> {
		this.cache = undefined
		this.engine = undefined
	},

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {

		const configContent: (SqliteConfig | MysqlConfigFileEntry)[] | undefined = await getConfigFileContent()
		if (!configContent) return false
		if (!configContent.length) return false
		if (!this.cache) this.cache = []

		for (const config of configContent) {
			if (config.type === 'sqlite') {
				const connection = await sqliteConfigResolver(config)
				if (connection) this.cache.push(connection)
			}

			if (config.type === 'mysql') {
				if (!config.name) {
					await vscode.window.showErrorMessage(`The MySQL config file entry ${config.name || ''} does not have a name.`)
					return false
				}
				const connection: EngineProviderCache | undefined = await mysqlConfigResolver(config)
				if (connection) this.cache.push(connection)
			}
		}

		return this.cache.length > 0
	},

	async getDatabaseEngine(option: EngineProviderOption): Promise<DatabaseEngine | undefined> {
		if (option) {
			const matchedOption = this.cache?.find((cache) => cache.id === option.option.id)
			if (!matchedOption) {
				await vscode.window.showErrorMessage(`Could not find option with id ${option.option.id}`)
				return
			}

			this.engine = matchedOption.engine
		}

		return this.engine
	}
}

async function sqliteConfigResolver(sqliteConnection: SqliteConfig): Promise<EngineProviderCache | undefined> {
	const engine: SqliteEngine = new SqliteEngine(sqliteConnection.path)
	const isOkay = (await engine.isOkay())
	if (!isOkay || !engine.sequelize) {
		await vscode.window.showErrorMessage('The SQLite database specified in your config file is not valid.')
		return
	} else {
		return {
			id: sqliteConnection.path,
			description: brief(sqliteConnection.path),
			engine: engine
		}
	}
}

async function mysqlConfigResolver(mysqlConfig: MysqlConfigFileEntry): Promise<EngineProviderCache | undefined> {
	const connection = await connectToMysql(mysqlConfig.host, mysqlConfig.port, mysqlConfig.username, mysqlConfig.password, mysqlConfig.database)
	if (!connection) return

	const engine: MysqlEngine = new MysqlEngine(connection)
	const isOkay = (await engine.isOkay())
	if (!isOkay || !engine.sequelize) {
		await vscode.window.showErrorMessage(`The MySQL connection ${mysqlConfig.name || ''} specified in your config file is not valid.`)
		return
	}

	return {
		id: mysqlConfig.name,
		description: mysqlConfig.name,
		engine: engine
	}
}