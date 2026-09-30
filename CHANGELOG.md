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
