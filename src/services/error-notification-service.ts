import * as vscode from 'vscode';

export function showMissingDatabaseError() {
	vscode.window.showErrorMessage('No database connection found. Please select a database in DevDb and try again.', 'Connect').then(selection => {
		if (selection === 'Connect') {
			vscode.commands.executeCommand('devdb.focus');
		}
	});
}

export function showEmptyTablesNotification() {
	vscode.window.showErrorMessage('Tables not loaded yet. Please ensure to connect to a database in DevDb and try again.', 'Connect').then(selection => {
		if (selection === 'Connect') {
			vscode.commands.executeCommand('devdb.focus');
		}
	});
}