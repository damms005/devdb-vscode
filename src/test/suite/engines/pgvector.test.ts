import * as assert from 'assert';
import knexlib from "knex";
import { StartedPostgreSqlContainer, PostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresEngine } from '../../../database-engines/postgres-engine';

/**
 * pgvector-enabled Postgres image. As with the sibling postgres suite, we pin a
 * predefined image so it can be pre-pulled (`docker pull pgvector/pgvector:pg16`)
 * to avoid slow first-run downloads.
 */
const dockerImage = 'pgvector/pgvector:pg16'

describe('pgvector Tests', () => {
	let container: StartedPostgreSqlContainer;
	let engine: PostgresEngine;

	before(async function () {
		container = await new PostgreSqlContainer(dockerImage)
			.withName('devdb-test-container-pgvector')
			.withReuse()
			.start();

		const connection = knexlib({
			client: 'postgres',
			connection: {
				host: container.getHost(),
				port: container.getPort(),
				user: container.getUsername(),
				password: container.getPassword(),
				database: container.getDatabase(),
			},
			// Pin to a single connection so a session-level `SET enable_seqscan`
			// in the scan-detection test persists across the engine's own queries.
			pool: { min: 1, max: 1 },
		})

		engine = new PostgresEngine(connection);
		const ok = await engine.isOkay();
		assert.strictEqual(ok, true);

		await engine.connection?.raw(`CREATE EXTENSION IF NOT EXISTS vector`);
	})

	beforeEach(async function () {
		await engine.connection?.raw(`DROP TABLE IF EXISTS embeddings`);
		await engine.connection?.raw(`
			CREATE TABLE embeddings (
				id SERIAL PRIMARY KEY,
				label varchar(255),
				embedding vector(3)
			)
		`);

		await engine.connection?.raw(`
			INSERT INTO embeddings (label, embedding) VALUES
			('a', '[1, 0, 0]'),
			('b', '[0.9, 0.1, 0]'),
			('c', '[0, 1, 0]'),
			('d', '[0, 0, 1]')
		`);
	});

	afterEach(async function () {
		await engine.connection?.raw(`DROP TABLE IF EXISTS embeddings`);
	})

	after(async function () {
		await engine.connection?.destroy();
	});

	it('detects a pgvector column and captures its dimension', async () => {
		const columns = await engine.getColumns('embeddings');

		const vectorColumn = columns.find(column => column.name === 'embedding');

		assert.ok(vectorColumn, 'expected an embedding column');
		assert.strictEqual(vectorColumn?.type, 'vector(3)');
		assert.strictEqual(vectorColumn?.isNumeric, false);
		assert.strictEqual(vectorColumn?.isPlainTextType, false);
		assert.strictEqual(vectorColumn?.isEditable, false);
	});

	it('orders similarity search results by ascending cosine distance for a raw vector', async () => {
		const result = await engine.vectorSimilaritySearch({ table: 'embeddings', column: 'embedding', reference: '[1, 0, 0]', limit: 10 });

		assert.ok(result, 'expected a result');
		const labels = result!.rows.map((row: any) => row.label);

		// '[1,0,0]' is closest to 'a' (identical) then 'b', furthest from the orthogonal 'c'/'d'
		assert.strictEqual(labels[0], 'a');
		assert.strictEqual(labels[1], 'b');

		const distances = result!.rows.map((row: any) => Number(row._distance));
		for (let i = 1; i < distances.length; i++) {
			assert.ok(distances[i] >= distances[i - 1], `distances must be non-decreasing, got ${distances}`);
		}
	});

	it('accepts a numeric array as the similarity reference', async () => {
		const result = await engine.vectorSimilaritySearch({ table: 'embeddings', column: 'embedding', reference: [0, 1, 0], limit: 2 });

		assert.ok(result);
		assert.strictEqual(result!.rows.length, 2);
		assert.strictEqual(result!.rows[0].label, 'c');
	});

	it('runs similarity search against an existing row by primary key', async () => {
		const result = await engine.vectorSimilaritySearch({ table: 'embeddings', column: 'embedding', reference: 1, limit: 3 });

		assert.ok(result);
		// row 1 is 'a' => it is its own nearest neighbour (distance 0)
		assert.strictEqual(result!.rows[0].label, 'a');
		assert.strictEqual(Number(result!.rows[0]._distance), 0);
		assert.strictEqual(result!.rows[1].label, 'b');
	});

	it('returns a bounded cosine _similarity (1 - distance) for the cosine metric', async () => {
		const result = await engine.vectorSimilaritySearch({ table: 'embeddings', column: 'embedding', reference: '[1, 0, 0]', metric: 'cosine', limit: 4 });

		assert.ok(result);
		assert.strictEqual(result!.metric, 'cosine');
		assert.strictEqual(result!.operator, '<=>');
		// nearest row 'a' is identical => cosine similarity ~1
		assert.ok(Math.abs(Number(result!.rows[0]._similarity) - 1) < 1e-6, `expected ~1, got ${result!.rows[0]._similarity}`);
	});

	it('supports the L2 metric and leaves _similarity null', async () => {
		const result = await engine.vectorSimilaritySearch({ table: 'embeddings', column: 'embedding', reference: '[1, 0, 0]', metric: 'l2', limit: 4 });

		assert.ok(result);
		assert.strictEqual(result!.operator, '<->');
		assert.strictEqual(result!.rows[0].label, 'a');
		assert.strictEqual(result!.rows[0]._similarity, null);
	});

	it('narrows results with a WHERE metadata filter', async () => {
		const result = await engine.vectorSimilaritySearch({ table: 'embeddings', column: 'embedding', reference: '[1, 0, 0]', where: "label = 'c'", limit: 10 });

		assert.ok(result);
		assert.strictEqual(result!.rows.length, 1);
		assert.strictEqual(result!.rows[0].label, 'c');
	});

	it('blocks a dimension-mismatched query vector with a warning and no rows', async () => {
		const result = await engine.vectorSimilaritySearch({ table: 'embeddings', column: 'embedding', reference: '[1, 0, 0, 0]', limit: 10 });

		assert.ok(result);
		assert.strictEqual(result!.rows.length, 0);
		assert.ok(result!.warnings.some(warning => warning.includes('dimensions')), `expected a dimension warning, got ${JSON.stringify(result!.warnings)}`);
	});

	it('reports an index scan when an HNSW index exists, else a sequential scan', async () => {
		const withoutIndex = await engine.vectorSimilaritySearch({ table: 'embeddings', column: 'embedding', reference: '[1, 0, 0]', limit: 4 });
		assert.ok(withoutIndex);
		assert.strictEqual(withoutIndex!.scan?.type, 'seq');

		await engine.connection?.raw(`CREATE INDEX embeddings_hnsw ON embeddings USING hnsw (embedding vector_cosine_ops)`);
		// On this tiny table the planner prefers a seq scan on cost; force it to
		// choose the ANN index so we deterministically exercise index detection.
		// The single-connection pool (see `before`) keeps this SET on the session
		// used by the engine's own EXPLAIN.
		await engine.connection?.raw(`SET enable_seqscan = off`);

		try {
			const withIndex = await engine.vectorSimilaritySearch({ table: 'embeddings', column: 'embedding', reference: '[1, 0, 0]', metric: 'cosine', limit: 4 });
			assert.ok(withIndex);
			assert.strictEqual(withIndex!.scan?.type, 'index');
			assert.strictEqual(withIndex!.scan?.indexType, 'hnsw');
		} finally {
			await engine.connection?.raw(`SET enable_seqscan = on`);
		}
	});

	it('produces display-safe SQL that does not dump the raw vector literal', async () => {
		const result = await engine.vectorSimilaritySearch({ table: 'embeddings', column: 'embedding', reference: '[1, 0, 0]', limit: 4 });

		assert.ok(result);
		assert.ok(!result!.sql.includes('[1,0,0]') && !result!.sql.includes('[1, 0, 0]'), `SQL should be truncated, got ${result!.sql}`);
		assert.ok(result!.sql.includes('dims') || result!.sql.includes('[…]'), `expected a truncated literal, got ${result!.sql}`);
	});

	it('reports ANN indexes on the vector column', async () => {
		await engine.connection?.raw(`CREATE INDEX embeddings_hnsw ON embeddings USING hnsw (embedding vector_cosine_ops)`);

		const indexes = await engine.getVectorIndexes('embeddings', 'embedding');

		assert.strictEqual(indexes.length, 1);
		assert.strictEqual(indexes[0].indexType, 'hnsw');
		assert.strictEqual(indexes[0].indexName, 'embeddings_hnsw');
	});

	it('returns no ANN indexes when none exist on the column', async () => {
		const indexes = await engine.getVectorIndexes('embeddings', 'embedding');

		assert.deepStrictEqual(indexes, []);
	});
});
