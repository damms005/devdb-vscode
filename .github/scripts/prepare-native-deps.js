#!/usr/bin/env node
/**
 * Puts the correct DuckDB native binding into node_modules for one VSIX target.
 *
 * `bun install` installs the optional binding for the HOST (and ignores npm_config_arch),
 * so a darwin-x64 VSIX built on an arm64 runner would ship the arm64 binding.
 * This script removes every @duckdb/node-bindings-* package, then downloads the binding
 * for the target at the exact version the lockfile pins and checks its integrity.
 *
 * Usage:
 *   node .github/scripts/prepare-native-deps.js <target>   # e.g. linux-x64, alpine-arm64
 *   node .github/scripts/prepare-native-deps.js ""         # universal VSIX: no binding
 *   node .github/scripts/prepare-native-deps.js --verify <target> <file.vsix>
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DUCKDB_SCOPE = path.join(ROOT, 'node_modules', '@duckdb');

/** VS Code target -> @duckdb/node-bindings-<suffix>. null = DuckDB not supported. */
const DUCKDB_BINDINGS = {
	'win32-x64': 'win32-x64',
	'win32-arm64': 'win32-arm64',
	'linux-x64': 'linux-x64',
	'linux-arm64': 'linux-arm64',
	'linux-armhf': null,
	'alpine-x64': 'linux-x64-musl',
	'alpine-arm64': 'linux-arm64-musl',
	'darwin-x64': 'darwin-x64',
	'darwin-arm64': 'darwin-arm64',
	'': null,
};

function bindingFor(target) {
	if (!(target in DUCKDB_BINDINGS)) {
		throw new Error(`Unknown target '${target}'. Known: ${Object.keys(DUCKDB_BINDINGS).filter(Boolean).join(', ')}`);
	}
	const suffix = DUCKDB_BINDINGS[target];
	return suffix ? `@duckdb/node-bindings-${suffix}` : null;
}

function pinnedVersion(pkgName) {
	const bindings = JSON.parse(fs.readFileSync(path.join(DUCKDB_SCOPE, 'node-bindings', 'package.json'), 'utf8'));
	const version = (bindings.optionalDependencies || {})[pkgName];
	if (!version) {
		throw new Error(`${pkgName} is not an optional dependency of @duckdb/node-bindings@${bindings.version}`);
	}
	return version;
}

function lockfileIntegrity(pkgName, version) {
	const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
	const entry = lock.packages[`node_modules/${pkgName}`];
	if (!entry || entry.version !== version) {
		throw new Error(`package-lock.json does not pin ${pkgName}@${version}`);
	}
	return entry.integrity;
}

function prepare(target) {
	for (const dir of fs.readdirSync(DUCKDB_SCOPE)) {
		if (dir.startsWith('node-bindings-')) {
			fs.rmSync(path.join(DUCKDB_SCOPE, dir), { recursive: true, force: true });
			console.log(`Removed @duckdb/${dir}`);
		}
	}

	const pkgName = bindingFor(target);
	if (!pkgName) {
		console.log(`No DuckDB binding for target '${target || 'universal'}'. The VSIX ships without one.`);
		return;
	}

	const version = pinnedVersion(pkgName);
	const expectedIntegrity = lockfileIntegrity(pkgName, version);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duckdb-binding-'));
	const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const packed = JSON.parse(
		execFileSync(npm, ['pack', `${pkgName}@${version}`, '--json', '--pack-destination', tmp], {
			encoding: 'utf8',
			shell: process.platform === 'win32',
		})
	)[0];

	if (packed.integrity !== expectedIntegrity) {
		throw new Error(`Integrity mismatch for ${pkgName}@${version}: got ${packed.integrity}, lockfile has ${expectedIntegrity}`);
	}

	const dest = path.join(DUCKDB_SCOPE, pkgName.split('/')[1]);
	fs.mkdirSync(dest, { recursive: true });
	// Use the `tar` package (a dependency of @vscode/sqlite3) instead of the tar CLI: Git Bash's GNU tar on
	// Windows runners treats `C:\...` paths as remote hosts.
	require(path.join(ROOT, 'node_modules', 'tar')).x({ file: path.join(tmp, packed.filename), cwd: dest, strip: 1, sync: true });
	fs.rmSync(tmp, { recursive: true, force: true });

	if (!fs.existsSync(path.join(dest, 'duckdb.node'))) {
		throw new Error(`${pkgName}@${version} has no duckdb.node`);
	}
	console.log(`Installed ${pkgName}@${version} for target '${target}'`);
}

function verify(target, vsixPath) {
	const listing = execFileSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/);
	const nodeFiles = listing.filter(f => /^extension\/node_modules\/@duckdb\/node-bindings-[^/]+\/duckdb\.node$/.test(f));
	const pkgName = bindingFor(target);
	const expected = pkgName ? [`extension/node_modules/${pkgName}/duckdb.node`] : [];

	const ok = nodeFiles.length === expected.length && expected.every(f => nodeFiles.includes(f));
	console.log(`DuckDB bindings in ${vsixPath}: ${nodeFiles.length ? nodeFiles.join(', ') : '(none)'}`);
	if (!ok) {
		console.error(`Expected: ${expected.length ? expected.join(', ') : '(none)'}`);
		process.exit(1);
	}

	for (const required of ['extension/node_modules/@duckdb/node-api/package.json', 'extension/node_modules/@duckdb/node-bindings/duckdb.js']) {
		if (!listing.includes(required)) {
			console.error(`Missing ${required}`);
			process.exit(1);
		}
	}
	if (pkgName && !listing.includes('extension/node_modules/detect-libc/package.json')) {
		console.error('Missing extension/node_modules/detect-libc (required by @duckdb/node-bindings)');
		process.exit(1);
	}
	console.log('VSIX native dependency check passed.');
}

const args = process.argv.slice(2);
if (args[0] === '--verify') {
	verify(args[1] || '', args[2]);
} else {
	prepare(args[0] || '');
}
