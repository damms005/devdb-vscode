import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DevWorkspaceProInfo {
	isInstalled: boolean;
	installPath?: string;
	version?: string;
	error?: string;
}

export class DevWorkspaceProDetectionService {
	private static instance: DevWorkspaceProDetectionService;
	private cachedInfo: DevWorkspaceProInfo | null = null;
	private cacheExpiry: number = 0;
	private readonly CACHE_DURATION = 10 * 60 * 1000;

	public static getInstance(): DevWorkspaceProDetectionService {
		if (!DevWorkspaceProDetectionService.instance) {
			DevWorkspaceProDetectionService.instance = new DevWorkspaceProDetectionService();
		}
		return DevWorkspaceProDetectionService.instance;
	}

	async detectDevWorkspacePro(): Promise<DevWorkspaceProInfo> {
		if (this.cachedInfo && Date.now() < this.cacheExpiry) {
			return this.cachedInfo;
		}

		const info = await this.performDetection();

		this.cachedInfo = info;
		this.cacheExpiry = Date.now() + this.CACHE_DURATION;

		return info;
	}

	async forceDetectDevWorkspacePro(): Promise<DevWorkspaceProInfo> {
		this.cachedInfo = null;
		this.cacheExpiry = 0;
		return this.detectDevWorkspacePro();
	}

