import * as vscode from 'vscode';
import { getEnvFileValue } from "./laravel-core";
import { Dialect, Sequelize } from "sequelize";
import { getConnectionFor } from "../sequelize-connector";
import { LaravelConnection } from '../../types';
import { getPortFromDockerCompose, hasLaravelSailDockerComposeFile } from './sail';
import { log } from '../logging-service';
import { reportError } from '../initialization-error-service';

export async function getConnectionInEnvFile(connection: LaravelConnection, dialect: Dialect): Promise<Sequelize | undefined> {
	log('Laravel env file parser', 'Fetching connection details from .env file. Laravel connection: ', connection);
	const envConnection = await getEnvFileValue('DB_CONNECTION');
	const host = await getHost();
	const username = await getEnvFileValue('DB_USERNAME') || '';
	const password = await getEnvFileValue('DB_PASSWORD') || '';
	const database = await getEnvFileValue('DB_DATABASE');
	log('Laravel env file parser', `Laravel/${dialect} connection details: connection=${envConnection}, host=${host}, username=${username}, database=${database}`);

	if (!database) {
		reportError('Missing database name in .env file')
		return
	}

	if (connection !== envConnection) {
		log('Laravel env file parser', `Connection type mismatch: expected "${connection}", found "${envConnection}"`);
		return;
	}

	if (dialect !== 'mysql' && dialect !== 'postgres') {
		vscode.window.showErrorMessage(`No support for '${dialect}' in Laravel Sail yet`)

		log('Laravel env file parser', `Error connecting using host configured in .env file. Conn:`, connection);
		return;
	}

	let portOrConnection = await getSuccessfulConnectionOrPort(dialect, host, username, password, database);

	if (!database || !portOrConnection) {
		log('Laravel env file parser', `Missing database or port: database=${database}, port=${portOrConnection}`);
		return;
	}

	log('Laravel env file parser', `Laravel/${dialect} connection details:`, envConnection, host, portOrConnection, username, database);
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
	return await getConnectionFor('Laravel provider - env file parser', dialect, host, port, username, password, database)
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
async function getSuccessfulConnectionOrPort(dialect: Dialect, host: string, username: string, password: string, database: string): Promise<Sequelize | number | undefined> {
	if (await hasLaravelSailDockerComposeFile()) {

		const dockerPort = await getPortFromDockerCompose(dialect)

		if (dockerPort) {
			const connection = await tryGetConnection(dialect, host, dockerPort, username, password, database)
			if (connection) {
				return connection
			}
		}
	}

	const portInEnvFile = await getEnvFileValue('DB_PORT')
	return parseInt(portInEnvFile || '3306')
}

async function tryGetConnection(dialect: Dialect, host: string, port: number, username: string, password: string, database: string): Promise<Sequelize | undefined> {
	return await getConnectionFor('Laravel provider - env file parser', dialect, host, port, username, password, database, false)
}

