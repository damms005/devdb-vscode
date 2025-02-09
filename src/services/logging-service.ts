import * as vscode from 'vscode';

export function log(message: string, ...rest: any[]) {
	const config = vscode.workspace.getConfiguration('Devdb');
	const showDebugInfo = config.get<boolean>('showDebugInfo', false);

	if (showDebugInfo) {
		console.log(message, ...rest);
	}
}
