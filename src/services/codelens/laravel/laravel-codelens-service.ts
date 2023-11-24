import * as vscode from 'vscode';
import * as pluralize from 'pluralize'
import { getWorkspaceTables } from '../../messenger';
import * as stringcase from 'stringcase';

type ModelMap = {
	[model: string]: {
		filePath: string,
		table: string
	}
}

export const LaravelCodelensService = {

	/**
	 * Returns a CodeLens for the Eloquent model class definition in the
	 * given document. The CodeLens provides opening the table in DevDB.
	 */
	async getForEloquentModelIn(document: vscode.TextDocument): Promise<vscode.CodeLens | undefined> {
		const isNotPhpFile = document.languageId !== 'php'
		const isNotAppModelsNamespace = document.fileName.indexOf('app/Models') === -1
		if (isNotPhpFile || isNotAppModelsNamespace) {
			return Promise.resolve(undefined);
		}

		const tables = getWorkspaceTables()

		if (tables.length === 0) {
			return Promise.resolve(undefined);
		}

		return getTableModelMapForCurrentWorkspace()
			.then((tableModelMap: ModelMap) => {
				const text = document.getText();
				const filePath = document.fileName;

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
						const command: vscode.Command = {
							title: "View table",
							tooltip: `Open ${entry.table} table`,
							command: "devdb.codelens.open-laravel-model-table",
							arguments: [entry.table]
						};

						return Promise.resolve(new vscode.CodeLens(range, command))
					}
				}
			})
	}
}


/**
 * It uses heuristics based on Laravel conventions to get Laravel
 * models in current workspace and their tables.
 * Returns an object: {table => model}
 */
async function getTableModelMapForCurrentWorkspace(): Promise<ModelMap> {
	const modelFiles = await vscode.workspace.findFiles('app/Models/*.php', null, 1000);
	const modelTableMap: ModelMap = {};

	modelFiles.forEach(file => {
		const fileName = file.fsPath.split('/').pop();
		if (!fileName) return;

		const modelName = fileName.replace('.php', '');
		const modelSnakeCase = stringcase.snakecase(modelName)
		const table = pluralize(modelSnakeCase);

		modelTableMap[modelName] = {
			filePath: file.fsPath,
			table
		};
	});

	return modelTableMap
}


