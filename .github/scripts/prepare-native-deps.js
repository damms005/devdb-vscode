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
 *
 * --verify also reads the header of EVERY .node file in the VSIX and fails if its OS, CPU or libc
 * does not match the target (ELF e_machine + DT_NEEDED libc, PE machine, Mach-O cputype).
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

/** VS Code target -> expected native binary. The universal VSIX ships the linux-x64 (glibc) binaries. */
const NATIVE_TARGETS = {
	'win32-x64': { format: 'pe', arch: 'x64' },
	'win32-arm64': { format: 'pe', arch: 'arm64' },
	'linux-x64': { format: 'elf', arch: 'x64', libc: 'glibc' },
	'linux-arm64': { format: 'elf', arch: 'arm64', libc: 'glibc' },
	'linux-armhf': { format: 'elf', arch: 'arm', libc: 'glibc' },
	'alpine-x64': { format: 'elf', arch: 'x64', libc: 'musl' },
	'alpine-arm64': { format: 'elf', arch: 'arm64', libc: 'musl' },
	'darwin-x64': { format: 'macho', arch: 'x64' },
	'darwin-arm64': { format: 'macho', arch: 'arm64' },
	'': { format: 'elf', arch: 'x64', libc: 'glibc' },
};

const SQLITE_BINARY = 'extension/node_modules/@vscode/sqlite3/build/Release/vscode-sqlite3.node';

const ELF_MACHINES = { 0x3e: 'x64', 0xb7: 'arm64', 0x28: 'arm' };
const PE_MACHINES = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' };
const MACHO_CPUS = { 0x01000007: 'x64', 0x0100000c: 'arm64' };

/** ELF: CPU, and libc from PT_INTERP or the DT_NEEDED entries of the dynamic section. */
function describeElf(buf) {
	const is64 = buf[4] === 2;
	if (buf[5] !== 1) {
		return { format: 'elf', arch: 'big-endian', libc: 'unknown' };
	}
	const word = off => (is64 ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off));
	const machine = buf.readUInt16LE(0x12);
	const phoff = word(is64 ? 0x20 : 0x1c);
	const phentsize = buf.readUInt16LE(is64 ? 0x36 : 0x2a);
	const phnum = buf.readUInt16LE(is64 ? 0x38 : 0x2c);

	const segments = [];
	for (let i = 0; i < phnum; i++) {
		const h = phoff + i * phentsize;
		segments.push({
			type: buf.readUInt32LE(h),
			offset: word(h + (is64 ? 8 : 4)),
			vaddr: word(h + (is64 ? 16 : 8)),
			filesz: word(h + (is64 ? 32 : 16)),
		});
	}
	const cString = off => buf.toString('latin1', off, buf.indexOf(0, off));
	const toOffset = addr => {
		const load = segments.find(s => s.type === 1 && addr >= s.vaddr && addr < s.vaddr + s.filesz);
		return load ? addr - load.vaddr + load.offset : -1;
	};

	const libs = [];
	const interp = segments.find(s => s.type === 3);
	if (interp) {
		libs.push(cString(interp.offset));
	}
	const dynamic = segments.find(s => s.type === 2);
	if (dynamic) {
		const size = is64 ? 16 : 8;
		const entries = [];
		for (let off = dynamic.offset; off + size <= dynamic.offset + dynamic.filesz; off += size) {
			const tag = word(off);
			if (tag === 0) {
				break;
			}
			entries.push({ tag, val: word(off + size / 2) });
		}
		const strtab = entries.find(e => e.tag === 5);
		const strtabOffset = strtab ? toOffset(strtab.val) : -1;
		if (strtabOffset >= 0) {
			entries.filter(e => e.tag === 1).forEach(e => libs.push(cString(strtabOffset + e.val)));
		}
	}

	let libc = 'unknown';
	if (libs.some(l => /ld-musl|libc\.musl/.test(l))) {
		libc = 'musl';
	} else if (libs.some(l => /^libc\.so\.6$|ld-linux/.test(l))) {
		libc = 'glibc';
	}
	const glibcVersions = (buf.toString('latin1').match(/GLIBC_2\.\d+/g) || []).map(v => Number(v.split('.')[1]));
	return {
		format: 'elf',
		arch: ELF_MACHINES[machine] || `e_machine 0x${machine.toString(16)}`,
		libc,
		needs: libs.join(' '),
		maxGlibc: glibcVersions.length ? `2.${Math.max(...glibcVersions)}` : undefined,
	};
}

