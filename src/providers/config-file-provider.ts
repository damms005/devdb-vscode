import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { SqliteEngine } from '../database-engines/sqlite-engine';
import { getConfigFileContent } from '../services/config-service';
import { brief } from '../services/string';
import { DatabaseEngine, DatabaseEngineProvider, EngineProviderCache, EngineProviderOption, MysqlConfig, PostgresConfig, SqliteConfig, MssqlConfig, ConfigFileConnectionTypes } from '../types';
import { MysqlEngine } from '../database-engines/mysql-engine';
import { getConnectionFor } from '../services/connector';
import { PostgresEngine } from '../database-engines/postgres-engine';
import { MssqlEngine } from '../database-engines/mssql-engine';
import { showErrorWithConfigFileButton } from '../services/config-error-service';
import { reportError } from '../services/initialization-error-service';

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

			try {
				await this.resolveConfiguration!(config)
			} catch (error) {
				reportError(String(error))
			}
		}

		return (this.cache ?? []).length > 0
	},

	async resolveConfiguration(config: SqliteConfig | MysqlConfig | PostgresConfig | MssqlConfig): Promise<boolean> {
		if (!this.cache) this.cache = []

		if (config.type === 'sqlite') {
			const connection = await sqliteConfigResolver(config)
			if (connection) this.cache.push(connection)
		}

		const requiresName = config.type === 'mysql' || config.type === 'mariadb' || config.type === 'postgres' || config.type === 'mssql'
		if (requiresName && !config.name) {
			return await reportNameError(config);
		}

		if (config.type === 'mysql' || config.type === 'mariadb') {
			const connection: EngineProviderCache | undefined = await mysqlConfigResolver(config)
			if (connection) this.cache?.push(connection)
		}

		if (config.type === 'postgres') {
			const connection: EngineProviderCache | undefined = await postgresConfigResolver(config)
			if (connection) this.cache?.push(connection)
		}

		if (config.type === 'mssql') {
			const connection: EngineProviderCache | undefined = await mssqlConfigResolver(config)
			if (connection) this.cache?.push(connection)
		}

		return true
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace()
	},

	async getDatabaseEngine(option: EngineProviderOption): Promise<DatabaseEngine | undefined> {
		if (option) {
			const matchedOption = Object.values(this.cache ?? {}).find((cache: { id: unknown }) => cache.id === option.option.id)
			if (!matchedOption) {
				await vscode.window.showErrorMessage(`Could not find option with id ${option.option.id}`)
				return
			}

			this.engine = matchedOption.engine
		}

		return this.engine
	}
}

async function reportNameError(config: MysqlConfig | PostgresConfig | MssqlConfig) {
	let typeName;

	switch (config.type) {
		case 'mysql':
			typeName = 'MySQL';
			break;
		case 'mariadb':
			typeName = 'MariaDB';
			break;
		case 'postgres':
			typeName = 'Postgres';
			break;
		case 'mssql':
			typeName = 'MSSQL';
			break;
	}

	await vscode.window.showErrorMessage(`The ${typeName} config file entry ${config.name || ''} does not have a name.`);
	return false;
}

async function mssqlConfigResolver(mssqlConfig: MssqlConfig): Promise<EngineProviderCache | undefined> {
	const connection = await getConnectionFor('Config file provider', 'mssql', mssqlConfig.host, mssqlConfig.port, mssqlConfig.username, mssqlConfig.password, mssqlConfig.database, false, mssqlConfig.options)
	if (!connection) return

	const engine: MssqlEngine = new MssqlEngine(connection)
	const isOkay = (await engine.isOkay())
	if (!isOkay || !engine.connection) {
		await showErrorWithConfigFileButton(
			`The MSSQL connection ${mssqlConfig.name || ''} specified in your config file is not valid.`,
			mssqlConfig
		);
		return
	}

	return {
		id: mssqlConfig.name,
		description: mssqlConfig.name,
		type: 'mssql',
		engine: engine
	}
}

async function sqliteConfigResolver(sqliteConnection: SqliteConfig): Promise<EngineProviderCache | undefined> {

	if (!existsSync(sqliteConnection.path)) {
		await showErrorWithConfigFileButton(
			`A path to an SQLite database file specified in your config file is not valid: ${sqliteConnection.path}`,
			sqliteConnection
		);
		return Promise.resolve(undefined);
	}

	const engine: SqliteEngine = new SqliteEngine(sqliteConnection.path)
	const isOkay = (await engine.isOkay())
	if (!isOkay) {
		await showErrorWithConfigFileButton(
			'The SQLite database specified in your config file is not valid.',
			sqliteConnection
		);
		return
	} else {
		return {
			id: sqliteConnection.path,
			details: sqliteConnection.path,
			description: brief(sqliteConnection.path),
			type: 'sqlite',
			engine: engine
		}
	}
}

async function mysqlConfigResolver(mysqlConfig: MysqlConfig): Promise<EngineProviderCache | undefined> {
	const connection = await getConnectionFor('Config file provider', 'mysql2', mysqlConfig.host, mysqlConfig.port, mysqlConfig.username, mysqlConfig.password, mysqlConfig.database, false)
	if (!connection) {
		await showErrorWithConfigFileButton(`The MySQL connection ${mysqlConfig.name || ''} specified in your config file is not valid.`, mysqlConfig);
		return
	}

	const engine: MysqlEngine = new MysqlEngine(connection)
	const isOkay = (await engine.isOkay())
	if (!isOkay || !engine.connection) {
		await showErrorWithConfigFileButton(`The MySQL connection ${mysqlConfig.name || ''} specified in your config file is not valid.`, mysqlConfig);
		return
	}

	return {
		id: mysqlConfig.name,
		description: mysqlConfig.name,
		type: 'mysql',
		engine: engine
	}
}

async function postgresConfigResolver(postgresConfig: PostgresConfig): Promise<EngineProviderCache | undefined> {
	const connection = await getConnectionFor('Config file provider', 'postgres', postgresConfig.host, postgresConfig.port, postgresConfig.username, postgresConfig.password, postgresConfig.database, false)
	if (!connection) {
		await showErrorWithConfigFileButton(`The Postgres connection ${postgresConfig.name || ''} specified in your config file is not valid.`, postgresConfig);
		return
	}

	const engine: PostgresEngine = new PostgresEngine(connection)
	const isOkay = (await engine.isOkay())
	if (!isOkay || !engine.connection) {
		await showErrorWithConfigFileButton(`The Postgres connection ${postgresConfig.name || ''} specified in your config file is not valid.`, postgresConfig);
		return
	}

	return {
		id: postgresConfig.name,
		description: postgresConfig.name,
		type: 'postgres',
		engine: engine
	}
}
