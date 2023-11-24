import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';

export function getFirstWorkspacePath(): string | undefined {
	const workspaceFolders = vscode.workspace.workspaceFolders;

	if (!workspaceFolders) return undefined

	return workspaceFolders[0].uri.fsPath;
}

/**
 * Returns the path to the workspace file.
 */
export function getPathToWorkspaceFile(...subPath: string[]): string | undefined {
	const firstWorkspacePath = getFirstWorkspacePath()
	if (!firstWorkspacePath) return undefined

	return join(firstWorkspacePath, ...subPath);
}

export function getWorkspaceFileContent(...subPath: string[]): Buffer | undefined {
	const filePath = getPathToWorkspaceFile(...subPath)
	if (!filePath) return undefined

	if (!existsSync(filePath)) return undefined

	return readFileSync(filePath);
}

export async function fileExists(path: string): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(vscode.Uri.file(path))
		return true
	} catch (error) {
		return false
	}
}