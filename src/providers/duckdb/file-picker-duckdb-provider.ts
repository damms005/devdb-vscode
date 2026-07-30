import * as vscode from 'vscode';
import { basename, extname } from 'path';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { DuckDbEngine } from '../../database-engines/duckdb-engine';

const DATA_FILE_EXTENSIONS = ['.parquet', '.csv', '.tsv', '.json', '.ndjson'];

export const FilePickerDuckDbProvider: DatabaseEngineProvider = {
	name: 'DuckDB Database File Picker',
	type: 'duckdb',
	id: 'file-picker-duckdb',
	description: 'DuckDB database, or a Parquet/CSV/JSON data file from your computer',
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

		const engine = await buildEngineForFile(filePath);
		if (!engine) {
			return;
		}

		this.engine = engine;

		let isOkay = false;
		try {
			isOkay = await this.engine.isOkay();
		} catch (error) {
			vscode.window.showErrorMessage(`Error opening ${filePath}: ${String(error)}`);
			return;
		}

		if (!isOkay) {
			vscode.window.showErrorMessage('The selected file could not be opened as a DuckDB database or data file.');
			return;
		}

		return this.engine;
	},
};

/**
 * A data file (Parquet/CSV/JSON) is opened in an in-memory DuckDB and exposed as
 * a VIEW so it browses as a table. A DuckDB database file is opened directly,
 * read-only by default (so it never takes an exclusive lock on the user's file),
 * with an explicit opt-in to open it read-write.
 */
async function buildEngineForFile(filePath: string): Promise<DuckDbEngine | undefined> {
	const extension = extname(filePath).toLowerCase();

	if (DATA_FILE_EXTENSIONS.includes(extension)) {
		const viewName = deriveViewName(filePath, extension);
		return new DuckDbEngine(':memory:', { dataFile: { path: filePath, viewName } });
	}

	const readOnly = await pickReadOnlyMode();
	if (readOnly === undefined) {
		return;
	}

	return new DuckDbEngine(filePath, { readOnly });
}

/**
 * Sanitizes a filename into a safe DuckDB view identifier (letters, digits and
 * underscores; never leading with a digit).
 */
function deriveViewName(filePath: string, extension: string): string {
	const raw = basename(filePath, extension);
	const sanitized = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
	return sanitized.length > 0 ? sanitized : 'data';
}

async function pickReadOnlyMode(): Promise<boolean | undefined> {
	const readOnly = { label: 'Open read-only (recommended)', description: 'Never locks the file; other DuckDB processes keep access', value: true };
	const readWrite = { label: 'Open read-write', description: 'Takes an exclusive write lock; blocks other DuckDB processes', value: false };

	const choice = await vscode.window.showQuickPick([readOnly, readWrite], {
		title: 'How should this DuckDB database be opened?',
		placeHolder: 'Read-only is safest and lets you keep browsing while other tools use the file',
	});

	return choice?.value;
}

async function selectFile(): Promise<string | undefined> {
	const fileUri = await vscode.window.showOpenDialog({
		canSelectMany: false,
		openLabel: 'Open DuckDB or Data File',
		canSelectFolders: false,
		title: 'Select DuckDB Database or Data File',
		filters: {
			'DuckDB & Data Files': ['duckdb', 'ddb', 'db', 'parquet', 'csv', 'tsv', 'json', 'ndjson'],
			'DuckDB Database': ['duckdb', 'ddb', 'db'],
			'Data Files': ['parquet', 'csv', 'tsv', 'json', 'ndjson'],
			'All Files': ['*'],
		},
	});

	if (fileUri && fileUri[0]) {
		return fileUri[0].fsPath;
	}
}
