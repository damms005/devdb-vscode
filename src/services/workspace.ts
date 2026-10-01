import path from 'path';
import fs from 'fs';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as vscode from 'vscode';

export function getBasePath(): string | undefined {

	const customBasePath = vscode.workspace.getConfiguration('Devdb').get<string>('customBasePath');

	if (customBasePath && customBasePath.trim() !== '' && fs.existsSync(customBasePath)) {
		return customBasePath;
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;

	if (!workspaceFolders || !workspaceFolders.length) return undefined

	return workspaceFolders[0].uri.fsPath;
}

/**
 * Returns the path to the workspace file.
 */
export function getPathToWorkspaceFile(...subPath: string[]): string | undefined {
	const firstWorkspacePath = getBasePath()
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

export function isDdevProject(): boolean {
	const workspaceRoot = getBasePath();
	if (!workspaceRoot) {
		return false;
	}

	return fs.existsSync(path.join(workspaceRoot, '.ddev'));
}

/**
 * True when the workspace root is a PHP project (composer.json or artisan) without DDEV.
 */
export function isPhpProjectWithoutDdev(): boolean {
	const workspaceRoot = getBasePath();
	if (!workspaceRoot || fs.existsSync(path.join(workspaceRoot, '.ddev'))) {
		return false;
	}

	return ['composer.json', 'artisan'].some(file => fs.existsSync(path.join(workspaceRoot, file)));
}

/** Files that mark a code project in the workspace root (besides PHP). */
export const CODE_PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Gemfile', 'Cargo.toml'];

/**
 * True when the workspace root is a code project (a Git repository, or Node, Python,
 * Go, Ruby or Rust) that is not PHP and has no DDEV.
 */
export function isNonPhpProjectWithoutDdev(): boolean {
	const workspaceRoot = getBasePath();
	if (!workspaceRoot || fs.existsSync(path.join(workspaceRoot, '.ddev'))) {
		return false;
	}

	if (['composer.json', 'artisan'].some(file => fs.existsSync(path.join(workspaceRoot, file)))) {
		return false;
	}

	return CODE_PROJECT_MARKERS.some(file => fs.existsSync(path.join(workspaceRoot, file)));
}

export function isComposerPhpProject(): boolean {
	// simply check if workspace root contains a .ddev directory
	const workspaceRoot = getBasePath();
	if (!workspaceRoot) {
		return false;
	}

	return fs.existsSync(path.join(workspaceRoot, 'composer.json'));
}