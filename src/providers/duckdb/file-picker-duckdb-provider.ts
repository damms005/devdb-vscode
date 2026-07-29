import * as vscode from 'vscode';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { DuckDbEngine } from '../../database-engines/duckdb-engine';

export const FilePickerDuckDbProvider: DatabaseEngineProvider = {
	name: 'DuckDB Database File Picker',
	type: 'duckdb',
	id: 'file-picker-duckdb',
	description: 'DuckDB database file from your computer',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		return true;
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace();
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		const filePath = await selectFile();
		if (!filePath) {
			vscode.window.showErrorMessage('No file selected.');
			return;
		}

		this.engine = new DuckDbEngine(filePath);

		let isOkay = false;
		try {
			isOkay = await this.engine.isOkay();
		} catch (error) {
			vscode.window.showErrorMessage(`Error opening ${filePath}: ${String(error)}`);
			return;
		}

		if (!isOkay) {
			vscode.window.showErrorMessage('The selected file is not a valid DuckDB database.');
			return;
		}

		return this.engine;
	},
};

async function selectFile(): Promise<string | undefined> {
	const fileUri = await vscode.window.showOpenDialog({
		canSelectMany: false,
		openLabel: 'Open DuckDB File',
		canSelectFolders: false,
		title: 'Select DuckDB File',
		filters: { 'DuckDB': ['duckdb', 'ddb', 'db'], 'All Files': ['*'] },
	});

	if (fileUri && fileUri[0]) {
		return fileUri[0].fsPath;
	}
}
