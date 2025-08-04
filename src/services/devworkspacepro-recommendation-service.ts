import * as vscode from 'vscode';
import { DdevDetectionService } from './ddev-detection-service';
import { DevWorkspaceProDetectionService } from './devworkspacepro-detection-service';

const RECOMMENDATION_SHOWN_KEY = 'devworkspacepro.recommendation.shown';
const RECOMMENDATION_DISMISSED_KEY = 'devworkspacepro.recommendation.dismissed';
const LAST_CHECK_KEY = 'devworkspacepro.recommendation.lastCheck';

export class DevWorkspaceProRecommendationService {
	private static instance: DevWorkspaceProRecommendationService;
	private readonly CHECK_INTERVAL = 24 * 60 * 60 * 1000;

	public static getInstance(): DevWorkspaceProRecommendationService {
		if (!DevWorkspaceProRecommendationService.instance) {
			DevWorkspaceProRecommendationService.instance = new DevWorkspaceProRecommendationService();
		}
		return DevWorkspaceProRecommendationService.instance;
	}

	async checkAndRecommend(context: vscode.ExtensionContext): Promise<void> {
		try {
			const isDismissed = context.globalState.get<boolean>(RECOMMENDATION_DISMISSED_KEY, false);
			if (isDismissed) {
				return;
			}

			const lastCheck = context.globalState.get<number>(LAST_CHECK_KEY, 0);
			const now = Date.now();
			if (now - lastCheck < this.CHECK_INTERVAL) {
				return;
			}

			await context.globalState.update(LAST_CHECK_KEY, now);

			const shouldRecommend = await this.shouldRecommendDevWorkspacePro();

			if (shouldRecommend) {
				await this.showRecommendation(context);
			}

		} catch (error) {
			console.error('DevWorkspace Pro recommendation check failed:', error);
		}
	}

	private async shouldRecommendDevWorkspacePro(): Promise<boolean> {
		try {
			const ddevService = DdevDetectionService.getInstance();
			const ddevInfo = await ddevService.detectDdev();

			if (!ddevInfo.isInstalled) {
				return false;
			}

			const devWorkspaceProService = DevWorkspaceProDetectionService.getInstance();
			const devWorkspaceProInfo = await devWorkspaceProService.detectDevWorkspacePro();

			return !devWorkspaceProInfo.isInstalled;

		} catch (error) {
			console.error('Error determining DevWorkspace Pro recommendation:', error);
			return false;
		}
	}

	private async showRecommendation(context: vscode.ExtensionContext): Promise<void> {
		const message = 'Get the Best GUI for DDEV! DevWorkspace Pro streamlines your DDEV workflow with an intuitive interface.';

		const actions = [
			'Get DevWorkspace Pro (25% off)',
			'Maybe Later',
			'Don\'t Show Again'
		];

		const selection = await vscode.window.showInformationMessage(message, ...actions);

		switch (selection) {
			case 'Get DevWorkspace Pro (25% off)':
				await this.openPurchasePageWithDiscount();
				await context.globalState.update(RECOMMENDATION_SHOWN_KEY, Date.now());
				break;

			case 'Maybe Later':
				const threeDaysFromNow = Date.now() + (3 * 24 * 60 * 60 * 1000);
				await context.globalState.update(LAST_CHECK_KEY, Date.now());
				await context.globalState.update('devworkspacepro.recommendation.nextCheck', threeDaysFromNow);
				break;

			case 'Don\'t Show Again':
				await context.globalState.update(RECOMMENDATION_DISMISSED_KEY, true);
				vscode.window.showInformationMessage(
					'DevWorkspace Pro recommendations disabled. You can still visit https://devworkspacepro.com anytime.'
				);
				break;
		}
	}

	private async openPurchasePageWithDiscount(): Promise<void> {
		const purchaseUrl = 'https://devworkspacepro.com';
		await vscode.env.openExternal(vscode.Uri.parse(purchaseUrl));

		const discountMessage = 'Use discount code GIFTFORDEVDBUSERS25 for 25% off your DevWorkspace Pro license!';
		const copyAction = 'Copy Code';

		const selection = await vscode.window.showInformationMessage(discountMessage, copyAction);

		if (selection === copyAction) {
			await vscode.env.clipboard.writeText('GIFTFORDEVDBUSERS25');
			vscode.window.showInformationMessage('Discount code copied to clipboard!');
		}
	}

	async resetRecommendationSettings(context: vscode.ExtensionContext): Promise<void> {
		await context.globalState.update(RECOMMENDATION_SHOWN_KEY, undefined);
		await context.globalState.update(RECOMMENDATION_DISMISSED_KEY, undefined);
		await context.globalState.update(LAST_CHECK_KEY, undefined);
		await context.globalState.update('devworkspacepro.recommendation.nextCheck', undefined);
	}
}

export async function initializeDevWorkspaceProRecommendations(context: vscode.ExtensionContext): Promise<void> {
	const service = DevWorkspaceProRecommendationService.getInstance();

	setTimeout(async () => {
		await service.checkAndRecommend(context);
	}, 5000);
}