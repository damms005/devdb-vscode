import * as vscode from 'vscode';
import { Dialect, Sequelize } from "sequelize";
import { log } from './logging-service';

export async function getConnectionFor(dialect: Dialect, host: string, port: number, username: string, password: string, database: string | undefined = undefined): Promise<Sequelize | undefined> {
	log(`Attempting to connect to database: dialect=${dialect}, host=${host}, port=${port}, username=${username}, database=${database}`);
	try {
		const sequelize = new Sequelize({
			dialect,
			host: host ? String(host) : host,
			port: port ? Number(port) : port,
			username: username ? String(username) : username,
			password: password ? String(password) : password,
			database: database ? String(database) : database,
			logging: false,
		});
		await sequelize.authenticate();

		log(`Good: dialect=${dialect}, host=${host}, port=${port}, username=${username}, database=${database}`);

		return sequelize
	} catch (error) {
		vscode.window.showErrorMessage(`Connection error for '${dialect} dialect': ${String(error)}`)
		log(`Connection error for '${dialect}' dialect: ${String(error)}`, error);
		return;
	}
}
