---
name: run-devdb
description: Build, launch and drive the DevDb VS Code extension end to end in a separate, throwaway VS Code (open the DevDb panel, click and type in its webview, run commands, read toasts and editor tabs, screenshot, tail the DevDb log). Use when asked to run the extension, check a UI change, take a screenshot, test the new-datastores promo, or connect to a local datastore (Redis, Valkey, ClickHouse, pgvector, Neon-like TLS Postgres, DuckDB).
---

# Run and drive DevDb

`driver.mjs` downloads a VS Code build (cached in `.vscode-test/`), starts it through Playwright's `_electron` with this repo as the extension under development, and runs commands against the VS Code window and the DevDb webviews. It never touches the user's real VS Code: it uses its own `--user-data-dir` and `--extensions-dir` under `$DEVDB_DRIVER_DIR`, `--disable-extensions` (only DevDb and the driver bridge load), and `--use-inmemory-secretstorage` (no keychain access, no stored licenses). It runs next to an open VS Code.

The window does not take focus: on macOS the driver hides the app (as after Cmd+H) and shows the window inactive, with background throttling off, so it still renders for screenshots and input. The Dock icon can bounce for a moment at start. Cmd+Tab to it to watch it live. On Windows and Linux the window is minimized. Input goes to the window through Playwright, not through the OS keyboard.

The driver also loads `bridge/` (a test-only extension): a small HTTP server on 127.0.0.1 that runs VS Code commands with arguments (`exec`) and code in the extension host (`host-eval`). The port goes to `$DEVDB_DRIVER_DIR/bridge.port`.

All paths are relative to the repo root.

## Setup (once)

```bash
ln -s <main-checkout>/node_modules node_modules   # only in a git worktree without node_modules
npm install --prefix .claude/skills/run-devdb
```

The first run downloads VS Code stable (about 300 MB) into `.vscode-test/`. Later runs reuse it.

## Build

The driver runs `dist/extension.js`, so build after each code change. For driver runs, point the license API at the driver's local mock (see **License**):

```bash
DEVDB_LICENSE_API_BASE=http://127.0.0.1:47181/api/license node esbuild.js
```

- `node esbuild.js` bundles the extension only (about 1 s). `npm run compile` also runs `tsc --noEmit`.
- The webview UI is `ui-shell/dist/assets/*` (committed). Rebuild it (`cd ui-shell && npm run build`, needs `../../devdb-ui`) only when you test a change in the `devdb-ui` repo.

## Run

Batch mode (a JSON list of `[command, argument]`, or a path to a JSON file). Exit code 1 when a step fails:

```bash
node .claude/skills/run-devdb/driver.mjs '[["panel"],["webview-wait","DevDb"],["webview-text","800"],["shot","panel"]]'
```

Interactive mode (one `command argument` per line on stdin, `quit` to close). Use it from tmux to look around step by step:

```bash
tmux new-session -d -s devdb 'node .claude/skills/run-devdb/driver.mjs 2>&1 | tee /tmp/devdb-driver.out'
tmux send-keys -t devdb 'panel' Enter
tmux send-keys -t devdb 'webview-text 800' Enter
tail -5 /tmp/devdb-driver.out
```

The first line of output is `READY window=… workspace=… profile=… bridge=yes license_api=… license_mock=yes|no|shared shots=<dir> log=<file>`. `bridge=no` means `exec`, `panel` and `host-eval` do not work: read `log exthost`. Screenshots go to `$DEVDB_DRIVER_DIR/shots` (default `<tmpdir>/devdb-driver/shots`). Read them with the Read tool: a blank or wrong screen is a failure.

## Close what you start (hard rule)

When the test is done, close every VS Code that you started with the driver, before you report back. Leave it running only when the user explicitly asks for that, or explicitly gives permission to leave it running.

- **Batch mode** closes VS Code when the list ends. A batch that you stop, or that a timeout stops, can leave VS Code running.
- **Interactive mode**: send `quit`, then run `tmux kill-session -t devdb`.
- **Before you report**, run `pgrep -fl 'run-devdb/driver.mjs|devdb-driver/profile'`. Stop each leftover process that you started: `kill <pid>`.
- Stop only processes that you started. Another session can use the driver at the same time (give it its own `DEVDB_DRIVER_DIR`). If you cannot tell who started a process, ask the user.
- The same rule applies to the local datastores: stop them with `down.sh` only when you started them.

