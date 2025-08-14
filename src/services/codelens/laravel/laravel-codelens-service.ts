import * as vscode from 'vscode';
import pluralize from 'pluralize';
import Case from 'case';
import { getWorkspaceTables } from '../../messenger';
import { ModelMap } from '../../../types';

export const LaravelCodelensService = {

	/**
	 * Returns a CodeLens for the Eloquent model class definition in the
	 * given document. The CodeLens provides opening the table in DevDb.
	 */
	async getCodelensFor(document: vscode.TextDocument): Promise<vscode.CodeLens[] | undefined> {
		const isNotPhpFile = document.languageId !== 'php'
		const isNotAppModelsNamespace = document.fileName.indexOf('app/Models') === -1
		if (isNotPhpFile || isNotAppModelsNamespace) {
			return Promise.resolve(undefined);
		}

		const text = document.getText();
		const tables = getWorkspaceTables()

		if (tables.length === 0) {

			const command: vscode.Command = {
				/**
				 * We use "DevDB" in the string so user knows where the Codelens
				 * is coming from, and we use "Eloquent" in the string to help
				 * use in debugging, especially indicating that this Codelens
				 * only shows up in Laravel Eloquent models.
				 */
				title: `Click to create DevDb database connection for Eloquent actions`,
				tooltip: `DevDb Eloquent Codelens actions require database connection`,
				command: 'devdb.focus',
			};

			const classNameDefinitionRegex = new RegExp(`class\\s+\\b[aA-zZ_]+\\b`);
			let matches = classNameDefinitionRegex.exec(text)
			if (!matches) {
				return Promise.resolve(undefined);
			}

			const line = document.lineAt(document.positionAt(matches.index).line);
			const indexOf = line.text.indexOf(matches[0]);
			const position = new vscode.Position(line.lineNumber, indexOf);
			const range = document.getWordRangeAtPosition(position, new RegExp(classNameDefinitionRegex));
			if (range) {
				return Promise.resolve([new vscode.CodeLens(range, command)])
			}
		}

		const tableModelMap: ModelMap = await getTableModelMapForCurrentWorkspace()
		const filePath = document.fileName;
		const codelenses: vscode.CodeLens[] = [];

		for (const [model, entry] of Object.entries(tableModelMap)) {
			if (filePath !== entry.filePath) continue;

			const classNameDefinitionRegex = new RegExp(`class\\s+\\b${model}\\b`);
			let matches = classNameDefinitionRegex.exec(text)
			if (!matches) {
				return Promise.resolve(undefined);
			}

			const line = document.lineAt(document.positionAt(matches.index).line);
			const indexOf = line.text.indexOf(matches[0]);
			const position = new vscode.Position(line.lineNumber, indexOf);
			const range = document.getWordRangeAtPosition(position, new RegExp(classNameDefinitionRegex));

			if (range) {
				// Add table view codelens
				const viewTableCommand: vscode.Command = {
					title: "View table",
					tooltip: `Open ${entry.table} table`,
					command: "devdb.codelens.open-laravel-model-table",
					arguments: [entry.table]
				};
				codelenses.push(new vscode.CodeLens(range, viewTableCommand));

				// Add factory generation codelens
				const generateFactoryCommand: vscode.Command = {
					title: "Generate Factory",
					tooltip: `Generate factory for ${model}`,
					command: "devdb.laravel.generate-factory",
					arguments: [model, filePath]
				};
				codelenses.push(new vscode.CodeLens(range, generateFactoryCommand));
			}
		}

		return codelenses;
	}
}

/**
 * It uses heuristics based on Laravel conventions to get Laravel
 * models in current workspace and their tables.
 * Returns an object: {table => model}
 *
 * TODO: Make getting model map more efficient. We do not need to
 * get it every time if stuff does not change. Basically, we should
 * listen for changes to files in app/Models and update the map.
 */
export async function getTableModelMapForCurrentWorkspace(): Promise<ModelMap> {
	const modelFiles = await vscode.workspace.findFiles('app/Models/*.php', null, 1000);
	const modelTableMap: ModelMap = {};

	for (const file of modelFiles) {
		const fileName = file.fsPath.split('/').pop();
		if (!fileName) continue;

		const modelName = fileName.replace('.php', '');
		const table = await getTable(file.fsPath, modelName)

		modelTableMap[modelName] = {
			filePath: file.fsPath,
			table
		};
	}

	return modelTableMap
}


/**
 * Determines the name of the database table associated with a given Laravel model file.
 *
 * It first attempts to extract the table name from an explicitly defined `$table` property in the model file.
 * If the `$table` property is not present, it falls back to Laravel's naming convention by
 * converting the model name to snake_case and pluralizing it.
 *
 * This function assumes the file content represents a Laravel Eloquent model.
 *
 * @param fsPath - Absolute file system path to the PHP model file.
 * @param modelName - The name of the model class, used for fallback inference.
 * @returns The database table name associated with the model.
 */
export async function getTable(fsPath: string, modelName: string): Promise<string> {
	const fileContent = (await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath))).toString()
	const tablePropertyDefinition = /protected\s+\$table\s*=\s*['"](.+?)['"]/
	const matches = fileContent.match(tablePropertyDefinition)

	if (matches) {
		return matches[1]
	}

	const modelSnakeCase = Case.snake(modelName)

	return pluralize(modelSnakeCase);
}