/** Returns { format, arch[, libc] } for a native binary, or null if the format is unknown. */
function describeBinary(buf) {
	if (buf.length >= 0x40 && buf.readUInt32BE(0) === 0x7f454c46) {
		return describeElf(buf);
	}
	if (buf.length >= 0x40 && buf.readUInt16LE(0) === 0x5a4d) {
		const pe = buf.readUInt32LE(0x3c);
		if (buf.readUInt32LE(pe) === 0x00004550) {
			const machine = buf.readUInt16LE(pe + 4);
			return { format: 'pe', arch: PE_MACHINES[machine] || `machine 0x${machine.toString(16)}` };
		}
	}
	if (buf.length >= 8 && buf.readUInt32LE(0) === 0xfeedfacf) {
		const cpu = buf.readUInt32LE(4);
		return { format: 'macho', arch: MACHO_CPUS[cpu] || `cputype 0x${cpu.toString(16)}` };
	}
	if (buf.length >= 8 && buf.readUInt32BE(0) === 0xcafebabe) {
		const archs = [];
		for (let i = 0; i < buf.readUInt32BE(4); i++) {
			const cpu = buf.readUInt32BE(8 + i * 20);
			archs.push(MACHO_CPUS[cpu] || `cputype 0x${cpu.toString(16)}`);
		}
		return { format: 'macho', arch: archs.join('+') };
	}
	return null;
}

function formatBinary(d) {
	if (!d) {
		return 'unknown format';
	}
	return [d.format, d.arch, d.libc].filter(Boolean).join(' ');
}

function binaryMatches(d, expected) {
	return Boolean(d)
		&& d.format === expected.format
		&& (d.format === 'macho' ? d.arch.split('+').includes(expected.arch) : d.arch === expected.arch)
		&& (!expected.libc || d.libc === expected.libc);
}

/** Checks every .node file in the VSIX against the target. Returns the number of mismatches. */
function verifyBinaries(target, vsixPath, listing) {
	const expected = NATIVE_TARGETS[target];
	const nodeFiles = listing.filter(f => f.endsWith('.node'));
	let failures = 0;
	if (!listing.includes(SQLITE_BINARY)) {
		console.error(`Missing ${SQLITE_BINARY}`);
		failures++;
	}
	console.log(`Native binaries (expected ${formatBinary(expected)} for '${target || 'universal'}'):`);
	for (const file of nodeFiles) {
		const buf = execFileSync('unzip', ['-p', vsixPath, file], { maxBuffer: 1024 * 1024 * 1024 });
		const found = describeBinary(buf);
		const ok = binaryMatches(found, expected);
		const extra = found && found.libc === 'glibc' && found.maxGlibc ? ` (needs glibc >= ${found.maxGlibc})` : '';
		(ok ? console.log : console.error)(`  ${ok ? 'ok  ' : 'FAIL'} ${file}: ${formatBinary(found)}${extra}`);
		if (!ok) {
			failures++;
		}
	}
	if (failures) {
		console.error(`${failures} native binary problem(s): each .node file must be ${formatBinary(expected)} for target '${target || 'universal'}'.`);
	}
	return failures;
}

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
	let failures = 0;

	const ok = nodeFiles.length === expected.length && expected.every(f => nodeFiles.includes(f));
	console.log(`DuckDB bindings in ${vsixPath}: ${nodeFiles.length ? nodeFiles.join(', ') : '(none)'}`);
	if (!ok) {
		console.error(`Expected: ${expected.length ? expected.join(', ') : '(none)'}`);
		failures++;
	}

	const required = ['extension/node_modules/@duckdb/node-api/package.json', 'extension/node_modules/@duckdb/node-bindings/duckdb.js'];
	if (pkgName) {
		required.push('extension/node_modules/detect-libc/package.json');
	}
	for (const file of required.filter(f => !listing.includes(f))) {
		console.error(`Missing ${file}`);
		failures++;
	}
	failures += verifyBinaries(target, vsixPath, listing);
	if (failures) {
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
