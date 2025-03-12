import * as vscode from 'vscode';
import { getEnvFileValue } from "./adonis-core";
import { Dialect, Sequelize } from "sequelize";
import { getConnectionFor } from "../sequelize-connector";
import { LaravelConnection } from '../../types';
import { log } from '../logging-service';
import { reportError } from '../initialization-error-service';

export async function getConnectionInEnvFile(connection: LaravelConnection, dialect: Dialect): Promise<Sequelize | undefined> {
	log('Adonis env file parser', 'Fetching connection details from .env file. Laravel connection: ', connection);
	const host = await getHost();
	const username = await getEnvFileValue('DB_USER') || '';
	const password = await getEnvFileValue('DB_PASSWORD') || '';
	const database = await getEnvFileValue('DB_DATABASE');
	log('Adonis env file parser', `Laravel/${dialect} connection details: host=${host}, username=${username}, database=${database}`);

	if (!database) {
		reportError('Missing database name in .env file')
		return
	}

	if (dialect !== 'mysql' && dialect !== 'postgres') {
		vscode.window.showErrorMessage(`No support for '${dialect}' in Laravel Sail yet`)

		log('Adonis env file parser', `Error connecting using host configured in .env file. Conn:`, connection);
		return;
	}

	let portOrConnection = await getSuccessfulConnectionOrPort(dialect, host, username, password, database);

	if (!database || !portOrConnection) {
		log('Adonis env file parser', `Missing database or port: database=${database}, port=${portOrConnection}`);
		return;
	}

	log('Adonis env file parser', `Laravel/${dialect} connection details:`, host, portOrConnection, username, database);
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
	return await getConnectionFor('Adonis env file parser', dialect, host, port, username, password, database)
}

async function getHost() {
	const localhost = '127.0.0.1'

	return (await getEnvFileValue('DB_HOST')) || localhost
}

async function getSuccessfulConnectionOrPort(dialect: Dialect, host: string, username: string, password: string, database: string): Promise<Sequelize | number | undefined> {
	const portInEnvFile = await getEnvFileValue('DB_PORT')
	return parseInt(portInEnvFile || '3306')
}
