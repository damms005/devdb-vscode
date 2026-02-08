import * as vscode from 'vscode';
import axios from 'axios';
import { machineId } from 'node-machine-id';

interface LicenseInfo {
	token: string;
	expires_at: string;
	machine_id: string;
	status: string;
}

const STORAGE_KEY = 'devdb-pro-license';

export class LicenseManager {
	private static readonly API_BASE = process.env.DEVDB_LICENSE_API_BASE as string;
	private cachedMachineId: string | null = null;

	constructor(private secrets: vscode.SecretStorage) {
	}

	private async getMachineId(): Promise<string> {
		if (!this.cachedMachineId) {
			this.cachedMachineId = await machineId();
		}
		return this.cachedMachineId as string;
	}

	private isValidLicense(licenseInfo: LicenseInfo): boolean {
		return licenseInfo.status === 'granted' && new Date(licenseInfo.expires_at) > new Date();
	}

	async promptForLicense(): Promise<string | undefined> {
		const token = await vscode.window.showInputBox({
			prompt: 'Enter your DevDb Pro license key',
			placeHolder: 'DEVDB-...',
			ignoreFocusOut: true,
			validateInput: (value: string) => {
				if (!value || value.trim().length === 0) {
					return 'License key cannot be empty';
				}
				if (!value.startsWith('DEVDBM-') && !value.startsWith('DEVDBY-')) {
					return 'License key must start with DEVDBM- or DEVDBY-';
				}
				return undefined;
			}
		});

		return token?.trim();
	}

	async activateLicense(token: string): Promise<{ success: boolean; message: string }> {
		try {
			const currentMachineId = await this.getMachineId();

			const response = await axios.post(
				`${LicenseManager.API_BASE}/activate`,
				{
					license: token,
					machine_id: currentMachineId
				},
				{
					timeout: 10000
				}
			);

			if (response.status === 200 && response.data.status === 'granted') {
				const expiresAt = response.data.expires_at;

				if (!expiresAt) {
					return {
						success: false,
						message: 'Invalid response from server: missing expires_at'
					};
				}

				const expiryDate = new Date(expiresAt);
				if (isNaN(expiryDate.getTime())) {
					return {
						success: false,
						message: 'Invalid expiration date from server'
					};
				}

				if (expiryDate <= new Date()) {
					return {
						success: false,
						message: 'License has already expired'
					};
				}

				await this.storeLicense({
					token,
					expires_at: expiresAt,
					machine_id: currentMachineId,
					status: response.data.status
				});

				return {
					success: true,
					message: response.data.message || 'License activated successfully'
				};
			} else {
				return {
					success: false,
					message: response.data.message || 'Failed to activate license'
				};
			}
		} catch (error) {
			if (axios.isAxiosError(error)) {
				if (error.response?.data?.message) {
					return {
						success: false,
						message: error.response.data.message
					};
				}
			}

			return {
				success: false,
				message: `Failed to activate license: ${error instanceof Error ? error.message : 'Unknown error'}`
			};
		}
	}

	private async storeLicense(licenseInfo: LicenseInfo): Promise<void> {
		await this.secrets.store(STORAGE_KEY, JSON.stringify(licenseInfo));
	}

	async getStoredLicense(): Promise<LicenseInfo | null> {
		try {
			const data = await this.secrets.get(STORAGE_KEY);
			if (!data) return null;
			return JSON.parse(data) as LicenseInfo;
		} catch (error) {
			return null;
		}
	}

	async removeLicense(): Promise<void> {
		await this.secrets.delete(STORAGE_KEY);
	}

	async checkLicenseStatus(): Promise<{ hasLicense: boolean; isValid: boolean; message: string }> {
		const storedLicense = await this.getStoredLicense();

		if (!storedLicense) {
			return {
				hasLicense: false,
				isValid: false,
				message: 'No license found'
			};
		}

		const currentMachineId = await this.getMachineId();

		if (storedLicense.machine_id !== currentMachineId) {
			await this.removeLicense();
			return {
				hasLicense: false,
				isValid: false,
				message: 'No license found'
			};
		}

		if (new Date() <= new Date(storedLicense.expires_at)) {
			return {
				hasLicense: true,
				isValid: this.isValidLicense(storedLicense),
				message: 'License is valid'
			};
		}

		try {
			const response = await axios.post(
				`${LicenseManager.API_BASE}/status`,
				{
					license: storedLicense.token
				},
				{
					timeout: 10000
				}
			);

			if (response.status === 200) {
				const isValid = response.data.is_valid && response.data.status === 'granted';

				if (isValid && response.data.expires_at) {
					await this.storeLicense({
						token: storedLicense.token,
						expires_at: response.data.expires_at,
						machine_id: currentMachineId,
						status: response.data.status
					});
				} else {
					await this.removeLicense();
				}

				return {
					hasLicense: true,
					isValid,
					message: isValid ? 'License is valid' : 'License is not valid'
				};
			} else {
				const serverMessage = response.data?.message || `Server returned status ${response.status}`;
				return {
					hasLicense: true,
					isValid: false,
					message: `License validation failed: ${serverMessage}`
				};
			}
		} catch (error) {
			let errorDetail: string;
			if (axios.isAxiosError(error)) {
				errorDetail = error.response?.data?.message || error.message;
			} else {
				errorDetail = error instanceof Error ? error.message : 'Unknown error';
			}
			return {
				hasLicense: true,
				isValid: false,
				message: `License validation failed: ${errorDetail}`
			};
		}
	}
}
