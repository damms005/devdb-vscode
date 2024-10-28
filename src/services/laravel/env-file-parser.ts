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
	log(`Laravel/${dialect} connection details: connection=${envConnection}, host=${host}, username=${username}, database=${database}`);

	if (connection !== envConnection) {
		log(`Connection type mismatch: expected "${connection}", found "${envConnection}"`);
		return;
	}

	if (dialect !== 'mysql' && dialect !== 'postgres') {
		vscode.window.showErrorMessage(`No support for '${dialect}' in Laravel Sail yet`)

		log(`Error connecting using host configured in .env file. Conn:`, connection);
		return;
	}

	let portOrConnection = await getSuccessfulConnectionOrPort(dialect, host, username, password)

	if (!database || !portOrConnection) {
		log(`Missing database or port: database=${database}, port=${portOrConnection}`);
		return;
	}

	log(`Laravel/${dialect} connection details:`, envConnection, host, portOrConnection, username, database);
	if (typeof portOrConnection === 'object') {
		return portOrConnection
	}

	try {
		return await connectUsingHostConfiguredInEnvFile(dialect, host, portOrConnection, username, password, database)
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

/**
 * A user ran into a bug whereby Sails was configured i.e. FORWARD_DB_PORT was defined.
 * At same time, DB_PORT was defined. However, latter was actually used in project and
 * former was just an obsolete config dangling around. This broke DevDb because we were
 * connecting with Sails config first if found, then proceed with DB_PORT otherwise.
 * This change below ensures that we only prioritize Sails config if we able to connect to
 * it.
 */
async function getSuccessfulConnectionOrPort(dialect: Dialect, host: string, username: string, password: string): Promise<Sequelize | number | undefined> {
	if (await hasLaravelSailDockerComposeFile()) {

		const dockerPort = await getPortFromDockerCompose(dialect)

		if (dockerPort) {
			if (await tryGetConnection(dialect, host, dockerPort, username, password)) {
				return getPortFromDockerCompose(dialect)
			}
		}
	}

	return parseInt(await getEnvFileValue('DB_PORT') || '3306')
}

async function tryGetConnection(dialect: Dialect, host: string, port: number, username: string, password: string): Promise<Sequelize | undefined> {
	return await getConnectionFor(dialect, host, port, username, password)
}

