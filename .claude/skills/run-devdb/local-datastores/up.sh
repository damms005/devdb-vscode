#!/usr/bin/env bash
# Start + seed the whole stack. Idempotent.
set -euo pipefail
cd "$(dirname "$0")"
./certs/gen-certs.sh
node duckdb/gen-duckdb.mjs
sed "s#__DATA_DIR__#$(pwd)/data#" workspace/.devdbrc.template > workspace/.devdbrc
docker compose up -d --wait
docker compose run --rm redis-seed
python3 pgvector/seed-embeddings.py
./verify.sh
