#!/usr/bin/env bash
# Opens a visible DevDb test window for manual play: Pro (local mock license) and saved
# connections to every local datastore. The window stays open until you close it.
#   .claude/skills/run-devdb/playground.sh          # build + launch
#   .claude/skills/run-devdb/playground.sh stop     # close it
set -euo pipefail

SKILL="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SKILL/../../.." && pwd)"
PLAY="${TMPDIR:-/tmp}/devdb-play"

stop() {
	[ -p "$PLAY/in" ] && { printf 'quit\n' > "$PLAY/in" & sleep 3; }
	[ -f "$PLAY/driver.pid" ] && kill "$(cat "$PLAY/driver.pid")" 2>/dev/null || true
	[ -f "$PLAY/hold.pid" ] && kill "$(cat "$PLAY/hold.pid")" 2>/dev/null || true
	rm -rf "$PLAY"
}

if [ "${1:-}" = "stop" ]; then stop; echo "Stopped."; exit 0; fi

docker ps --format '{{.Names}}' | grep -q devdb-local || docker ps --format '{{.Ports}}' | grep -q ':6379->' || {
	echo "Local datastores are not running. Start them: $SKILL/local-datastores/up.sh"; exit 1; }

stop
mkdir -p "$PLAY" && mkfifo "$PLAY/in"
(cd "$REPO" && DEVDB_LICENSE_API_BASE=http://127.0.0.1:47181/api/license node esbuild.js >/dev/null)

# Keep the driver's stdin open after the setup commands.
sleep 86400 > "$PLAY/in" 2>/dev/null </dev/null & echo $! > "$PLAY/hold.pid"
(cd "$REPO" && DEVDB_FRESH_PROFILE=1 DEVDB_FOREGROUND=1 NODE_EXTRA_CA_CERTS="$SKILL/local-datastores/certs/ca.crt" \
	nohup node "$SKILL/driver.mjs" < "$PLAY/in" > "$PLAY/out" 2>&1 & echo $! > "$PLAY/driver.pid")

send() {
	local before; before=$(grep -c '> ' "$PLAY/out" 2>/dev/null || true)
	printf '%s\n' "$1" > "$PLAY/in"
	for _ in $(seq 1 90); do [ "$(grep -c '> ' "$PLAY/out" 2>/dev/null || true)" -gt "$before" ] && break; sleep 1; done
}

for _ in $(seq 1 90); do grep -q READY "$PLAY/out" 2>/dev/null && break; sleep 1; done
grep -q READY "$PLAY/out" || { echo "VS Code did not start. Log: $PLAY/out"; exit 1; }

# Saves the connections directly (dev-only command), not through the add-connection dialog.
CONNECTIONS='[
 {"connectionType":"redis","connectionName":"Redis (local)","redisConnectionString":"redis://localhost:6379/0"},
 {"connectionType":"redis","connectionName":"Valkey (local)","redisConnectionString":"redis://:valkeypass@localhost:6380/0"},
 {"connectionType":"clickhouse","connectionName":"ClickHouse (local)","dbHost":"localhost","dbPort":8123,"dbUsername":"default","dbPassword":"devdb","dbName":"devdb","protocol":"http"},
 {"connectionType":"direct","dbEngine":"postgres","connectionName":"Neon-like TLS (local)","dbHost":"localhost","dbPort":5432,"dbUsername":"neondb_owner","dbPassword":"npg_localpass","dbName":"neondb","ssl":true}
]'
send "exec-wait devdb.dev.saveRemoteConnections [$(printf '%s' "$CONNECTIONS" | tr -d '\n')]"
send "exec workbench.action.closeAllEditors"
send "panel"
send "webview-wait Config File"
send "license"
sleep 3
send "webview view"
send "webview-wait Remote Connections"
send "exec notifications.clearAll"

if grep -q 'ERROR' "$PLAY/out"; then echo "Some setup steps failed:"; grep ERROR "$PLAY/out"; fi
echo "Ready. Config File: DuckDB + pgvector. Remote: Redis, Valkey, ClickHouse, Neon-like TLS."
echo "Close the window or run: $0 stop"
