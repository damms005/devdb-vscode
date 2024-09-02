import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider, EngineProviderCache, EngineProviderOption, MysqlConfig, PostgresConfig, SqliteConfig, MssqlConfig } from '../types';
import { SqliteEngine } from '../database-engines/sqlite-engine';
import { getConfigFileContent } from '../services/config-service';
import { brief } from '../services/string';
import { MysqlEngine } from '../database-engines/mysql-engine';
import { getConnectionFor } from '../services/sequelize-connector';
import { PostgresEngine } from '../database-engines/postgres-engine';
import { MssqlEngine } from '../database-engines/mssql-engine';
import { existsSync } from 'fs';

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

		const configContent: (SqliteConfig | MysqlConfig | PostgresConfig | MssqlConfig)[] | undefined = await getConfigFileContent()
		if (!configContent) return false
		if (!configContent.length) return false
		if (!this.cache) this.cache = []

		for (const config of configContent) {
			if (config.type === 'sqlite') {
				const connection = await sqliteConfigResolver(config)
				if (connection) this.cache.push(connection)
			}

			if (config.type === 'mysql' || config.type === 'mariadb') {
				if (!config.name) {
					const db = config.type === 'mysql' ? 'MySQL' : 'MariaDB'
					await vscode.window.showErrorMessage(`The ${db} config file entry ${config.name || ''} does not have a name.`)
					return false
				}
				const connection: EngineProviderCache | undefined = await mysqlConfigResolver(config)
				if (connection) this.cache.push(connection)
			}

			if (config.type === 'postgres') {
				if (!config.name) {
					await vscode.window.showErrorMessage(`The Postgres config file entry ${config.name || ''} does not have a name.`)
					return false
				}
				const connection: EngineProviderCache | undefined = await postgresConfigResolver(config)
				if (connection) this.cache.push(connection)
			}
			if (config.type === 'mssql') {
				if (!config.name) {
					await vscode.window.showErrorMessage(`The MSSQL config file entry ${config.name || ''} does not have a name.`)
					return false
				}
				const connection: EngineProviderCache | undefined = await mssqlConfigResolver(config)
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

async function mssqlConfigResolver(mssqlConfig: MssqlConfig): Promise<EngineProviderCache | undefined> {
	const connection = await getConnectionFor('mssql', mssqlConfig.host, mssqlConfig.port, mssqlConfig.username, mssqlConfig.password, mssqlConfig.database)
	if (!connection) return

	const engine: MssqlEngine = new MssqlEngine(connection)
	const isOkay = (await engine.isOkay())
	if (!isOkay || !engine.sequelize) {
		await vscode.window.showErrorMessage(`The MSSQL connection ${mssqlConfig.name || ''} specified in your config file is not valid.`)
		return
	}

	return {
		id: mssqlConfig.name,
		description: mssqlConfig.name,
		engine: engine
	}
}

async function sqliteConfigResolver(sqliteConnection: SqliteConfig): Promise<EngineProviderCache | undefined> {

	if (!existsSync(sqliteConnection.path)) {
		vscode.window.showErrorMessage(`A path to an SQLite database file specified in your config file is not valid: ${sqliteConnection.path}`)

		return Promise.resolve(undefined);
	}

	const engine: SqliteEngine = new SqliteEngine(sqliteConnection.path)
	const isOkay = (await engine.isOkay())
	if (!isOkay || !engine.sequelize) {
		await vscode.window.showErrorMessage('The SQLite database specified in your config file is not valid.')
		return
	} else {
		return {
			id: sqliteConnection.path,
			details: sqliteConnection.path,
			description: brief(sqliteConnection.path),
			engine: engine
		}
	}
}

async function mysqlConfigResolver(mysqlConfig: MysqlConfig): Promise<EngineProviderCache | undefined> {
	const connection = await getConnectionFor('mysql', mysqlConfig.host, mysqlConfig.port, mysqlConfig.username, mysqlConfig.password, mysqlConfig.database)
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

async function postgresConfigResolver(postgresConfig: PostgresConfig): Promise<EngineProviderCache | undefined> {
	const connection = await getConnectionFor('postgres', postgresConfig.host, postgresConfig.port, postgresConfig.username, postgresConfig.password, postgresConfig.database)
	if (!connection) return

	const engine: PostgresEngine = new PostgresEngine(connection)
	const isOkay = (await engine.isOkay())
	if (!isOkay || !engine.sequelize) {
		await vscode.window.showErrorMessage(`The Postgres connection ${postgresConfig.name || ''} specified in your config file is not valid.`)
		return
	}

	return {
		id: postgresConfig.name,
		description: postgresConfig.name,
		engine: engine
	}
}
