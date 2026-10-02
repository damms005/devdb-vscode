#!/usr/bin/env bash
# Runs the UI regression tour and compares each screenshot with a baseline run.
#   compare.sh baseline            # run the tour, keep the shots as the baseline
#   compare.sh                     # run the tour again and compare with the baseline
# Needs the local datastores, ImageMagick (magick) and a driver build:
#   DEVDB_LICENSE_API_BASE=http://127.0.0.1:47181/api/license node esbuild.js
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
# Short path: the VS Code IPC socket path must stay under 104 characters on macOS.
OUT="/tmp/devdb-tour"
RUN="$OUT/$([ "${1:-}" = baseline ] && echo baseline || echo current)"

mkdir -p "$OUT" && rm -rf "$RUN"
(cd "$REPO" && DEVDB_DRIVER_DIR="$RUN" DEVDB_FRESH_PROFILE=1 NODE_EXTRA_CA_CERTS="$HERE/../local-datastores/certs/ca.crt" \
	node "$HERE/../driver.mjs" "$HERE/ui-regression.json" > "$RUN.log" 2>&1) || { echo "Tour failed:"; grep -B3 ERROR "$RUN.log"; exit 1; }
echo "Tour passed: $(ls "$RUN/shots" | wc -l | tr -d ' ') screens in $RUN/shots"
[ "${1:-}" = baseline ] && exit 0

mkdir -p "$OUT/diff"
for shot in "$OUT/baseline/shots"/*.png; do
	name="$(basename "$shot")"
	# AE = pixels that differ by more than 2%. Two runs of the same build differ by a few hundred pixels at most.
	result="$(magick compare -metric AE -fuzz 2% "$shot" "$RUN/shots/$name" "$OUT/diff/$name" 2>&1 >/dev/null || true)"
	printf '%-24s %s\n' "$name" "$result"
done
echo "Diff images (changed pixels in red): $OUT/diff"
