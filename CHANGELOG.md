## 3.2.0

### Added

- Pro datastores: Redis/Valkey (namespaces, command console), ClickHouse (http/https), DuckDB (database files and Parquet/CSV/TSV/JSON/NDJSON, read-only by default), Neon (`.env` detection, verified TLS), and pgvector similarity search with OpenAI-compatible and Ollama embedding endpoints.
- `devdb.mcp.allowWrites` setting: MCP queries are read-only unless you enable it. Each write asks for confirmation.
- Per-platform VSIX packages include the correct DuckDB native binding. CI checks each VSIX.

### Fixed

- Edit, delete, and set-null work on DuckDB, Redis, and ClickHouse.
- `npm test` runs the Mocha suite.

### Security

- The extension is disabled in untrusted workspaces. `Devdb.phpExecutablePath` has machine scope.
- MCP server accepts localhost only, requires a token, and runs queries read-only at the database level.
- Updated dependencies: 0 high or critical `npm audit`/`bun audit` findings. Release tooling (`@vscode/vsce`, `ovsx`) is pinned and publish tokens are passed through the environment.

---

We try not to use 'WIP' commit messages. Hence, a commit log with descriptive messages is the best CHANGELOG we can offer for now.

[Click here for full commit log](https://github.com/damms005/devdb-vscode/commits/main)
