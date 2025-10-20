const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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
		 *  - @vscode/sqlite3: has native bindings
		 */
		external: ['vscode', '@vscode/sqlite3'],

		metafile: true,
		logLevel: 'warning',
		plugins: [
			/* add to the end of plugins array */
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
