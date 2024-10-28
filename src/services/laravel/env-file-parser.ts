import * as vscode from 'vscode';
import { getEnvFileValue } from "./laravel-core";
import { Dialect, Sequelize } from "sequelize";
import { getConnectionFor } from "../sequelize-connector";
import { LaravelConnection } from '../../types';
import { getPortFromDockerCompose, hasLaravelSailDockerComposeFile } from './sail';
import { log } from '../logging-service';

export async function getConnectionInEnvFile(connection: LaravelConnection, dialect: Dialect): Promise<Sequelize | undefined> {
	log('Fetching connection details from .env file. Laravel connection: ', connection);
	const envConnection = await getEnvFileValue('DB_CONNECTION');
	const host = await getHost();
	const username = await getEnvFileValue('DB_USERNAME') || '';
	const password = await getEnvFileValue('DB_PASSWORD') || '';
	const database = await getEnvFileValue('DB_DATABASE');
	log(`Connection details: connection=${envConnection}, host=${host}, username=${username}, database=${database}`);

	if (connection !== envConnection) {
		log(`Connection type mismatch: expected "${connection}", found "${envConnection}"`);
		return;
	}

	if (dialect !== 'mysql' && dialect !== 'postgres') {
		vscode.window.showErrorMessage(`No support for '${dialect}' in Laravel Sail yet`)

		log(`Error connecting using host configured in .env file. Conn:`, connection);
		return;
	}

	let port = await getPort(dialect)

	if (!database || !port) {
		log(`Missing database or port: database=${database}, port=${port}`);
		return;
	}

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

	const isALaravelSailWorkspace = await hasLaravelSailDockerComposeFile()

	if (isALaravelSailWorkspace && vscode.env.remoteName != "dev-container") {
		return localhost
	}

	return (await getEnvFileValue('DB_HOST')) || localhost
}

async function getPort(service: 'mysql' | 'postgres'): Promise<number | undefined> {
	if (await hasLaravelSailDockerComposeFile()) {
		return getPortFromDockerCompose(service)
	}

	return parseInt(await getEnvFileValue('DB_PORT') || '3306')
}
