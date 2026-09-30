import * as assert from 'assert';
import { EmbeddingService, validateEndpointUrl } from '../../../services/embedding-service';

/**
 * A minimal in-memory ExtensionContext stand-in exposing just the `globalState`
 * and `secrets` surface the EmbeddingService touches.
 */
function makeFakeContext() {
	const store = new Map<string, any>();
	const secretStore = new Map<string, string>();
	return {
		globalState: {
			get: (key: string, fallback: any) => (store.has(key) ? store.get(key) : fallback),
			update: async (key: string, value: any) => { store.set(key, value); },
		},
		secrets: {
			get: async (key: string) => secretStore.get(key),
			store: async (key: string, value: string) => { secretStore.set(key, value); },
			delete: async (key: string) => { secretStore.delete(key); },
		},
	} as any;
}

describe('EmbeddingService', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('sends an OpenAI-compatible request and parses data[0].embedding', async () => {
		let captured: { url: string, body: any, auth?: string } | undefined;
		globalThis.fetch = (async (url: any, init: any) => {
			captured = { url, body: JSON.parse(init.body), auth: init.headers['Authorization'] };
			return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) } as any;
		}) as any;

		const service = new EmbeddingService();
		service.setExtensionContext(makeFakeContext());
		const result = await service.testConfig({
			config: { label: 'openai', provider: 'openai', url: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small', apiKey: 'sk-test' },
			sampleText: 'hello',
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.dimension, 3);
		assert.strictEqual(captured?.url, 'https://api.openai.com/v1/embeddings');
		assert.strictEqual(captured?.body.input, 'hello');
		assert.strictEqual(captured?.body.model, 'text-embedding-3-small');
		assert.strictEqual(captured?.auth, 'Bearer sk-test');
	});

	it('sends an Ollama request with prompt and parses embedding', async () => {
		let capturedBody: any;
		globalThis.fetch = (async (_url: any, init: any) => {
			capturedBody = JSON.parse(init.body);
			return { ok: true, json: async () => ({ embedding: [1, 2, 3, 4] }) } as any;
		}) as any;

		const service = new EmbeddingService();
		service.setExtensionContext(makeFakeContext());
		const result = await service.testConfig({
			config: { label: 'local', provider: 'ollama', url: 'http://localhost:11434/api/embeddings', model: 'nomic-embed-text' },
			sampleText: 'world',
		});

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.dimension, 4);
		assert.strictEqual(capturedBody.prompt, 'world');
		assert.strictEqual(capturedBody.model, 'nomic-embed-text');
	});

	it('reports a readable error on a non-200 response', async () => {
		globalThis.fetch = (async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key' })) as any;

		const service = new EmbeddingService();
		service.setExtensionContext(makeFakeContext());
		const result = await service.testConfig({
			config: { label: 'openai', provider: 'openai', url: 'https://api.openai.com/v1/embeddings', model: 'm' },
		});

		assert.strictEqual(result.ok, false);
		assert.ok(result.error?.includes('401'), `expected status in error, got ${result.error}`);
	});

	it('reports an error when the response has no embedding field', async () => {
		globalThis.fetch = (async () => ({ ok: true, json: async () => ({ data: [] }) })) as any;

		const service = new EmbeddingService();
		service.setExtensionContext(makeFakeContext());
		const result = await service.testConfig({
			config: { label: 'openai', provider: 'openai', url: 'https://api.openai.com/v1/embeddings', model: 'm' },
		});

		assert.strictEqual(result.ok, false);
		assert.ok(result.error && result.error.length > 0);
	});

	it('saves, lists (without exposing keys), and deletes configs', async () => {
		const service = new EmbeddingService();
		service.setExtensionContext(makeFakeContext());

		const afterSave = await service.saveConfig({ label: 'openai', provider: 'openai', url: 'https://api.openai.com/v1/embeddings', model: 'm', apiKey: 'sk-secret' });
		assert.strictEqual(afterSave.length, 1);
		assert.strictEqual(afterSave[0].hasApiKey, true);
		assert.strictEqual((afterSave[0] as any).apiKey, undefined, 'public config must not expose the key');

		const afterDelete = await service.deleteConfig(afterSave[0].id);
		assert.strictEqual(afterDelete.length, 0);
	});

	describe('API key origin binding', () => {
		const base = { label: 'openai', provider: 'openai' as const, model: 'm' };

		it('sends the stored key only to the origin it was saved for', async () => {
			const auths: Array<string | undefined> = [];
			globalThis.fetch = (async (_url: any, init: any) => {
				auths.push(init.headers['Authorization']);
				return { ok: true, json: async () => ({ data: [{ embedding: [1] }] }) } as any;
			}) as any;

			const service = new EmbeddingService();
			service.setExtensionContext(makeFakeContext());
			const [saved] = await service.saveConfig({ ...base, url: 'https://api.openai.com/v1/embeddings', apiKey: 'sk-secret' });

			const sameOrigin = await service.testConfig({ config: { ...base, id: saved.id, url: 'https://api.openai.com/v2/embeddings' } });
			assert.strictEqual(sameOrigin.ok, true);
			assert.deepStrictEqual(auths, ['Bearer sk-secret']);

			const otherOrigin = await service.testConfig({ config: { ...base, id: saved.id, url: 'https://evil.example.com/v1/embeddings' } });
			assert.strictEqual(otherOrigin.ok, false);
			assert.match(otherOrigin.error ?? '', /Re-enter the API key/);
			assert.strictEqual(auths.length, 1, 'no request may go to the other origin with the stored key');

			const otherPort = await service.testConfig({ config: { ...base, id: saved.id, url: 'https://api.openai.com:8443/v1/embeddings' } });
			assert.strictEqual(otherPort.ok, false);
		});

		it('drops the stored key when the config is saved with a different origin and no new key', async () => {
			const context = makeFakeContext();
			const service = new EmbeddingService();
			service.setExtensionContext(context);
			const [saved] = await service.saveConfig({ ...base, url: 'https://api.openai.com/v1/embeddings', apiKey: 'sk-secret' });

			const [moved] = await service.saveConfig({ ...base, id: saved.id, url: 'https://other.example.com/v1/embeddings' });
			assert.strictEqual(moved.hasApiKey, false);
			assert.strictEqual(await context.secrets.get(`devdb.embedding.${saved.id}.apiKey`), undefined);

			const [rekeyed] = await service.saveConfig({ ...base, id: saved.id, url: 'https://other.example.com/v1/embeddings', apiKey: 'sk-new' });
			assert.strictEqual(rekeyed.hasApiKey, true);
		});

		it('keeps the stored key when the URL path changes on the same origin', async () => {
			const service = new EmbeddingService();
			service.setExtensionContext(makeFakeContext());
			const [saved] = await service.saveConfig({ ...base, url: 'https://api.openai.com/v1/embeddings', apiKey: 'sk-secret' });
			const [updated] = await service.saveConfig({ ...base, id: saved.id, url: 'https://api.openai.com/v1/other' });
			assert.strictEqual(updated.hasApiKey, true);
		});
	});

	describe('endpoint URL rules', () => {
		it('requires https for non-loopback hosts', async () => {
			const service = new EmbeddingService();
			service.setExtensionContext(makeFakeContext());

			await assert.rejects(
				service.saveConfig({ label: 'x', provider: 'openai', url: 'http://api.example.com/v1/embeddings', model: 'm', apiKey: 'k' }),
				/must use https/,
			);

			globalThis.fetch = (async () => { throw new Error('fetch must not be called'); }) as any;
			const result = await service.testConfig({ config: { label: 'x', provider: 'openai', url: 'http://10.0.0.5/v1/embeddings', model: 'm' } });
			assert.strictEqual(result.ok, false);
			assert.match(result.error ?? '', /must use https/);
		});

		it('allows http for loopback hosts', () => {
			for (const url of ['http://localhost:11434/api/embeddings', 'http://127.0.0.1:11434/api/embeddings', 'http://[::1]:11434/api/embeddings']) {
				assert.doesNotThrow(() => validateEndpointUrl(url), url);
			}
			assert.throws(() => validateEndpointUrl('ftp://localhost/x'), /Unsupported/);
			assert.throws(() => validateEndpointUrl('not a url'), /Invalid/);
		});

		it('reports a clear error on timeout', async () => {
			let signal: AbortSignal | undefined;
			globalThis.fetch = (async (_url: any, init: any) => {
				signal = init.signal;
				const error = new Error('The operation was aborted due to timeout');
				error.name = 'TimeoutError';
				throw error;
			}) as any;

			const service = new EmbeddingService();
			service.setExtensionContext(makeFakeContext());
			const result = await service.testConfig({ config: { label: 'x', provider: 'ollama', url: 'http://localhost:11434/api/embeddings', model: 'm' } });

			assert.ok(signal instanceof AbortSignal, 'fetch must receive an abort signal');
			assert.strictEqual(result.ok, false);
			assert.match(result.error ?? '', /timed out after 30 s/);
		});
	});
});
