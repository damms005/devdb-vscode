import { getWorkspaceFileContent } from "../workspace";

/**
 * Returns the hostname portion of the APP_URL environment variable.
 */
export async function getHostname(): Promise<string|undefined> {
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

	return appUrlWithoutPort
}