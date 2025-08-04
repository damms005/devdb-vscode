import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

export interface DdevInfo {
	isInstalled: boolean;
	version?: string;
	installPath?: string;
	error?: string;
}

/**
 * Comprehensive DDEV detection service that checks for DDEV installation
 * using multiple methods to ensure reliability across different environments
 */
export class DdevDetectionService {
	private static instance: DdevDetectionService;
	private cachedInfo: DdevInfo | null = null;
	private cacheExpiry: number = 0;
	private readonly CACHE_DURATION = 5 * 60 * 1000;

	public static getInstance(): DdevDetectionService {
		if (!DdevDetectionService.instance) {
			DdevDetectionService.instance = new DdevDetectionService();
		}
		return DdevDetectionService.instance;
	}

	/**
	 * Detects DDEV installation with caching for performance
	 */
	async detectDdev(): Promise<DdevInfo> {
		if (this.cachedInfo && Date.now() < this.cacheExpiry) {
			return this.cachedInfo;
		}

		const info = await this.performDdevDetection();

		this.cachedInfo = info;
		this.cacheExpiry = Date.now() + this.CACHE_DURATION;

		return info;
	}

	/**
	 * Forces a fresh detection, bypassing cache
	 */
	async forceDetectDdev(): Promise<DdevInfo> {
		this.cachedInfo = null;
		this.cacheExpiry = 0;
		return this.detectDdev();
	}

	private async performDdevDetection(): Promise<DdevInfo> {
		try {
			const versionResult = await this.checkDdevVersion();
			if (versionResult.isInstalled) {
				return versionResult;
			}

			const pathResult = await this.checkCommonPaths();
			if (pathResult.isInstalled) {
				return pathResult;
			}
			const pathEnvResult = await this.checkPathEnvironment();
			if (pathEnvResult.isInstalled) {
				return pathEnvResult;
			}

			return {
				isInstalled: false,
				error: 'DDEV not found in system'
			};

		} catch (error) {
			return {
				isInstalled: false,
				error: `DDEV detection failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	/**
	 * Check DDEV version by executing ddev --version command
	 */
	private async checkDdevVersion(): Promise<DdevInfo> {
		try {
			const { stdout, stderr } = await execAsync('ddev --version', {
				timeout: 10000,
				env: { ...process.env }
			});

			if (stderr && !stdout) {
				throw new Error(stderr);
			}

			const version = this.parseVersionFromOutput(stdout);

			return {
				isInstalled: true,
				version: version,
				installPath: await this.findDdevExecutablePath()
			};

		} catch (error) {
			return {
				isInstalled: false,
				error: `Version check failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	/**
	 * Check common DDEV installation paths based on OS
	 */
	private async checkCommonPaths(): Promise<DdevInfo> {
		const platform = os.platform();
		let commonPaths: string[] = [];

		switch (platform) {
			case 'win32':
				commonPaths = [
					'C:\\Program Files\\ddev\\ddev.exe',
					'C:\\Program Files (x86)\\ddev\\ddev.exe',
					path.join(os.homedir(), 'AppData', 'Local', 'ddev', 'ddev.exe'),
					path.join(os.homedir(), 'AppData', 'Roaming', 'ddev', 'ddev.exe')
				];
				break;
			case 'darwin':
				commonPaths = [
					'/usr/local/bin/ddev',
					'/opt/homebrew/bin/ddev',
					'/usr/bin/ddev',
					path.join(os.homedir(), '.local', 'bin', 'ddev'),
					path.join(os.homedir(), 'bin', 'ddev')
				];
				break;
			case 'linux':
				commonPaths = [
					'/usr/local/bin/ddev',
					'/usr/bin/ddev',
					'/bin/ddev',
					path.join(os.homedir(), '.local', 'bin', 'ddev'),
					path.join(os.homedir(), 'bin', 'ddev'),
					'/snap/bin/ddev'
				];
				break;
		}

		for (const ddevPath of commonPaths) {
			try {
				if (fs.existsSync(ddevPath)) {
					const stats = fs.statSync(ddevPath);
					if (stats.isFile()) {
						const version = await this.getVersionFromPath(ddevPath);
						return {
							isInstalled: true,
							version: version,
							installPath: ddevPath
						};
					}
				}
			} catch (error) {
				continue;
			}
		}

		return {
			isInstalled: false,
			error: 'DDEV not found in common installation paths'
		};
	}

	/**
	 * Check if ddev is available in PATH environment variable
	 */
	private async checkPathEnvironment(): Promise<DdevInfo> {
		try {
			const pathEnv = process.env.PATH || '';
			const pathSeparator = os.platform() === 'win32' ? ';' : ':';
			const executableName = os.platform() === 'win32' ? 'ddev.exe' : 'ddev';

			const paths = pathEnv.split(pathSeparator);

			for (const dir of paths) {
				const fullPath = path.join(dir, executableName);
				try {
					if (fs.existsSync(fullPath)) {
						const version = await this.getVersionFromPath(fullPath);
						return {
							isInstalled: true,
							version: version,
							installPath: fullPath
						};
					}
				} catch (error) {
					continue;
				}
			}

			return {
				isInstalled: false,
				error: 'DDEV not found in PATH environment'
			};

		} catch (error) {
			return {
				isInstalled: false,
				error: `PATH check failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	/**
	 * Get DDEV version from a specific executable path
	 */
	private async getVersionFromPath(executablePath: string): Promise<string | undefined> {
		try {
			const { stdout } = await execAsync(`"${executablePath}" --version`, {
				timeout: 10000
			});
			return this.parseVersionFromOutput(stdout);
		} catch (error) {
			return undefined;
		}
	}

	/**
	 * Find the executable path of DDEV
	 */
	private async findDdevExecutablePath(): Promise<string | undefined> {
		try {
			const command = os.platform() === 'win32' ? 'where ddev' : 'which ddev';
			const { stdout } = await execAsync(command, { timeout: 5000 });
			return stdout.trim().split('\n')[0];
		} catch (error) {
			return undefined;
		}
	}

	/**
	 * Parse version number from DDEV version output
	 */
	private parseVersionFromOutput(output: string): string | undefined {
		try {
			const match = output.match(/ddev version v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)/i);
			return match ? match[1] : undefined;
		} catch (error) {
			return undefined;
		}
	}

	/**
	 * Clear the cache (useful for testing or forcing refresh)
	 */
	clearCache(): void {
		this.cachedInfo = null;
		this.cacheExpiry = 0;
	}
}

/**
 * Convenience function for quick DDEV detection
 */
export async function isDdevInstalled(): Promise<boolean> {
	const service = DdevDetectionService.getInstance();
	const info = await service.detectDdev();
	return info.isInstalled;
}

/**
 * Get detailed DDEV information
 */
export async function getDdevInfo(): Promise<DdevInfo> {
	const service = DdevDetectionService.getInstance();
	return service.detectDdev();
}