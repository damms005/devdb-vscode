import * as vscode from 'vscode';
import { DevDbViewProvider } from "../devdb-view-provider";
import { autoConnectProvider, getAvailableProviders, getConnectedDatabase } from "./messenger";
import { DatabaseEngine } from '../types';
import { logToOutput } from './output-service';

export async function goToTable(devDbViewProvider: DevDbViewProvider | undefined) {

	logToOutput('Attempting to open table', 'Go to Table')

	if (!devDbViewProvider) {
		logToOutput('No DevDB view provider found. Please connect to a database first.', 'Go to Table')
		vscode.window.showErrorMessage('No DevDB view provider found. Please connect to a database first.');
		return;
	}

	const database = await getDatabase(devDbViewProvider)

	if (!database) {
		logToOutput('No database connection found. Please connect to one first.', 'Go to Table')
		vscode.window.showErrorMessage('No database connection found. Please connect to one first.');
		vscode.commands.executeCommand('devdb.focus');
		return;
	}

	const tables = await database.getTables();

	if (!tables || tables.length === 0) {
		logToOutput('No tables found in the currently connected database', 'Go to Table')
		vscode.window.showErrorMessage('No tables found in the currently connected database');
		return;
	}

	const selectedTable = await vscode.window.showQuickPick(tables, {
		placeHolder: 'Select a table to open',
		title: 'Go to Table'
	});

	if (selectedTable) {
		logToOutput(`Selected table: ${selectedTable}`, 'Go to Table')
		devDbViewProvider.setActiveTable(selectedTable);
	}
}

export async function getDatabase(devDbViewProvider: DevDbViewProvider): Promise<DatabaseEngine | null> {
	let database: DatabaseEngine | null = await getConnectedDatabase()

	if (database) {
		return database;
	}

	const nonDefaultProviders = (await getAvailableProviders()).filter((provider) => !provider.isDefault);

	if (nonDefaultProviders.length !== 1) {
		vscode.window.showErrorMessage(`This project has ${nonDefaultProviders.length} available database providers and we do not know which one to use. Please connect to one first.`);
		vscode.commands.executeCommand('devdb.focus');
		return null;
	}

	/**
	 * This is just to ensure the UI is consistent with all the auto-connection
	 * magic we are doing here in the backend
	 */
	await autoConnectProvider(devDbViewProvider, nonDefaultProviders[0]);

	return await getConnectedDatabase()
}