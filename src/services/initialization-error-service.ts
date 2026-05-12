/**
 * When running tests, the vscode module is not available.
 * So we here to prevent "Cannot find module 'vscode'" error.
 */
export async function reportError(error: string | Error | unknown) {
	const vscode = await require('vscode');
	let message: string
	if (error instanceof AggregateError) {
		message = error.errors.map((e: any) => String(e?.message ?? e)).join('; ')
	} else if (error instanceof Error) {
		message = error.message
	} else {
		message = String(error)
	}
	vscode.window.showErrorMessage(message)
}