// Builds data/sample.duckdb + data/*.parquet|csv|json|ndjson with the SAME driver DevDb ships (@duckdb/node-api).
// Usage: node duckdb/gen-duckdb.mjs (DEVDB_REPO overrides the repo that provides @duckdb/node-api; default: this repo)
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.env.DEVDB_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { DuckDBInstance } = createRequire(join(repo, 'package.json'))('@duckdb/node-api');
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(out, { recursive: true });
const db = join(out, 'sample.duckdb');
for (const f of [db, db + '.wal']) if (existsSync(f)) rmSync(f);

const inst = await DuckDBInstance.create(db);
const c = await inst.connect();
const run = (sql) => c.run(sql);

await run(`CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')`);
await run(`CREATE TABLE users (
  id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, email VARCHAR, mood mood,
  tags VARCHAR[], address STRUCT(city VARCHAR, zip VARCHAR), prefs MAP(VARCHAR, INTEGER),
  balance DECIMAL(18,4), big HUGEINT, ubig UBIGINT, uid UUID, avatar BLOB,
  created_at TIMESTAMPTZ, birthday DATE, active BOOLEAN)`);
await run(`INSERT INTO users
  SELECT i, 'User ' || i, CASE WHEN i % 10 = 0 THEN NULL ELSE 'user' || i || '@example.com' END,
         (['sad','ok','happy'])[1 + i % 3]::mood,
         ['t' || (i % 5), 't' || (i % 7)],
         {'city': (['Lagos','London','Berlin','Austin'])[1 + i % 4], 'zip': lpad((i*37 % 99999)::VARCHAR, 5, '0')},
         MAP {'theme': i % 2, 'lang': i % 3},
         (i * 1.2345)::DECIMAL(18,4),
         170141183460469231731687303715884105727::HUGEINT - i,
         18446744073709551615::UBIGINT - i,
         uuid(), '\\xDE\\xAD\\xBE\\xEF'::BLOB,
         TIMESTAMPTZ '2024-01-01 00:00:00+00' + INTERVAL (i) HOUR,
         DATE '1980-01-01' + (i % 15000)::INTEGER, i % 4 <> 0
  FROM range(1, 1001) t(i)`);

await run(`CREATE TABLE orders (id BIGINT PRIMARY KEY, user_id INTEGER, amount DECIMAL(10,2), status VARCHAR, ordered_at TIMESTAMP)`);
await run(`INSERT INTO orders SELECT i, 1 + i % 1000, round(random() * 500, 2), (['pending','paid','refunded'])[1 + i % 3],
                  TIMESTAMP '2024-01-01' + INTERVAL (i) MINUTE FROM range(1, 50001) t(i)`);

// 5M rows: SUMMARIZE takes a moment; cross-joins on it are slow enough to try Cancel.
await run(`CREATE TABLE measurements AS
  SELECT i AS id, (i % 500) AS sensor_id, random() * 100 AS value,
         TIMESTAMP '2024-01-01' + INTERVAL (i) SECOND AS ts FROM range(5000000) t(i)`);

await run(`CREATE TABLE no_pk_log (ts TIMESTAMP DEFAULT now(), msg VARCHAR)`);
await run(`INSERT INTO no_pk_log (msg) SELECT 'line ' || i FROM range(100) t(i)`);
await run(`CREATE VIEW paid_orders AS SELECT * FROM orders WHERE status = 'paid'`);
await run(`CREATE SCHEMA analytics`);
await run(`CREATE TABLE analytics.daily AS SELECT ordered_at::DATE AS day, count(*) n, sum(amount) total FROM orders GROUP BY 1`);

// Data files (browse without importing)
await run(`COPY (SELECT * FROM orders) TO '${join(out, 'orders.parquet')}' (FORMAT PARQUET)`);
await run(`COPY (SELECT id, name, email, mood, balance, created_at FROM users) TO '${join(out, 'users.csv')}' (HEADER)`);
await run(`COPY (SELECT id, name, tags, address FROM users LIMIT 200) TO '${join(out, 'users.json')}' (FORMAT JSON, ARRAY true)`);
await run(`COPY (SELECT id, name, tags, address FROM users LIMIT 200) TO '${join(out, 'users.ndjson')}' (FORMAT JSON)`);
await run(`COPY (SELECT * FROM orders LIMIT 1000) TO '${join(out, 'orders.tsv')}' (HEADER, DELIMITER '\t')`);
await run(`COPY (SELECT 1 AS id, 'x' AS v) TO '${join(out, '2024-report (final).csv')}' (HEADER)`); // odd filename -> view-name sanitising
await run(`CHECKPOINT`);

const r = await c.runAndReadAll(`SELECT schema_name, table_name, estimated_size FROM duckdb_tables() ORDER BY 1, 2`);
console.table(r.getRowObjects());
c.closeSync?.(); inst.closeSync?.();
console.log('written to', out);
