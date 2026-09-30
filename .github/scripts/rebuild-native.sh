#!/usr/bin/env bash
# Rebuilds the node-gyp addons in node_modules for one VSIX target, after `bun install`.
#
# `bun install` compiles addons for the runner and ignores npm_config_arch on Linux, so
# linux-arm64/armhf got x86-64 binaries and alpine got glibc binaries. This script compiles
# them in a container of the target platform (Linux) or cross-compiles them (win32-arm64).
#
#   @vscode/sqlite3  required. N-API, so a build with Node 20 loads in VS Code's extension host.
#   ssh2 (sshcrypto), cpu-features
#                    optional. NAN (ABI-specific), so they do not load in VS Code's Node in any
#                    case and ssh2 falls back to JS. They are rebuilt only so that the VSIX has no
#                    binary for the wrong platform. If a build fails, the binary is removed.
#
# darwin-*, win32-x64: no-op (node-gyp already builds for npm_config_arch there).
# universal (""): same build as linux-x64. Only Linux x64 (glibc) gets working SQLite from it.
#
# Usage: .github/scripts/rebuild-native.sh <target>
set -euo pipefail

target="${1:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Multi-arch index digests. glibc 2.31 (bullseye) for wide compatibility.
bullseye='node:20-bullseye@sha256:c0122351f25f04facee976f9db7214789eabadb489f4e4aea9cd00a0d6af77c4'
alpine='node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293'

case "$target" in
	linux-x64|'') image=$bullseye platform=linux/amd64 ;;
	linux-arm64)  image=$bullseye platform=linux/arm64 ;;
	linux-armhf)  image=$bullseye platform=linux/arm/v7 ;;
	alpine-x64)   image=$alpine   platform=linux/amd64 ;;
	alpine-arm64) image=$alpine   platform=linux/arm64 ;;
	win32-arm64)  image='' platform='' ;;
	darwin-x64 | darwin-arm64 | win32-x64)
		echo "No rebuild for target '$target'."
		exit 0 ;;
	*)
		echo "Unknown target '$target'" >&2
		exit 1 ;;
esac

# Runs in the repo root, in the container (sh) or on the runner (bash). $1 = extra node-gyp args.
# Single quotes: the build shell expands the variables, not this one.
# shellcheck disable=SC2016
build_script='
set -e
gyp="node $(node -p "require(\"path\").resolve(\"node_modules/node-gyp/bin/node-gyp.js\")")"
args="$1 --loglevel=warn"
echo "Building @vscode/sqlite3"
(cd node_modules/@vscode/sqlite3 && $gyp rebuild $args)
if [ -d node_modules/ssh2/lib/protocol/crypto ]; then
	echo "Building ssh2 sshcrypto (optional)"
	ssl=$(node -p "process.versions.openssl.split(\".\")[0]")
	(cd node_modules/ssh2/lib/protocol/crypto && $gyp rebuild $args --real_openssl_major=$ssl) \
		|| { echo "sshcrypto build failed: removing it (ssh2 uses JS)"; rm -rf node_modules/ssh2/lib/protocol/crypto/build; }
fi
if [ -d node_modules/cpu-features ]; then
	echo "Building cpu-features (optional)"
	(cd node_modules/cpu-features && node buildcheck.js > buildcheck.gypi && $gyp rebuild $args) \
		|| { echo "cpu-features build failed: removing it (ssh2 works without it)"; rm -rf node_modules/cpu-features; }
fi
'

if [ "$target" = win32-arm64 ]; then
	cd "$root"
	bash -c "$build_script" build --arch=arm64
	exit 0
fi

# Root in the container (apk needs it), then give the files back to the runner user.
docker run --rm --platform "$platform" -v "$root":/work -w /work \
	-e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e BUILD_SCRIPT="$build_script" \
	"$image" sh -ec '
		trap "chown -R \$HOST_UID:\$HOST_GID node_modules/@vscode/sqlite3 node_modules/ssh2 node_modules/cpu-features 2>/dev/null || true" EXIT
		if [ -f /etc/alpine-release ]; then apk add --no-cache python3 make g++ >/dev/null; fi
		echo "Container: $(uname -m), $(node -v), $(ldd --version 2>&1 | head -n1)"
		sh -ec "$BUILD_SCRIPT" build --nodedir=/usr/local
		# Remove debug info (Alpine builds keep it): smaller VSIX, same dynamic symbols.
		find node_modules/@vscode/sqlite3/build node_modules/ssh2/lib/protocol/crypto/build node_modules/cpu-features/build \
			-name "*.node" -exec strip --strip-unneeded {} + 2>/dev/null || true
		find node_modules/@vscode/sqlite3/build -name "*.node" -exec ls -l {} +
	'
