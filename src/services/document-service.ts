import * as vscode from 'vscode';

/**
 * Gets the word under the cursor in the
 * current document
 */
export function getWordUnderCursor(): string | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) return;

	const document = editor.document;
	const cursorPosition = editor.selection.active;
	const wordRange = document.getWordRangeAtPosition(cursorPosition);

	return document.getText(wordRange)
}