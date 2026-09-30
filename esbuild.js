const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Handles native .node addons: copies them to dist/ and rewrites require() to load from there.
 * This lets esbuild bundle the JS parts of packages like ssh2/cpu-features while keeping native
 * bindings working — no need to ship node_modules or track transitive deps in .vscodeignore.
 * @type {import('esbuild').Plugin}
 */
const nativeNodeModulesPlugin = {
	name: 'native-node-modules',
	setup(build) {
		const copiedFiles = new Map();

		build.onResolve({ filter: /\.node$/ }, (args) => {
			const absPath = path.resolve(args.resolveDir, args.path);
			if (!fs.existsSync(absPath)) return;

			const basename = path.basename(absPath);
			let destName = basename;
			let counter = 1;
			while (copiedFiles.has(destName) && copiedFiles.get(destName) !== absPath) {
				destName = basename.replace('.node', `_${counter++}.node`);
			}
			copiedFiles.set(destName, absPath);

			return {
				path: './' + destName,
				external: true,
			};
		});

		build.onEnd(() => {
			for (const [destName, srcPath] of copiedFiles) {
				const destPath = path.join(build.initialOptions.outdir || 'dist', destName);
				fs.copyFileSync(srcPath, destPath);
			}
		});
	}
};

/**
 * node-sqlite3-wasm (SQLite fallback when @vscode/sqlite3 cannot load) reads its .wasm from
 * the directory of the bundle that includes it: copy the .wasm next to each such bundle.
 * @type {import('esbuild').Plugin}
 */
const sqliteWasmPlugin = {
	name: 'sqlite-wasm',
	setup(build) {
		build.onEnd((result) => {
			const wasm = require.resolve('node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm');
			for (const [output, { inputs }] of Object.entries(result.metafile?.outputs ?? {})) {
				if (Object.keys(inputs).some((input) => input.includes('node-sqlite3-wasm'))) {
					fs.copyFileSync(wasm, path.join(path.dirname(output), path.basename(wasm)));
				}
			}
		});
	}
};

async function main () {
	const ctx = await esbuild.context({
		entryPoints: ['src/extension.ts', 'src/services/mcp/no-vscode/server.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outdir: 'dist',
		entryNames: '[dir]/[name]',

		/**
		 * Reasons for externalizing:
		 *  - vscode: not a typical npm package - injected by the IDE at runtime
		 *  - @vscode/sqlite3: has native bindings loaded via node-gyp-build (complex dynamic require)
		 *  - @duckdb/node-api: optional native driver resolved at runtime; its per-platform
		 *    .node bindings can't be bundled and must be loaded from node_modules
		 */
		external: ['vscode', '@vscode/sqlite3', 'better-sqlite3', '@duckdb/node-api'],
		define: {
			'process.env.DEVDB_LICENSE_API_BASE': JSON.stringify(
				production
					? 'https://devdbpro.com/api/license'
					: (process.env.DEVDB_LICENSE_API_BASE || 'https://devdbpro.test/api/license')
			),
		},

		metafile: true,
		logLevel: 'warning',
		plugins: [
			nativeNodeModulesPlugin,
			sqliteWasmPlugin,
			esbuildProblemMatcherPlugin
		]
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup (build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd(result => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location == null) return;
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});

			console.log('[watch] build finished');
		});
	}
};

main().catch(e => {
	console.error(e);
	process.exit(1);
});
