## 4.0.0

### Added

- Cloudflare D1 (local), free: DevDb finds `d1_databases` in `wrangler.json`/`wrangler.jsonc`/`wrangler.toml` and opens the local SQLite file of each binding (`.wrangler/state`, or `--persist-to` from `package.json` scripts).
- Cloudflare D1 (remote), Pro: connect with account ID, database ID and API token over the Cloudflare REST API.
- Turso / libSQL, Pro: detected from `TURSO_DATABASE_URL` in `.env` or a `drizzle.config` with `dialect: 'turso'`, or added as a remote connection.
- Pro: DynamoDB (AWS profiles incl. SSO, access keys, DynamoDB Local and LocalStack). Zero-config detection from `docker-compose.yml` and `.env`. Query/Scan filters, edits and deletes by full key, PartiQL for MCP (read-only by default).

### Fixed

- SQLite works when the native driver cannot load (the universal Open VSX package on macOS, Windows or ARM, or Linux with glibc older than 2.29). DevDb then uses a WebAssembly SQLite; WAL-mode databases open read-only in that mode. Also, DevDb no longer fails to start when another window uses the MCP port.

## 3.2.0

### Added

- Pro datastores: Redis/Valkey (namespaces, command console), ClickHouse (http/https), DuckDB (database files and Parquet/CSV/TSV/JSON/NDJSON, read-only by default), Neon (`.env` detection, verified TLS), and pgvector similarity search with OpenAI-compatible and Ollama embedding endpoints.
- `Devdb.mcp.allowWrites` setting: MCP queries are read-only unless you enable it. Each write asks for confirmation.
- Per-platform VSIX packages include the correct DuckDB native binding. CI checks each VSIX.

### Fixed

- Edit, delete, and set-null work on DuckDB, Redis, and ClickHouse.
- Column filters work again on MySQL, SQLite and MSSQL `varchar(n)`, `char(n)`, enum and date columns.
- Redis/Valkey and ClickHouse connections save, test and connect from the remote-connection dialog. Direct Postgres works on any port.
- Redis fails fast with the real error on a wrong password or a closed port. ClickHouse rejects a wrong password on connect.
- ClickHouse keeps Decimal precision. Cancel stops the query on the server, and queries have time and memory limits.
- DuckDB shows DECIMAL, UUID, DATE, TIMESTAMPTZ, MAP and BLOB values as readable text. SUMMARIZE works when one column fails. Raw queries stop at 10,000 rows. Cancel works.
- The new-datastores notice shows once, on 3.2.x only. Pro users get a short toast.
- `npm test` runs the Mocha suite.
- SQLite loads on linux-arm64, linux-armhf and Alpine. New win32-arm64 and alpine-arm64 packages.

### Security

- The extension is disabled in untrusted workspaces. `Devdb.phpExecutablePath` has machine scope.
- MCP server accepts localhost only, requires a token, and runs queries read-only at the database level.
- MCP clients must reconnect after the update: restart VS Code so the MCP server writes its new token.
- SSH tunnels check the host key against `~/.ssh/known_hosts` and ask you to trust an unknown host.
- Connection strings with passwords are stored in VS Code SecretStorage, keyed by connection id.
- DuckDB cannot read or write files outside the opened file and cannot load extensions.
- Embedding API keys are sent only to the origin they were saved for. Remote endpoints need https.
- Webviews use a strict Content Security Policy with random nonces.
- Updated dependencies: 0 high or critical `npm audit`/`bun audit` findings. Release tooling (`@vscode/vsce`, `ovsx`) is pinned and publish tokens are passed through the environment.

---

We try not to use 'WIP' commit messages. Hence, a commit log with descriptive messages is the best CHANGELOG we can offer for now.

[Click here for full commit log](https://github.com/damms005/devdb-vscode/commits/main)
