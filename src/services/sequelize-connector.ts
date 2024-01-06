import * as vscode from 'vscode';
import { Dialect, Sequelize } from "sequelize";

export async function getConnectionFor(dialect: Dialect, host: string, port: number, username: string, password: string, database: string): Promise<Sequelize | undefined> {
	try {
		const sequelize = new Sequelize({
			dialect,
			host,
			port,
			username,
			password,
			database,
			logging: false,
		});
		await sequelize.authenticate();
		return sequelize
	} catch (error) {
		vscode.window.showErrorMessage(`Connection error for '${dialect} dialect': ${String(error)}`)
		return
	}
}