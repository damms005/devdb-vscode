#!/usr/bin/env bash
# Seeds the local libSQL server (sqld) through its HTTP API. Idempotent.
set -euo pipefail
URL="${1:-http://127.0.0.1:8081}"
curl -fsS -X POST "$URL/" -H 'Content-Type: application/json' -d @- <<'JSON' >/dev/null
{"statements": [
  "CREATE TABLE IF NOT EXISTS authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT)",
  "CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(id), title TEXT NOT NULL, views INTEGER DEFAULT 0, published_at TEXT)",
  "INSERT OR IGNORE INTO authors (id, name, country) VALUES (1, 'Ada Lovelace', 'UK'), (2, 'Grace Hopper', 'US'), (3, 'Chinua Achebe', 'NG')",
  "INSERT OR IGNORE INTO posts (id, author_id, title, views, published_at) VALUES (1, 1, 'Notes on the Analytical Engine', 1843, '1843-09-01'), (2, 2, 'The first compiler', 1952, '1952-05-01'), (3, 3, 'Things Fall Apart', 1958, '1958-06-17'), (4, 1, 'Bernoulli numbers', 42, '1843-10-01')"
]}
JSON
echo "libsql seeded at $URL"
