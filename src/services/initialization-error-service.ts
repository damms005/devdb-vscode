/**
 * When running tests, the vscode module is not available.
 * So we here to prevent "Cannot find module 'vscode'" error.
 * If needed, in tests, we can pass a handler to this function.
 */
export async function reportError(error: string) {
	const vscode = await import('vscode');
	vscode.window.showErrorMessage(`${String(error)}`)
}