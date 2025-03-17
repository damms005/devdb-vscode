/**
 * When running tests, the vscode module is not available.
 * So we here to prevent "Cannot find module 'vscode'" error.
 */
export async function reportError(error: string) {
	const vscode = await require('vscode');
	vscode.window.showErrorMessage(`${String(error)}`)
}