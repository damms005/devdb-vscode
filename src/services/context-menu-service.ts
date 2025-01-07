import * as vscode from 'vscode';
import { ModelMap } from '../types';
import { getTableModelMapForCurrentWorkspace } from './codelens/laravel/laravel-codelens-service';
import { getWordUnderCursor } from './document-service';
import { LaravelFactoryGenerator } from './laravel/factory-generator';
import { database } from './messenger';
import { showMissingDatabaseNotification } from './error-notification-service';

export async function generateLaravelFactoryFromCursorWord() {
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