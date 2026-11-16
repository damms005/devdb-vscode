import * as vscode from 'vscode';

export const PRO_NOTICES_SETTING = 'showProNotices';

/**
 * `Devdb.showProNotices`: when off, no DevDb Pro or DevWorkspace Pro notice shows,
 * full page or toast. It is the only setting that stops the full pages: they ignore
 * "Don't show again" and the fewer-notifications settings.
 */
export function userWantsProNotices(): boolean {
	return vscode.workspace.getConfiguration('Devdb').get<boolean>(PRO_NOTICES_SETTING, true);
}