## Commands

| Command | Argument | Does |
|---|---|---|
| `panel` | `max` (optional) | Opens the DevDb bottom panel (`devdb.focus`) and waits for its webview. `max` toggles the maximized panel (the state is kept in the profile, so a second `max` restores it) |
| `exec` | `<command id> [JSON args]` | Runs a VS Code command through the bridge without waiting (safe for commands that open a picker or input box) |
| `exec-wait` | `<command id> [JSON args]` | Same, but waits and returns the command result |
| `palette` | command title | Cmd/Ctrl+Shift+P, types `>title`, Enter on the first match; fails when nothing matches |
| `license` | token (default `DEVDBM-LOCAL-TEST`) | Activates a Pro license against the local mock and reloads webviews (see **License**) |
| `webview` | `view` (default), `editor`, or title part | Selects the DevDb webview for the `webview-*` commands: `view` = bottom panel, `editor` = a webview in an editor tab (the promo) |
| `webviews` | | Lists all webview frames: extension, purpose, title |
| `webview-text` | max chars (3000) | Text of the selected webview |
| `webview-click` | visible text | Clicks the element with that text (exact, then prefix) |
| `webview-click-css` | CSS selector | DOM click on the first match (toasts cannot block it), e.g. `[data-testid=connect-button]` |
| `webview-hover` | CSS selector | Real mouse hover on the first match (hover-only UI, e.g. the cell actions popover) |
| `webview-fill` | `<placeholder or label>=<value>`; in a batch also `["webview-fill", "<target>", "<value>"]`; target `css:<selector>` for CSS (Playwright `>> nth=1` works) | Fills an input (Vue `v-model` sees it) |
| `webview-type` / `webview-key` | text / key | Types into / presses a key on the focused webview element |
| `webview-wait` / `webview-assert` | text | Waits up to 60 s for / fails when not: the text in the webview |
| `webview-eval` | JS expression | Runs JS in the webview document |
| `quickpick` / `quickpick-select` | / row text | Lists the open quick pick rows / clicks a row |
| `editor-tabs` | | Lists editor tab labels (`*` marks the active tab) |
| `notifications` | | Lists notification toasts (and the notification center when open) with their buttons |
| `click-notification-button` | button text | Clicks a toast button |
| `click` / `click-css` | text / CSS | Clicks in the VS Code workbench |
| `type` / `key` | text / key (`Mod+p` = Cmd on macOS, Ctrl elsewhere; `Escape`, `Enter`) | Keyboard input to the window |
| `text` / `assert` / `wait-text` | max chars / text / text | Workbench text (webview content not included) |
| `eval` | JS | Runs JS in the workbench renderer |
| `host-eval` | JS function body, `vscode` in scope | Runs code in the extension host, e.g. `return vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label))` |
| `shot` | name | Saves a PNG of the window (webviews included) |
| `log` | `[devdb\|exthost\|renderer\|main\|license] [lines]` | Tail of the DevDb output channel (default), the extension host log, the renderer log, VS Code stdout/stderr, or the license mock requests |
| `sleep` | ms | Waits |

## Environment

| Variable | Effect |
|---|---|
| `DEVDB_DRIVER_DIR` | Work folder (profile, exts, shots, logs). Default `<tmpdir>/devdb-driver` |
| `DEVDB_WORKSPACE` | Folder to open. Default `local-datastores/workspace` (its `.devdbrc` activates DevDb and lists DuckDB + pgvector) |
| `DEVDB_FRESH_PROFILE=1` | Deletes the profile first: VS Code and DevDb see a new install (promo tests). Otherwise the profile (globalState, saved remote connections) is kept between runs |
| `DEVDB_FOREGROUND=1` | Shows the window normally and gives it focus |
| `DEVDB_VSCODE_VERSION` | VS Code version to download (default `stable`, e.g. `1.90.0` for the minimum engine) |
| `NODE_EXTRA_CA_CERTS` | Passed through to VS Code and the extension host. Needed for the Neon-like TLS Postgres |

## License

