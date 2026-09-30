CREATE EXTENSION IF NOT EXISTS vector;

-- Small, hand-checkable vectors (paste "[1,0,0]" into the similarity box)
CREATE TABLE items (
  id serial PRIMARY KEY,
  label text NOT NULL,
  category text NOT NULL,
  embedding vector(3)
);
INSERT INTO items (label, category, embedding) VALUES
 ('x-axis', 'axis', '[1,0,0]'), ('y-axis', 'axis', '[0,1,0]'), ('z-axis', 'axis', '[0,0,1]'),
 ('near-x', 'near', '[0.9,0.1,0]'), ('near-y', 'near', '[0.1,0.9,0]'), ('diag', 'mixed', '[0.577,0.577,0.577]'),
 ('null-vec', 'mixed', NULL);
-- no index on items.embedding: expect "sequential scan" / no-ANN-index detection

-- Mid-size random table with IVFFlat (L2) + a second HNSW (inner product) index
CREATE TABLE products (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  price numeric(10,2) NOT NULL,
  in_stock boolean NOT NULL,
  embedding vector(64) NOT NULL
);
INSERT INTO products (name, category, price, in_stock, embedding)
SELECT 'Product ' || g,
       (ARRAY['books','games','tools','garden'])[1 + g % 4],
       round((random() * 200)::numeric, 2),
       g % 7 <> 0,
       (SELECT array_agg(random()::real) FROM generate_series(1, 64) WHERE g > 0)::vector
FROM generate_series(1, 20000) g;
CREATE INDEX products_embedding_ivfflat ON products USING ivfflat (embedding vector_l2_ops) WITH (lists = 100);
CREATE INDEX products_embedding_hnsw_ip ON products USING hnsw (embedding vector_ip_ops);
ANALYZE products;

-- Real text embeddings (768-d, nomic-embed-text via Ollama), HNSW cosine. Filled by seed-embeddings.py.
CREATE TABLE documents (
  id serial PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  topic text NOT NULL,
  embedding vector(768)
);
CREATE INDEX documents_embedding_hnsw ON documents USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- halfvec column (pgvector >= 0.7)
CREATE TABLE half_items (id serial PRIMARY KEY, label text, embedding halfvec(3));
INSERT INTO half_items (label, embedding) VALUES ('a', '[1,0,0]'), ('b', '[0,1,0]');
