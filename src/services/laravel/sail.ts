import { join } from "path";
import { parse } from 'yaml'
import { fileExists, getFirstWorkspacePath, getWorkspaceFileContent } from "../workspace";
import { getEnvFileValue } from "./laravel-core";
import { KnexClientType } from "../../types";

export async function hasLaravelSailDockerComposeFile() {
	const workspacePath = getFirstWorkspacePath()
	if (!workspacePath) return false

	const dockerComposeFilePath = join(workspacePath, 'docker-compose.yml');

	const exists = await fileExists(dockerComposeFilePath)

	return exists
}

export async function getPortFromDockerCompose(dialect: KnexClientType): Promise<number | undefined> {
	const dockerComposeContent = (getWorkspaceFileContent('docker-compose.yml'))?.toString()
	if (!dockerComposeContent) return

	const dockerComposeParsed = parse(dockerComposeContent)

	const portDefinition: string = dockerComposeParsed.services?.[dialect]?.ports[0].toString()
	if (!portDefinition) return

	// Match string like '${FORWARD_DB_PORT:-3307}:3306' where FORWARD_DB_PORT and 3307 are captured
	const match = portDefinition.match(/\${(\w+):-(\d+)}:\d+/)
	if (!match) return

	const [, envVariable, defaultPort,] = match
	const port: string = await getEnvFileValue(envVariable) || defaultPort

	return parseInt(port)
}