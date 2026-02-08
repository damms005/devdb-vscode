import * as vscode from 'vscode';
import { LicenseManager } from './license-manager';

export class LicenseService {
	private licenseManager: LicenseManager;
	private isLicenseValid: boolean = false;

	constructor(secrets: vscode.SecretStorage) {
		this.licenseManager = new LicenseManager(secrets);
	}

	async initialize(): Promise<void> {
		const status = await this.licenseManager.checkLicenseStatus();
		this.isLicenseValid = status.isValid;

		if (!status.hasLicense) {
		} else if (!status.isValid) {
			vscode.window.showWarningMessage(
				`DevDb Pro license issue: ${status.message}`,
				'Enter New License',
				'Ignore'
			).then(selection => {
				if (selection === 'Enter New License') {
					this.showLicensePrompt();
				}
			});
		}
	}

	async showLicensePrompt(): Promise<void> {
		const token = await this.licenseManager.promptForLicense();

		if (!token) {
			vscode.window.showWarningMessage('DevDb Pro requires a valid license to function');
			return;
		}

		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Validating license...',
			cancellable: false
		}, async () => {
			const result = await this.licenseManager.activateLicense(token);

			if (result.success) {
				this.isLicenseValid = true;
				vscode.window.showInformationMessage(result.message);
			} else {
				vscode.window.showErrorMessage(result.message);
			}
		});
	}

	async manageLicense(): Promise<void> {
		const status = await this.licenseManager.checkLicenseStatus();

		if (!status.hasLicense) {
			await this.showLicensePrompt();
			return;
		}

		const action = await vscode.window.showQuickPick([
			{
				label: '$(key) Enter New License',
				description: 'Replace current license with a new one',
				action: 'new'
			},
			{
				label: '$(info) Check License Status',
				description: 'Verify current license validity',
				action: 'check'
			},
			{
				label: '$(trash) Remove License',
				description: 'Remove stored license from this device',
				action: 'remove'
			}
		], {
			placeHolder: 'Select license management action'
		});

		if (!action) return;

		switch (action.action) {
			case 'new':
				await this.showLicensePrompt();
				break;
			case 'check':
				await this.checkLicenseStatus();
				break;
			case 'remove':
				await this.removeLicense();
				break;
		}
	}

	private async checkLicenseStatus(): Promise<void> {
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Checking license status...',
			cancellable: false
		}, async () => {
			const status = await this.licenseManager.checkLicenseStatus();

			if (status.isValid) {
				vscode.window.showInformationMessage('✅ License is valid and active');
			} else {
				vscode.window.showWarningMessage(`❌ License issue: ${status.message}`);
			}
		});
	}

	private async removeLicense(): Promise<void> {
		const confirm = await vscode.window.showWarningMessage(
			'Are you sure you want to remove the license from this device?',
			'Yes',
			'No'
		);

		if (confirm === 'Yes') {
			await this.licenseManager.removeLicense();
			this.isLicenseValid = false;
			vscode.window.showInformationMessage('License removed successfully');
		}
	}

	isValid(): boolean {
		return this.isLicenseValid;
	}

}