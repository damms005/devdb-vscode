#!/usr/bin/env bash
# Creates the local D1 database of workspace-edge (binding DB) the way wrangler does:
# `wrangler d1 migrations apply --local` writes
# workspace-edge/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<id>.sqlite. Idempotent.
# Needs no Cloudflare account or network access to Cloudflare (npx downloads wrangler once).
set -euo pipefail
cd "$(dirname "$0")/../workspace-edge"
CI=1 npx --yes wrangler@4 d1 migrations apply edge-demo-db --local
ls -1 .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite
