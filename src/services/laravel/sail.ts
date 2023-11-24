import { join } from "path";
import { fileExists, getFirstWorkspacePath, getWorkspaceFileContent } from "../workspace";
import { getEnvFileValue } from "./laravel-core";
import { parse } from 'yaml'
import { Sequelize } from "sequelize";
import { connectToMysql } from "../mysql";

export async function isLaravelSailWorkspace() {
	const workspacePath = getFirstWorkspacePath()
	if (!workspacePath) return false

	const dockerComposeFilePath = join(workspacePath, 'docker-compose.yml');

	const exists = await fileExists(dockerComposeFilePath)

	return exists
}

export async function getMysqlConnection(): Promise<Sequelize | undefined> {
	const username = await getEnvFileValue('DB_USERNAME') || ''
	const password = await getEnvFileValue('DB_PASSWORD') || ''
	const database = await getEnvFileValue('DB_DATABASE')
	let port = await getPort()
	if (!database || !port) return

	const localhostConnection = await connectToMysqlUsingLocalhost(port, username, password, database)
	if (localhostConnection) return localhostConnection

	try {
		return await connectUsingConfiguredHost(port, username, password, database)
	} catch (error) {
		return
	}
}

export async function connectToMysqlUsingLocalhost(port: number, username: string, password: string, database: string): Promise<Sequelize | undefined> {
	return await connectToMysql('127.0.0.1', port, username, password, database)
}

async function connectUsingConfiguredHost(port: number, username: string, password: string, database: string): Promise<Sequelize | undefined> {
	const host = await getEnvFileValue('DB_HOST')
	if (!host) return

	return await connectToMysql(host, port, username, password, database)
}

async function getPort(): Promise<number | undefined> {
	if (!(await isLaravelSailWorkspace())) {
		return parseInt(await getEnvFileValue('DB_PORT') || '3306')
	}

	const dockerComposeContent = (getWorkspaceFileContent('docker-compose.yml'))?.toString()
	if (!dockerComposeContent) return

	const dockerComposeParsed = parse(dockerComposeContent)

	const portDefinition: string = dockerComposeParsed.services?.mysql?.ports[0].toString()
	if (!portDefinition) return

	// Match string like '${FORWARD_DB_PORT:-3307}:3306' where FORWARD_DB_PORT and 3307 are captured
	const match = portDefinition.match(/\${(\w+):-(\d+)}:\d+/)
	if (!match) return

	const [, envVariable, defaultPort,] = match
	const port: string = await getEnvFileValue(envVariable) || defaultPort

	return parseInt(port)
}