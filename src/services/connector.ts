import * as vscode from 'vscode';
import knexlib from "knex";
import { log } from './logging-service';
import { logToOutput } from './output-service';
import { KnexClientType } from '../types';

export async function getConnectionFor(description: string, dialect: KnexClientType, host: string, port: number, username: string, password: string, database: string | undefined = undefined, notifyOnError = true): Promise<knexlib.Knex | undefined> {

	log(`Connector - ${description}`, `Attempting to connect to database: dialect=${dialect}, host=${host}, port=${port}, username=${username}, database=${database}`);

	try {
		const knex = knexlib.knex({
			client: dialect,
			connection: {
				host: host ? String(host) : host,
				port: port ? Number(port) : port,
				user: username ? String(username) : username,
				password: password ? String(password) : password,
				database: database ? String(database) : database,
			},
		});

		return knex
	} catch (error) {
		const message = `Connection error for '${dialect} dialect': ${String(error)}`
		if (notifyOnError) {
			vscode.window.showErrorMessage(message)
		}

		logToOutput(message, 'Connector')

		return;
	}
}
