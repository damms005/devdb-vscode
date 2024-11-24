import * as vscode from 'vscode';
import { getConfigFileContent, getConfigFilePath } from './config-service';
import { MssqlConfig, MysqlConfig, PostgresConfig, SqliteConfig } from '../types';

type ConfigType = SqliteConfig | MysqlConfig | PostgresConfig | MssqlConfig;

/**
 * Shows an error message with a button to open the config file.
 * When opened, it highlights the first relevant section of the config based on the error type.
 */
export async function showErrorWithConfigFileButton(errorMessage: string, config: ConfigType) {

	const configPath = getConfigFilePath();

	if (!configPath) {
		vscode.window.showErrorMessage(errorMessage);
		return;
	}

	vscode.window.showErrorMessage(errorMessage, 'Open Config File')
		.then(async selection => {
			if (selection !== 'Open Config File') return;

			const document = await vscode.workspace.openTextDocument(configPath);
			const editor = await vscode.window.showTextDocument(document);
			const configText = document.getText();

			// Find the position of the problematic config using unique identifiers
			let startIndex = -1;
			let endIndex = -1;

			// Find all occurrences of the config type
			const typeRegex = new RegExp(`"type"\\s*:\\s*"${config.type}"`, 'g');
			let match;

			while ((match = typeRegex.exec(configText)) !== null) {
				// For each match, find the enclosing object's bounds
				const objStartIndex = findObjectStart(configText, match.index);
				const objEndIndex = findObjectEnd(configText, match.index);

				if (objStartIndex === -1 || objEndIndex === -1) continue;

				const objText = configText.substring(objStartIndex, objEndIndex + 1);

				// Check if this object matches our config based on unique identifiers
				const isMatch = matchesConfig(objText, config);
				if (isMatch) {
					startIndex = objStartIndex;
					endIndex = objEndIndex + 1;
					break;
				}
			}

			if (startIndex === -1 || endIndex === -1) return;

			// Create a selection for the matching config
			const startPos = document.positionAt(startIndex);
			const endPos = document.positionAt(endIndex);
			editor.selection = new vscode.Selection(startPos, endPos);
			editor.revealRange(new vscode.Range(startPos, endPos));
		});
}

/**
 * Find the start of the JSON object containing the given position
 */
function findObjectStart(text: string, position: number): number {
	let depth = 0;
	let index = position;

	while (index >= 0) {
		const char = text[index];
		if (char === '}') depth++;
		if (char === '{') {
			depth--;
			if (depth < 0) return index;
		}
		index--;
	}

	return -1;
}

/**
 * Find the end of the JSON object containing the given position
 */
function findObjectEnd(text: string, position: number): number {
	let depth = 0;
	let index = position;

	while (index < text.length) {
		const char = text[index];
		if (char === '{') depth++;
		if (char === '}') {
			depth--;
			if (depth < 0) return index;
		}
		index++;
	}

	return -1;
}

/**
 * Check if a JSON object string matches the given config based on unique identifiers
 */
function matchesConfig(objText: string, config: ConfigType): boolean {
	try {
		const obj = JSON.parse(objText);

		switch (config.type) {
			case 'sqlite':
				return obj.path === (config as SqliteConfig).path;

			case 'mysql':
			case 'mariadb':
				return obj.name === (config as MysqlConfig).name &&
					obj.database === (config as MysqlConfig).database;

			case 'postgres':
				return obj.name === (config as PostgresConfig).name &&
					obj.database === (config as PostgresConfig).database;

			case 'mssql':
				return obj.name === (config as MssqlConfig).name &&
					obj.database === (config as MssqlConfig).database;

			default:
				return false;
		}
	} catch {
		return false;
	}
}
