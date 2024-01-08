import * as vscode from 'vscode';
import { getEnvFileValue } from "./laravel-core";
import { Dialect, Sequelize } from "sequelize";
import { getConnectionFor } from "../sequelize-connector";
import { LaravelConnection } from '../../types';
import { getPortFromDockerCompose, isLaravelSailWorkspace } from './sail';

export async function getConnectionInEnvFile(connection: LaravelConnection, dialect: Dialect): Promise<Sequelize | undefined> {
	const envConnection = await getEnvFileValue('DB_CONNECTION')
	const host = await getHost()
	const username = await getEnvFileValue('DB_USERNAME') || ''
	const password = await getEnvFileValue('DB_PASSWORD') || ''
	const database = await getEnvFileValue('DB_DATABASE')

	if (connection !== envConnection) return

	if (dialect !== 'mysql' && dialect !== 'postgres') {
		await vscode.window.showErrorMessage(`No support for '${dialect}' in Laravel Sail yet`)
		return
	}

	let port = await getPort(dialect)

	if (!database || !port) return

	try {
		return await connectUsingHostConfiguredInEnvFile(dialect, host, port, username, password, database)
	} catch (error) {
		return
	}
}

async function connectUsingHostConfiguredInEnvFile(dialect: Dialect, host: string, port: number, username: string, password: string, database: string): Promise<Sequelize | undefined> {
	return await getConnectionFor(dialect, host, port, username, password, database)
}

async function getHost() {
	const localhost = '127.0.0.1'

	if (await isLaravelSailWorkspace()) {
		return localhost
	}

	return (await getEnvFileValue('DB_HOST')) || localhost
}

async function getPort(service: 'mysql' | 'postgres'): Promise<number | undefined> {
	if (await isLaravelSailWorkspace()) {
		return getPortFromDockerCompose(service)
	}

	return parseInt(await getEnvFileValue('DB_PORT') || '3306')
}