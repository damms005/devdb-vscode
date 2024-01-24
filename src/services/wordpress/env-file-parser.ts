import * as vscode from 'vscode';
import { getConfigFileValue } from "./wordpress-core";
import { Dialect, Sequelize } from "sequelize";
import { getConnectionFor } from "../sequelize-connector";
import { LaravelConnection } from '../../types';

export async function getConnectionInEnvFile(connection: LaravelConnection, dialect: Dialect): Promise<Sequelize | undefined> {
	const host = await getHost()
	const username = await getConfigFileValue('DB_USER') || ''
	const password = await getConfigFileValue('DB_PASSWORD') || ''
	const database = await getConfigFileValue('DB_NAME')
	let port = await getPort()

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

	return (await getConfigFileValue('DB_HOST')) || localhost
}

async function getPort(): Promise<number | undefined> {
	return parseInt(await getConfigFileValue('DB_PORT') || '3306')
}
