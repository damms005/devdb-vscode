import axios from 'axios';

const API_BASE = process.env.DEVDB_LICENSE_API_BASE as string;

export async function createGiftLink(payload: { message: string; hint: string }): Promise<{ url: string } | { error: string }> {
	try {
		const giftUrl = API_BASE.replace(/\/license$/, '/gift');

		const response = await axios.post(
			giftUrl,
			{
				message: payload.message,
				hint: payload.hint,
			},
			{ timeout: 10000 }
		);

		return { url: response.data.url };
	} catch (error) {
		if (axios.isAxiosError(error)) {
			return { error: error.response?.data?.message || error.message };
		}
		return { error: 'Failed to create gift link' };
	}
}
