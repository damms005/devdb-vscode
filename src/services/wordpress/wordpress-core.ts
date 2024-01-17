import { fileExists, getWorkspaceFileContent } from "../workspace";

export async function getConfigFileValue(envFileKey: string): Promise<string | undefined> {
	const filename = (await fileExists('wp-config-local.php')) ? 'wp-config-local.php' : 'wp-config.php'

	const envFileContents = getWorkspaceFileContent(filename)?.toString()
	if (!envFileContents) return

	const lines = envFileContents.split('\n');
	const configLine = lines.find(line => line.includes(`${envFileKey}=`))
	if (!configLine) return

	const regex = new RegExp(envFileKey + '[\'", ]+(.+)[\'"]', 'g')
	const value = configLine.match(regex)?.[0]

	return value
}