- Pro is a stored license in `context.secrets` (key `devdb-pro-license`: token, `expires_at`, `machine_id`, `status`), checked at activation by `LicenseService.initialize()` (`src/services/license/`). The webview gets `hasLicense` through `request:get-license-status` and locks Pro providers (`LockedProviderRow`) without it.
- The API base is compiled in by `esbuild.js` (`process.env.DEVDB_LICENSE_API_BASE` define): `--production` → `https://devdbpro.com/api/license` (production, never use from tests); dev build → `$DEVDB_LICENSE_API_BASE` at build time, else `https://devdbpro.test/api/license` (the local Herd site `~/Herd/devdb-pro`, only when Herd runs).
- Driver runs: build with `DEVDB_LICENSE_API_BASE=http://127.0.0.1:47181/api/license`. The driver reads the base from `dist/extension.js`; when it is a loopback `http://` URL, the driver answers `/activate` and `/status` itself (any `DEVDBM-`/`DEVDBY-` token is granted for one year; requests go to `license-mock.log`). `license_mock=shared` means another driver already serves that port (same answers).
- `license` refuses to run when the build points anywhere else, so a test never sends a token to a real server. Check `license_api=` in the READY line.
- Secrets are in memory (`--use-inmemory-secretstorage`): every run starts Free. Run `license` in each batch that needs Pro, before the Pro steps.

## Local datastores

`local-datastores/` is a seeded Docker Compose stack for the new engines. Generated files (`data/`, `certs/*.crt|*.key`, `workspace/.devdbrc`, logs) are gitignored.

```bash
.claude/skills/run-devdb/local-datastores/up.sh      # certs, DuckDB files, workspace/.devdbrc, compose up --wait, seed, verify
.claude/skills/run-devdb/local-datastores/verify.sh  # one query per service
.claude/skills/run-devdb/local-datastores/down.sh    # stop + delete volumes (only when you started the stack)
```

| Service | Port | Credentials |
|---|---|---|
| Redis | 6379 | none |
| Valkey | 6380 | password `valkeypass` (or user `devdb` / `devdbpass`) |
| ClickHouse (HTTP) | 8123 | `default` / `devdb`, database `devdb` |
| pgvector (Postgres 16) | 5433 | `devdb` / `devdb`, database `vectors` |
| Neon-like TLS Postgres | 5432 | `neondb_owner` / `npg_localpass`, database `neondb`, TLS only, private CA `certs/ca.crt` |
| DuckDB | files | `data/sample.duckdb`, `data/*.parquet|csv|json|ndjson|tsv` |

Container names are fixed (`devdb-local-*`), so only one copy of the stack runs at a time. Check first: `docker ps --filter name=devdb-local`. When `workspace/.devdbrc` is missing, the driver writes it from `.devdbrc.template` (DuckDB path in this folder).

## Test recipes

Build first (see **Build**). Each recipe is a batch; add `["shot","<name>"]` where you want evidence. All recipes below passed on 2026-09-30 against the local datastores. After `license`, the webview reloads: always follow it with `["sleep","2500"],["webview","view"]`.

Pro prefix used below (call it `PRO`): `["exec","workbench.action.closeAllEditors"],["panel","max"],["webview-wait","Config File"],["license"],["sleep","2500"],["webview","view"]`

### New-datastores promo

The automatic notice shows once, on a 3.2.x version only (`package.json` stays at the last release until `publish.sh` bumps it). Use the dev command to preview both copies:

```json
[["exec","devdb.dev.previewNewDatastoresNotice {\"licensed\":false}"],["sleep","2500"],["webview","editor"],
 ["webview-wait","5 New Databases"],["webview-assert","Unlock with DevDb Pro"],["shot","promo-free"],
 ["exec","workbench.action.closeAllEditors"],["exec","notifications.clearAll"],
 ["exec","devdb.dev.previewNewDatastoresNotice {\"licensed\":true}"],["sleep","2500"],
 ["notifications"],["editor-tabs"],["shot","promo-pro"]]
```

Expected: Free = full-page tab "New in DevDb — 5 New Databases". Pro = toast "5 new datastores are in your Pro plan" and no tab.

### Redis / Valkey

