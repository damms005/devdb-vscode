import * as vscode from 'vscode'
import { getRandomString } from './random-string-generator'

export type EmbeddingProvider = 'openai' | 'ollama' | 'custom'

/**
 * `openai`  — any OpenAI-compatible `/v1/embeddings` endpoint (OpenAI, Azure, LM Studio, Together, …).
 * `ollama`  — a local Ollama `/api/embeddings` endpoint.
 * `custom`  — a user-supplied URL that speaks the OpenAI-compatible request/response shape.
 */
export interface EmbeddingConfigInput {
	id?: string
	label: string
	provider: EmbeddingProvider
	url: string
	model: string
	apiKey?: string
}

export interface EmbeddingConfigPublic {
	id: string
	label: string
	provider: EmbeddingProvider
	url: string
	model: string
	hasApiKey: boolean
}

interface EmbeddingConfigStored {
	id: string
	label: string
	provider: EmbeddingProvider
	url: string
	model: string
	hasApiKey: boolean
}

interface ResolvedEmbeddingConfig extends EmbeddingConfigStored {
	apiKey?: string
}

const STORAGE_KEY = 'embedding.configs'

/**
 * Stores embedding-endpoint configurations (in `globalState`) and their API keys
 * (in `SecretStorage`), and turns query text into a vector by calling the
 * configured endpoint. Keys are never returned to the webview.
 */
export class EmbeddingService {
	private context: vscode.ExtensionContext | null = null

	setExtensionContext(context: vscode.ExtensionContext): void {
		this.context = context
	}

	private getStored(): EmbeddingConfigStored[] {
		if (!this.context) {
			return []
		}

		return this.context.globalState.get<EmbeddingConfigStored[]>(STORAGE_KEY, [])
	}

	private secretKey(id: string): string {
		return `devdb.embedding.${id}.apiKey`
	}

	private toPublic(config: EmbeddingConfigStored): EmbeddingConfigPublic {
		return {
			id: config.id,
			label: config.label,
			provider: config.provider,
			url: config.url,
			model: config.model,
			hasApiKey: config.hasApiKey,
		}
	}

	getConfigs(): EmbeddingConfigPublic[] {
		return this.getStored().map(config => this.toPublic(config))
	}

	async saveConfig(input: EmbeddingConfigInput): Promise<EmbeddingConfigPublic[]> {
		if (!this.context) {
			throw new Error('Extension context not set')
		}

		const configs = this.getStored()
		const id = input.id ?? generateEmbeddingId()
		const existingIndex = configs.findIndex(config => config.id === id)
		const providedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined

		let hasApiKey = existingIndex >= 0 ? configs[existingIndex].hasApiKey : false
		if (providedKey !== undefined && providedKey.length > 0) {
			await this.context.secrets.store(this.secretKey(id), providedKey)
			hasApiKey = true
		}

		const stored: EmbeddingConfigStored = {
			id,
			label: input.label.trim(),
			provider: input.provider,
			url: input.url.trim(),
			model: input.model.trim(),
			hasApiKey,
		}

		if (existingIndex >= 0) {
			configs[existingIndex] = stored
		} else {
			configs.push(stored)
		}

		await this.context.globalState.update(STORAGE_KEY, configs)
		return this.getConfigs()
	}

	async deleteConfig(id: string): Promise<EmbeddingConfigPublic[]> {
		if (!this.context) {
			throw new Error('Extension context not set')
		}

		const configs = this.getStored().filter(config => config.id !== id)
		await this.context.globalState.update(STORAGE_KEY, configs)
		await this.context.secrets.delete(this.secretKey(id))
		return this.getConfigs()
	}

	private async resolve(id: string): Promise<ResolvedEmbeddingConfig | undefined> {
		const config = this.getStored().find(candidate => candidate.id === id)
		if (!config) {
			return undefined
		}

		const apiKey = config.hasApiKey && this.context ? await this.context.secrets.get(this.secretKey(id)) : undefined
		return { ...config, apiKey }
	}