	private async performDetection(): Promise<DevWorkspaceProInfo> {
		try {
			const platform = os.platform();

			switch (platform) {
				case 'win32':
					return this.detectWindows();
				case 'darwin':
					return this.detectMacOS();
				case 'linux':
					return this.detectLinux();
				default:
					return {
						isInstalled: false,
						error: `Unsupported platform: ${platform}`
					};
			}
		} catch (error) {
			return {
				isInstalled: false,
				error: `Detection failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	private async detectWindows(): Promise<DevWorkspaceProInfo> {
		const possiblePaths = [
			path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DevWorkspace Pro', 'DevWorkspace Pro.exe'),
			path.join(os.homedir(), 'AppData', 'Local', 'devworkspacepro', 'DevWorkspace Pro.exe'),

			path.join(os.homedir(), 'AppData', 'Roaming', 'DevWorkspace Pro', 'DevWorkspace Pro.exe'),
			'C:\\Program Files\\DevWorkspace Pro\\DevWorkspace Pro.exe',
			'C:\\Program Files (x86)\\DevWorkspace Pro\\DevWorkspace Pro.exe',

			path.join(os.homedir(), 'Desktop', 'DevWorkspace Pro', 'DevWorkspace Pro.exe'),
			path.join(os.homedir(), 'Downloads', 'DevWorkspace Pro', 'DevWorkspace Pro.exe')
		];

		for (const installPath of possiblePaths) {
			try {
				if (fs.existsSync(installPath)) {
					const stats = fs.statSync(installPath);
					if (stats.isFile()) {
						const version = this.extractVersionFromPath(installPath);
						return {
							isInstalled: true,
							installPath: installPath,
							version: version
						};
					}
				}
			} catch (error) {
				continue;
			}
		}

		return {
			isInstalled: false,
			error: 'DevWorkspace Pro not found in Windows installation directories'
		};
	}

	private async detectMacOS(): Promise<DevWorkspaceProInfo> {
		const possiblePaths = [
			'/Applications/DevWorkspace Pro.app',

			path.join(os.homedir(), 'Applications', 'DevWorkspace Pro.app'),

			path.join(os.homedir(), 'Desktop', 'DevWorkspace Pro.app'),
			path.join(os.homedir(), 'Downloads', 'DevWorkspace Pro.app')
		];

		for (const installPath of possiblePaths) {
			try {
				if (fs.existsSync(installPath)) {
					const stats = fs.statSync(installPath);
					if (stats.isDirectory()) {
						const executablePath = path.join(installPath, 'Contents', 'MacOS', 'DevWorkspace Pro');
						if (fs.existsSync(executablePath)) {
							const version = this.extractVersionFromMacApp(installPath);
							return {
								isInstalled: true,
								installPath: installPath,
								version: version
							};
						}
					}
				}
			} catch (error) {
				continue;
			}
		}

		return {
			isInstalled: false,
			error: 'DevWorkspace Pro not found in macOS application directories'
		};
	}

	private async detectLinux(): Promise<DevWorkspaceProInfo> {
		const possiblePaths = [
			path.join(os.homedir(), 'Applications', 'DevWorkspace Pro-Linux-1.0.0-Setup.AppImage'),
			path.join(os.homedir(), 'Downloads', 'DevWorkspace Pro-Linux-1.0.0-Setup.AppImage'),
			path.join(os.homedir(), 'Desktop', 'DevWorkspace Pro-Linux-1.0.0-Setup.AppImage'),
			path.join(os.homedir(), '.local', 'bin', 'devworkspacepro'),

			'/usr/bin/devworkspacepro',
			'/usr/local/bin/devworkspacepro',
			'/opt/devworkspacepro/devworkspacepro',

			'/snap/bin/devworkspacepro',

			path.join(os.homedir(), '.local', 'share', 'flatpak', 'app', 'com.devworkspacepro.app'),
			'/var/lib/flatpak/app/com.devworkspacepro.app'
		];

		const appImagePatterns = [
			path.join(os.homedir(), 'Applications', 'DevWorkspace*Pro*.AppImage'),
			path.join(os.homedir(), 'Downloads', 'DevWorkspace*Pro*.AppImage'),
			path.join(os.homedir(), 'Desktop', 'DevWorkspace*Pro*.AppImage')
		];

		for (const installPath of possiblePaths) {
			try {
				if (fs.existsSync(installPath)) {
					const stats = fs.statSync(installPath);
					if (stats.isFile() || stats.isDirectory()) {
						const version = this.extractVersionFromPath(installPath);
						return {
							isInstalled: true,
							installPath: installPath,
							version: version
						};
					}
				}
			} catch (error) {
				continue;
			}
		}

		for (const pattern of appImagePatterns) {
			try {
				const directory = path.dirname(pattern);
				if (fs.existsSync(directory)) {
					const files = fs.readdirSync(directory);
					const appImageFiles = files.filter(file =>
						file.toLowerCase().includes('devworkspace') &&
						file.toLowerCase().includes('pro') &&
						file.toLowerCase().endsWith('.appimage')
					);

					if (appImageFiles.length > 0) {
						const fullPath = path.join(directory, appImageFiles[0]);
						const version = this.extractVersionFromPath(fullPath);
						return {
							isInstalled: true,
							installPath: fullPath,
							version: version
						};
					}
				}
			} catch (error) {
				continue;
			}
		}

		return {
			isInstalled: false,
			error: 'DevWorkspace Pro not found in Linux installation directories'
		};
	}

	private extractVersionFromPath(filePath: string): string | undefined {
		try {
			const filename = path.basename(filePath);
			const versionMatch = filename.match(/(\d+\.\d+\.\d+)/);
			return versionMatch ? versionMatch[1] : undefined;
		} catch (error) {
			return undefined;
		}
	}

	private extractVersionFromMacApp(appPath: string): string | undefined {
		try {
			const plistPath = path.join(appPath, 'Contents', 'Info.plist');
			if (fs.existsSync(plistPath)) {
				const plistContent = fs.readFileSync(plistPath, 'utf8');
				const versionMatch = plistContent.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
				return versionMatch ? versionMatch[1] : undefined;
			}
		} catch (error) {
			return undefined;
		}
		return undefined;
	}

	clearCache(): void {
		this.cachedInfo = null;
		this.cacheExpiry = 0;
	}
}

export async function isDevWorkspaceProInstalled(): Promise<boolean> {
	const service = DevWorkspaceProDetectionService.getInstance();
	const info = await service.detectDevWorkspacePro();
	return info.isInstalled;
}

export async function getDevWorkspaceProInfo(): Promise<DevWorkspaceProInfo> {
	const service = DevWorkspaceProDetectionService.getInstance();
	return service.detectDevWorkspacePro();
}