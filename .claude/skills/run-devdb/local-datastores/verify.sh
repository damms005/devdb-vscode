#!/usr/bin/env bash
# One query per service.
set -uo pipefail
cd "$(dirname "$0")"
echo "== redis";  docker exec devdb-local-redis redis-cli DBSIZE; docker exec devdb-local-redis redis-cli TTL session:abc123
echo "== valkey"; docker exec devdb-local-valkey valkey-cli --user devdb --pass devdbpass --no-auth-warning DBSIZE
echo "== clickhouse"
curl -s -u default:devdb 'http://localhost:8123/?output_format_json_quote_64bit_integers=1' \
  --data-binary "SELECT id, big_signed, amount, price, attrs FROM devdb.events ORDER BY id DESC LIMIT 2 FORMAT JSONCompact" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"])'
curl -s -u default:devdb http://localhost:8123/ --data-binary "SELECT name, total_rows FROM system.tables WHERE database='devdb' FORMAT TSV"
echo "== pgvector"
docker exec devdb-local-pgvector psql -U devdb -d vectors -Atc "SELECT extversion FROM pg_extension WHERE extname='vector'"
docker exec devdb-local-pgvector psql -U devdb -d vectors -Atc "SELECT indexname FROM pg_indexes WHERE indexdef ILIKE '%hnsw%' OR indexdef ILIKE '%ivfflat%'"
docker exec devdb-local-pgvector psql -U devdb -d vectors -Atc "SELECT id, label, round((embedding <=> '[1,0,0]')::numeric,3) FROM items WHERE embedding IS NOT NULL ORDER BY embedding <=> '[1,0,0]' LIMIT 3"
docker exec devdb-local-pgvector psql -U devdb -d vectors -Atc "SELECT count(*), vector_dims(min(embedding::text)::vector) FROM documents"
echo "== neon-tls (verify-full with private CA => must succeed)"
PGPASSWORD=npg_localpass psql "host=localhost port=5432 dbname=neondb user=neondb_owner sslmode=verify-full sslrootcert=certs/ca.crt" -Atc "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
echo "== neon-tls (no TLS => must be rejected)"
PGPASSWORD=npg_localpass psql "host=localhost port=5432 dbname=neondb user=neondb_owner sslmode=disable" -Atc "SELECT 1" 2>&1 | tail -1
echo "== neon-tls (cert chain vs system trust store => must NOT verify)"
openssl s_client -starttls postgres -connect localhost:5432 -servername localhost </dev/null 2>/dev/null | grep -E "Verify return code"
echo "== neon-tls (cert chain vs private CA => must verify)"
openssl s_client -starttls postgres -connect localhost:5432 -servername localhost -CAfile certs/ca.crt </dev/null 2>/dev/null | grep -E "Verify return code"
echo "== duckdb"; ls -1 data