```json
[PRO,["webview-wait","Remote Connections"],
 ["webview-click-css","[data-testid=add-remote-connection-btn]"],["webview-click-css","[data-testid=connection-option-redis]"],
 ["webview-fill","redis://user:pass@host:6379/0","redis://localhost:6379/0"],["webview-fill","My Production DB","local-redis"],
 ["webview-click-css","[data-testid=test-connection-button]"],["sleep","2500"],["webview-assert","Connection successful"],
 ["webview-click-css","[data-testid=connect-button]"],["sleep","2500"],["webview-click","local-redis"],
 ["webview-wait","string"],["webview-click","string"],["sleep","2500"],["shot","redis-string"]]
```

- Valkey: `redis://:valkeypass@localhost:6380/0`. A wrong password must fail at once with `WRONGPASS …`.
- RESP console: `["webview-click-css","[data-testid=redis-console-button]"]`, then `["webview-fill","css:input[placeholder=command]","DBSIZE"],["webview-click-css","input[placeholder=command]"],["webview-key","Enter"]`. A write command (`FLUSHALL`) must show "… Run it?" with Cancel / Run command. Click Cancel and check `redis-cli dbsize` is unchanged.

### ClickHouse

```json
[PRO,["webview-wait","Remote Connections"],
 ["webview-click-css","[data-testid=add-remote-connection-btn]"],["webview-click-css","[data-testid=connection-option-clickhouse]"],
 ["webview-fill","css:input[placeholder=localhost]","localhost"],
 ["webview-fill","css:input[placeholder=default] >> nth=0","default"],["webview-fill","css:input[type=password]","devdb"],
 ["webview-fill","css:input[placeholder=default] >> nth=1","devdb"],["webview-fill","My Production DB","local-clickhouse"],
 ["webview-click-css","[data-testid=test-connection-button]"],["sleep","2500"],["webview-assert","Connection successful"],
 ["webview-click-css","[data-testid=connect-button]"],["sleep","2500"],["webview-click","local-clickhouse"],
 ["webview-wait","events"],["webview-click","events"],["sleep","3500"],
 ["webview-assert","18446744073709551615"],["webview-assert","99999999999999.9999"],["shot","clickhouse-events"]]
```

Protocol defaults to `http` for localhost and `https` for port 8443 or a remote host.

### DuckDB through `.devdbrc`

```json
[PRO,["webview-wait","sample.duckdb"],["webview-click","/Users/damms005/Code/github-pl...-datastores/data/sample.duckdb"],
 ["webview-wait","users"],["webview-click","users"],["sleep","2500"],["webview-assert","0xDEADBEEF"],
 ["webview-click-css","[data-testid=summarize-button]"],["sleep","3000"],["webview-assert","null_percentage"],["shot","duckdb-users"]]
```

The click text is the truncated path the panel shows; read it with `webview-text` first when the repo path differs. No cell may show a raw object (`{"micros":…}`, `{"days":…}`). The DuckDB **file picker** opens a native OS dialog, which the driver cannot drive.

### pgvector similarity search

The cell actions open from a hover-only icon. A DOM click on the icon's SVG opens the popover:

```json
[PRO,["webview-wait","pgvector-local"],["webview-click","pgvector-local"],["webview-wait","documents"],["webview-click","documents"],
 ["webview-wait","Resetting a password"],
 ["webview-eval","(()=>{const td=[...document.querySelectorAll('td')].filter(t=>/768d/.test(t.innerText)&&t.children.length<6)[1];td.querySelector('.tools button[aria-haspopup=dialog] svg').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return 'ok'})()"],
 ["sleep","800"],["webview-click-css","[title=\"Find similar rows\"]"],["sleep","4000"],["webview-assert","cosine similarity"],["shot","pgvector-similar"]]
```

### Neon-like TLS Postgres, direct connection

Start with `NODE_EXTRA_CA_CERTS=$PWD/.claude/skills/run-devdb/local-datastores/certs/ca.crt`. Without it, the connection fails with a certificate error, which is correct for a private CA. The paste parser runs on `paste` or `blur`, and `webview-fill` sends neither, so dispatch `blur`:

