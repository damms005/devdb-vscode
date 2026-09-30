import { getBasePath } from '../../services/workspace';
import { displayPath, findWranglerConfigFiles, readD1Bindings } from './wrangler-config';

export type D1Suggestion = {
	binding: string
	databaseName: string
	databaseId: string
	configFile: string
}

/**
 * D1 databases with a `database_id` in the workspace's wrangler config files, offered in the
 * remote Cloudflare D1 connection dialog.
 */
export function findD1Suggestions(root: string | undefined = getBasePath()): D1Suggestion[] {
	if (!root) return [];

	const suggestions: D1Suggestion[] = [];
	for (const configFile of findWranglerConfigFiles(root)) {
		try {
			for (const binding of readD1Bindings(configFile)) {
				if (!binding.databaseId) continue;
				suggestions.push({
					binding: binding.binding,
					databaseName: binding.databaseName ?? binding.binding,
					databaseId: binding.databaseId,
					configFile: displayPath(root, configFile),
				});
			}
		} catch {
			// unreadable config: skip it
		}
	}

	return suggestions;
}
