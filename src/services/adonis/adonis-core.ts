import * as path from 'path';
import * as fs from 'fs';
import { log } from '../../services/logging-service';
import { getBasePath, getWorkspaceFileContent } from "../workspace";

/**
 * Returns the hostname portion of the APP_URL environment variable.
 */
export async function getHostname(): Promise<string | undefined> {
	const appUrl = await getEnvFileValue('APP_URL')
	if (!appUrl) return

	const appUrlWithoutQuotes = appUrl.replace(/"/g, '')
	const appUrlWithoutTrailingSlash = appUrlWithoutQuotes.endsWith('/')
		? appUrlWithoutQuotes.substring(0, appUrlWithoutQuotes.length - 1)
		: appUrlWithoutQuotes

	const appUrlWithoutProtocol = appUrlWithoutTrailingSlash.replace(/https?:\/\//, '')
	const appUrlWithoutPort = appUrlWithoutProtocol.replace(/:\d+/, '')

	return appUrlWithoutPort
}

export async function getEnvFileValue(envFileKey: string): Promise<string | undefined> {
	const envFileContents = getWorkspaceFileContent('.env')?.toString()
	if (!envFileContents) return

	const lines = envFileContents.split('\n');
	const appUrlLine = lines.find(line => line.startsWith(`${envFileKey}=`))
	if (!appUrlLine) return

	const appUrl = appUrlLine.substring(appUrlLine.indexOf('=') + 1)
	const appUrlWithoutQuotes = appUrl.replace(/"/g, '')
	const appUrlWithoutTrailingSlash = appUrlWithoutQuotes.endsWith('/')
		? appUrlWithoutQuotes.substring(0, appUrlWithoutQuotes.length - 1)
		: appUrlWithoutQuotes

	const appUrlWithoutProtocol = appUrlWithoutTrailingSlash.replace(/https?:\/\//, '')
	const appUrlWithoutPort = appUrlWithoutProtocol.replace(/:\d+/, '')

	return appUrlWithoutPort.trim()
}

export function isAdonisProject() {
	const workspaceRoot = getBasePath();
	if (!workspaceRoot) {
		log('Adonis PostgreSQL', 'No workspace root found');
		return false;
	}

	// Check if this is an Adonis project by looking for config/database.ts or config/database.js
	const databaseTsPath = path.join(workspaceRoot, 'config', 'database.ts');
	const databaseJsPath = path.join(workspaceRoot, 'config', 'database.js');

	if (!fs.existsSync(databaseTsPath) && !fs.existsSync(databaseJsPath)) {
		log('Adonis PostgreSQL', 'No Adonis database config file found');
		return false;
	}

	// Check package.json for Adonis dependencies
	const packageJsonPath = path.join(workspaceRoot, 'package.json');
	if (!fs.existsSync(packageJsonPath)) {
		log('Adonis PostgreSQL', 'No package.json found');
		return false;
	}

	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
	const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

	const hasAdonisDependency = Object.keys(dependencies).some(dep =>
		dep === '@adonisjs/core' || dep === '@adonisjs/lucid' || dep.startsWith('@adonisjs/')
	);

	if (!hasAdonisDependency) {
		log('Adonis PostgreSQL', 'No Adonis dependencies found in package.json');
		return false;
	}

	return true
}