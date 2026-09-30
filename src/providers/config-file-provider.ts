import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { SqliteEngine } from '../database-engines/sqlite-engine';
import { getConfigFileContent, getConfigFilePath } from '../services/config-service';
import { brief } from '../services/string';
import { DatabaseEngine, DatabaseEngineProvider, EngineProviderCache, EngineProviderOption, MysqlConfig, PostgresConfig, SqliteConfig, MssqlConfig, DuckDbConfig, RedisConfig, ClickhouseConfig } from '../types';
import { MysqlEngine } from '../database-engines/mysql-engine';
import { DuckDbEngine } from '../database-engines/duckdb-engine';
import { getConnectionFor } from '../services/connector';
import { PostgresEngine } from '../database-engines/postgres-engine';
import { MssqlEngine } from '../database-engines/mssql-engine';
import { showErrorWithConfigFileButton } from '../services/config-error-service';
import { reportError } from '../services/initialization-error-service';
import { hasProLicense, proRequiredMessage } from '../services/pro-gate';
import { createRemoteEngine } from '../services/connection-tester';

type ConfigFileEntry = SqliteConfig | MysqlConfig | PostgresConfig | MssqlConfig | DuckDbConfig | RedisConfig | ClickhouseConfig

/**
 * Config entries already warned about a missing Pro license in this session, so the
 * warning is not repeated on every provider refresh.
 */
const proWarningsShown = new Set<string>()

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

		const configContent = await getConfigFileContent() as ConfigFileEntry[] | undefined
		if (!configContent) return false
		if (!configContent.length) return false
		if (!this.cache) this.cache = []

		for (const config of configContent) {

			try {
				await resolveConfigFileEntry(this, config)
			} catch (error) {
				reportError(String(error))
			}
		}

		return (this.cache ?? []).length > 0
	},

	async resolveConfiguration(config: SqliteConfig | MysqlConfig | PostgresConfig | MssqlConfig | DuckDbConfig): Promise<boolean> {
		return resolveConfigFileEntry(this, config)
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

async function resolveConfigFileEntry(provider: DatabaseEngineProvider, config: ConfigFileEntry): Promise<boolean> {
	if (!provider.cache) provider.cache = []

	if (config.type === 'sqlite') {
		const connection = await sqliteConfigResolver(config)
		if (connection) provider.cache.push(connection)
	}

	if (config.type === 'duckdb') {
		const connection = await duckdbConfigResolver(config)
		if (connection) provider.cache.push(connection)
	}

	const requiresName = config.type === 'mysql' || config.type === 'mariadb' || config.type === 'postgres' || config.type === 'mssql' || config.type === 'redis' || config.type === 'clickhouse'
	if (requiresName && !config.name) {
		return await reportNameError(config);
	}

	if (config.type === 'mysql' || config.type === 'mariadb') {
		const connection: EngineProviderCache | undefined = await mysqlConfigResolver(config)
		if (connection) provider.cache.push(connection)
	}

	if (config.type === 'postgres') {
		const connection: EngineProviderCache | undefined = await postgresConfigResolver(config)
		if (connection) provider.cache.push(connection)
	}

	if (config.type === 'mssql') {
		const connection: EngineProviderCache | undefined = await mssqlConfigResolver(config)
		if (connection) provider.cache.push(connection)
	}

	if (config.type === 'redis' || config.type === 'clickhouse') {
		const connection: EngineProviderCache | undefined = await remoteDatastoreConfigResolver(config)
		if (connection) provider.cache.push(connection)
	}

	return true
}

/**
 * Returns false (and warns once per entry) when a Pro datastore entry is used without a DevDb Pro license.
 */
function allowProConfigEntry(feature: string, entryKey: string): boolean {
	if (hasProLicense()) return true

	if (!proWarningsShown.has(entryKey)) {
		proWarningsShown.add(entryKey)
		vscode.window.showWarningMessage(`${proRequiredMessage(feature)} (.devdbrc entry: ${entryKey})`)
	}

	return false
}

async function remoteDatastoreConfigResolver(config: RedisConfig | ClickhouseConfig): Promise<EngineProviderCache | undefined> {
	const label = config.type === 'redis' ? 'Redis / Valkey' : 'ClickHouse'
	if (!allowProConfigEntry(label, config.name)) return

	const result = config.type === 'redis'
		? await createRemoteEngine({
			id: `config-file:${config.name}`,
			name: config.name,
			type: 'redis',
			host: config.host ?? 'localhost',
			port: config.port,
			username: config.username,
			database: config.database !== undefined ? String(config.database) : undefined,
			keyPrefix: config.keyPrefix,
			tls: config.tls,
		}, { password: config.password, connectionString: config.connectionString })
		: await createRemoteEngine({
			id: `config-file:${config.name}`,
			name: config.name,
			type: 'clickhouse',
			host: config.host ?? 'localhost',
			port: config.port,
			protocol: config.protocol,
			username: config.username,
			database: config.database,
		}, { password: config.password })

	if (!result.engine) {
		vscode.window.showErrorMessage(`The ${label} connection ${config.name} specified in your config file is not valid: ${result.error}`)
		return
	}

	return {
		id: config.name,
		description: config.name,
		type: config.type,
		engine: result.engine,
	}
}

async function reportNameError(config: MysqlConfig | PostgresConfig | MssqlConfig | RedisConfig | ClickhouseConfig) {
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
		case 'redis':
			typeName = 'Redis';
			break;
		case 'clickhouse':
			typeName = 'ClickHouse';
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

/**
 * A relative `path` in .devdbrc is relative to the folder of the .devdbrc file.
 */
function resolveConfigPath(path: string): string {
	const configFile = getConfigFilePath()
	return isAbsolute(path) || !configFile ? path : resolve(dirname(configFile), path)
}

async function sqliteConfigResolver(sqliteConnection: SqliteConfig): Promise<EngineProviderCache | undefined> {

	sqliteConnection = { ...sqliteConnection, path: resolveConfigPath(sqliteConnection.path) }

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

async function duckdbConfigResolver(duckdbConfig: DuckDbConfig): Promise<EngineProviderCache | undefined> {

	if (!allowProConfigEntry('DuckDB', duckdbConfig.path)) return

	duckdbConfig = { ...duckdbConfig, path: resolveConfigPath(duckdbConfig.path) }

	if (!existsSync(duckdbConfig.path)) {
		await showErrorWithConfigFileButton(
			`A path to a DuckDB database file specified in your config file is not valid: ${duckdbConfig.path}`,
			duckdbConfig
		);
		return Promise.resolve(undefined);
	}

	const engine: DuckDbEngine = new DuckDbEngine(duckdbConfig.path, { readOnly: duckdbConfig.readOnly !== false })
	const isOkay = (await engine.isOkay())
	if (!isOkay) {
		await showErrorWithConfigFileButton(
			'The DuckDB database specified in your config file is not valid.',
			duckdbConfig
		);
		return
	} else {
		return {
			id: duckdbConfig.path,
			details: duckdbConfig.path,
			description: brief(duckdbConfig.path),
			type: 'duckdb',
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

