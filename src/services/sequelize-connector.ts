import * as vscode from 'vscode';
import { Dialect, Sequelize } from "sequelize";

export async function getConnectionFor(dialect: Dialect, host: string, port: number, username: string, password: string, database: string): Promise<Sequelize | undefined> {
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
		return sequelize
	} catch (error) {
		vscode.window.showErrorMessage(`Connection error for '${dialect} dialect': ${String(error)}`)
		return
	}
}