```json
[PRO,["webview-wait","Remote Connections"],
 ["webview-click-css","[data-testid=add-remote-connection-btn]"],["webview-click-css","[data-testid=connection-option-direct]"],
 ["webview-fill","postgres://user:pass@host:5432/db?sslmode=require","postgres://neondb_owner:npg_localpass@localhost:5432/neondb?sslmode=require"],
 ["webview-eval","document.querySelector('input[placeholder^=postgres]').dispatchEvent(new Event('blur'))"],
 ["webview-fill","My Production DB","neon-tls"],["webview-click-css","[data-testid=test-connection-button]"],["sleep","3000"],
 ["webview-assert","Connection successful"],["webview-click-css","[data-testid=connect-button]"],["sleep","2500"],
 ["webview-click","neon-tls"],["webview-wait","customers"],["shot","neon-tls"]]
```

The `.devdbrc` entry `neon-tls-via-config-file` fails on purpose (the config file has no `ssl` option). Neon through `.env` (`DATABASE_URL` on `*.neon.tech`): use `DEVDB_WORKSPACE=.claude/skills/run-devdb/local-datastores/workspace-neon` and add `127.0.0.1 ep-local-devdb-123456.us-east-2.aws.neon.tech` to `/etc/hosts` first (ask the user: it needs sudo). The driver stops with `NEON_HOST_NOT_LOCAL` (exit 2) when the host is not mapped, because DevDb would send the test password to real Neon.

Saved remote connections stay in the profile. Use `DEVDB_FRESH_PROFILE=1` for a clean list.

## Gotchas

- **Secrets do not survive a launch:** `--use-inmemory-secretstorage` drops saved passwords when VS Code closes. A saved Redis/Mongo connection with a password then shows "The saved password for … was not found". Add the connection again in the same batch that uses it.
- **Short work folder:** VS Code's IPC socket path must stay under 104 characters on macOS. Keep `DEVDB_DRIVER_DIR` short (the default `<tmpdir>/devdb-driver` works; a long scratchpad path fails with `listen EINVAL`).
- **VS Code cache:** the first run downloads VS Code (about 860 MB) into `.vscode-test/`. A worktree has its own copy: `cp -cR <other>/.vscode-test/. .vscode-test/` saves the download.
- **Webview UI is the committed bundle** (`ui-shell/dist/assets`), not the `devdb-ui` source. Labels and `data-testid`s can differ from the source after a `devdb-ui` change, rebuild `ui-shell` first (`cd ui-shell && bun install && npm run build`). List the real fields with `webview-eval` before you write a new recipe: `[...document.querySelectorAll("input,button")].filter(e=>e.getClientRects().length).map(e=>e.placeholder||e.dataset.testid||e.innerText)`.
- **Same text twice:** `webview-click` takes the first exact match in the whole panel. "Connect" is on every local provider row: use `[data-testid=connect-button]` for the dialog button.
- **Toasts** cover the lower right of the panel. `webview-click` and `webview-click-css` use DOM clicks, so toasts do not block them; `exec notifications.clearAll` removes them for screenshots.
- **"All installed extensions are temporarily disabled"** toast comes from `--disable-extensions`. Ignore it. Never click its button: VS Code reloads with all extensions of the driver profile enabled.
- **Toasts hide** after a while or on `Escape`. `notifications` reads visible toasts only; run `["exec","notifications.showList"]` first to read the notification center too.
- **`exec` does not wait** (a command can open a quick pick and never return). Use `exec-wait` for commands that return a value.
- **Startup:** DevDb activates from `workspaceContains:**/.devdbrc`. A workspace without `.devdbrc` activates DevDb only when `panel` opens it.
- **First panel load** takes 3 to 8 s (provider checks, MCP server start). Use `webview-wait`, not `sleep`.
- **Focus:** the Dock icon can bounce and the app can get focus for a moment at launch, before the driver hides it. Use `DEVDB_FOREGROUND=1` to watch.
- **Do not pass `-ApplePersistenceIgnoreState`:** the VS Code CLI reads it as short flags (`-s` = `--status`) and quits at once.
- **Parallel runs:** give each session its own `DEVDB_DRIVER_DIR`. The license mock port 47181 is shared (`license_mock=shared`), which is safe because the answers are the same.
- **Linux without a display:** start the driver under `xvfb-run`.
