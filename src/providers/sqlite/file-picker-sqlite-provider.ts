import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from "../../types";
import { addSqlDatabaseToConfig } from '../../services/config-service';
import { SqliteEngine } from '../../database-engines/sqlite-engine';

export const FilePickerSqliteProvider: DatabaseEngineProvider = {
	name: 'SQLite Database File Picker',
	type: 'sqlite',
	id: 'file-picker-sqlite',
	description: 'SQLite database file from your computer',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		return true;
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace()
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		const filePath = await selectFile();
		if (!filePath) {
			vscode.window.showErrorMessage('No file selected.')
			return
		}

		this.engine = new SqliteEngine(filePath);

		let isOkay = false;
		try {
			isOkay = (await this.engine.isOkay())
		} catch (error) {
			vscode.window.showErrorMessage(`Error opening ${filePath}: ${String(error)}`)
			return
		}

		if (!isOkay) {
			vscode.window.showErrorMessage('The selected file is not a valid SQLite database.')
			return
		}

		await addSqlDatabaseToConfig(filePath)

		return this.engine
	}
}

async function selectFile(): Promise<string | undefined> {
	const fileUri = await vscode.window.showOpenDialog({
		canSelectMany: false,
		openLabel: 'Open SQLite File',
		canSelectFolders: false,
		title: 'Select SQLite File',
		filters: { 'SQLite': ['sqlite', 'db'], 'All Files': ['*'] }
	})

	if (fileUri && fileUri[0]) {
		return fileUri[0].fsPath;
	}
}