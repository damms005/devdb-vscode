/**
 * Minimal `vscode` module for mocha tests that import extension services outside VS Code.
 * Import this file before any module that imports `vscode`.
 */
import Module = require('module')

export const shownMessages: string[] = []

const record = async (message: string) => {
	shownMessages.push(message)
	return undefined
}

const vscodeStub = {
	window: {
		showErrorMessage: record,
		showWarningMessage: record,
		showInformationMessage: record,
		showInputBox: async () => undefined,
		createOutputChannel: () => ({ appendLine: () => undefined, append: () => undefined, show: () => undefined, dispose: () => undefined }),
	},
	workspace: {
		getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
		workspaceFolders: undefined,
	},
	commands: { executeCommand: async () => undefined },
	Uri: { file: (path: string) => ({ fsPath: path, path }) },
}

const moduleWithLoad = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }
const originalLoad = moduleWithLoad._load

moduleWithLoad._load = function (request: string, ...rest: unknown[]) {
	if (request !== 'vscode') return originalLoad.call(this, request, ...rest)

	try {
		return originalLoad.call(this, request, ...rest)
	} catch {
		return vscodeStub
	}
}

type Memento = { get<T>(key: string, fallback?: T): T | undefined, update(key: string, value: unknown): Promise<void> }
type Secrets = { get(key: string): Promise<string | undefined>, store(key: string, value: string): Promise<void>, delete(key: string): Promise<void> }

/**
 * In-memory stand-in for the parts of `vscode.ExtensionContext` the services use.
 */
export function createFakeExtensionContext(): { context: any, globalState: Map<string, unknown>, secrets: Map<string, string> } {
	const globalState = new Map<string, unknown>()
	const secrets = new Map<string, string>()

	const memento: Memento = {
		get: <T>(key: string, fallback?: T) => (globalState.has(key) ? JSON.parse(JSON.stringify(globalState.get(key))) : fallback) as T,
		update: async (key: string, value: unknown) => { globalState.set(key, JSON.parse(JSON.stringify(value))) },
	}

	const secretStorage: Secrets = {
		get: async (key: string) => secrets.get(key),
		store: async (key: string, value: string) => { secrets.set(key, value) },
		delete: async (key: string) => { secrets.delete(key) },
	}

	return { context: { globalState: memento, secrets: secretStorage }, globalState, secrets }
}