	private async resolveInput(input: EmbeddingConfigInput): Promise<ResolvedEmbeddingConfig> {
		const providedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined
		let apiKey = providedKey && providedKey.length > 0 ? providedKey : undefined

		if (!apiKey && input.id && this.context) {
			const existing = this.getStored().find(candidate => candidate.id === input.id)
			if (existing?.hasApiKey) {
				apiKey = await this.context.secrets.get(this.secretKey(input.id))
			}
		}

		return {
			id: input.id ?? 'unsaved',
			label: input.label,
			provider: input.provider,
			url: input.url,
			model: input.model,
			hasApiKey: Boolean(apiKey),
			apiKey,
		}
	}

	/**
	 * Embeds `text` using the saved config `id`, throwing a clear error when the
	 * config is missing so the caller can surface it to the user.
	 */
	async embedWithConfigId(id: string, text: string): Promise<{ vector: number[], dimension: number, provider: EmbeddingProvider, model: string }> {
		const config = await this.resolve(id)
		if (!config) {
			throw new Error('Selected embedding endpoint no longer exists')
		}

		const { vector, dimension } = await embedText(config, text)
		return { vector, dimension, provider: config.provider, model: config.model }
	}

	/**
	 * Embeds a sample string to validate an endpoint, returning the resulting
	 * dimension or a readable error — used by the "Test" button in the UI.
	 */
	async testConfig(payload: { id?: string, config?: EmbeddingConfigInput, sampleText?: string }): Promise<{ ok: boolean, dimension?: number, error?: string }> {
		try {
			const resolved = payload.config
				? await this.resolveInput(payload.config)
				: payload.id
					? await this.resolve(payload.id)
					: undefined

			if (!resolved) {
				return { ok: false, error: 'No embedding configuration provided' }
			}

			const { dimension } = await embedText(resolved, payload.sampleText && payload.sampleText.length > 0 ? payload.sampleText : 'DevDb embedding connectivity test')
			return { ok: true, dimension }
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) }
		}
	}
}

/**
 * Calls the configured embedding endpoint and returns the resulting vector.
 * Uses the global `fetch` (Node 18+) so no dependency is required.
 */
async function embedText(config: ResolvedEmbeddingConfig, text: string): Promise<{ vector: number[], dimension: number }> {
	const vector = config.provider === 'ollama'
		? await embedViaOllama(config, text)
		: await embedViaOpenAiCompatible(config, text)

	if (!Array.isArray(vector) || vector.length === 0) {
		throw new Error('Embedding endpoint returned no vector')
	}

	return { vector, dimension: vector.length }
}

async function embedViaOpenAiCompatible(config: ResolvedEmbeddingConfig, text: string): Promise<number[]> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (config.apiKey) {
		headers['Authorization'] = `Bearer ${config.apiKey}`
	}

	const response = await fetch(config.url, {
		method: 'POST',
		headers,
		body: JSON.stringify({ input: text, model: config.model }),
	})

	if (!response.ok) {
		throw new Error(await describeHttpError(response))
	}

	const json = await response.json() as { data?: Array<{ embedding?: number[] }> }
	const embedding = json?.data?.[0]?.embedding
	if (!embedding) {
		throw new Error('Response did not contain data[0].embedding (is this an OpenAI-compatible embeddings endpoint?)')
	}

	return embedding
}

async function embedViaOllama(config: ResolvedEmbeddingConfig, text: string): Promise<number[]> {
	const response = await fetch(config.url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: config.model, prompt: text }),
	})

	if (!response.ok) {
		throw new Error(await describeHttpError(response))
	}

	const json = await response.json() as { embedding?: number[] }
	if (!json?.embedding) {
		throw new Error('Ollama response did not contain an "embedding" field')
	}

	return json.embedding
}

async function describeHttpError(response: Response): Promise<string> {
	let body = ''
	try {
		body = (await response.text()).slice(0, 300)
	} catch {
		body = ''
	}

	return `Embedding request failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`
}

function generateEmbeddingId(): string {
	return getRandomString('emb_', 12)
}

export const embeddingService = new EmbeddingService()
