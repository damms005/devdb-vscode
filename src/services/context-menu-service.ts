import * as vscode from 'vscode';
import { ModelMap } from '../types';
import { getTableModelMapForCurrentWorkspace } from './codelens/laravel/laravel-codelens-service';
import { getWordUnderCursor } from './document-service';
import { LaravelFactoryGenerator } from './laravel/factory-generator';
import { database } from './messenger';
import { showMissingDatabaseNotification } from './error-notification-service';
import { explainSelectedQuery } from './codelens/laravel/sql-query-explainer-provider';

export async function contextMenuLaravelFactoryGenerator() {
	if (!database) {
		return showMissingDatabaseNotification()
	}

	const wordUnderCursor = getWordUnderCursor()
	if (!wordUnderCursor) {
		return vscode.window.showErrorMessage('No word under cursor');
	}

	const tableModelMap: ModelMap = await getTableModelMapForCurrentWorkspace()
	const model = tableModelMap[wordUnderCursor];

	if (!model) {
		return vscode.window.showErrorMessage(`No model found by name ${wordUnderCursor}`);
	}

	const generator = new LaravelFactoryGenerator(database);
	await generator.generateFactory(wordUnderCursor, model.filePath);
}

export async function contextMenuQueryExplainer() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	const document = editor.document;
	if (!document) return;

	const selection = editor.selection;

	explainSelectedQuery(document, selection)
}