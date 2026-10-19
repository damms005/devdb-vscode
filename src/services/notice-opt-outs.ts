import * as vscode from 'vscode';

/**
 * Launch window for the full-page notices (DevDb v4 and the DevWorkspace Pro
 * showcases). Before this local date they ignore "Don't show again" and the
 * fewer-notifications settings; from this date on they honor both.
 * Toasts always honor the settings.
 */
export const HONOR_FULL_PAGE_NOTICE_OPT_OUTS_FROM = '2026-12-25';

export function honorsFullPageNoticeOptOuts(now: Date = new Date()): boolean {
	const [year, month, day] = HONOR_FULL_PAGE_NOTICE_OPT_OUTS_FROM.split('-').map(Number);
	return now.getTime() >= new Date(year, month - 1, day).getTime();
}

export const PRO_NOTICES_SETTING = 'showProNotices';

/**
 * `Devdb.showProNotices`: when off, no DevDb Pro or DevWorkspace Pro notice shows,
 * full page or toast. Unlike the opt-outs above, it counts in the launch window too.
 */
export function userWantsProNotices(): boolean {
	return vscode.workspace.getConfiguration('Devdb').get<boolean>(PRO_NOTICES_SETTING, true);
}
