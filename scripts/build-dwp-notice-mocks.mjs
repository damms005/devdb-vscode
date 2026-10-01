#!/usr/bin/env node
/**
 * Builds the DevWorkspace Pro showcase mocks for the IDE notice
 * (resources/notices/devworkspacepro/mocks/*.html + mocks.css).
 * Hand-written mocks (ai-launcher*, git-changes*, files*, terminal* and the *-imported / *-any-project overview and status bar) are styled in notice.css, terminal.css or by mocks.css classes; this script leaves them alone.
 *
 * 1. Render the site's Blade mocks to HTML (in a scratch copy of the devworkspacepro.com repo):
 *      php artisan tinker --execute 'file_put_contents("out/focus-pad.html", Blade::render("<x-mock-ui.focus-pad />"));'
 *    One file per mock name below, into <rendered-dir>.
 * 2. node scripts/build-dwp-notice-mocks.mjs <rendered-dir> <tailwind-cli-dir>
 *    <tailwind-cli-dir> holds node_modules with @tailwindcss/cli and tailwindcss v4.
 *
 * The webview CSP forbids inline style attributes, so each `style="…"` becomes a class.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MOCKS = ['overview', 'status-bar', 'focus-pad', 'voice-to-text', 'github-issues', 'scratchpad'];

const [renderedDir, tailwindDir] = process.argv.slice(2);
if (!renderedDir || !tailwindDir) {
	console.error('Usage: build-dwp-notice-mocks.mjs <rendered-dir> <tailwind-cli-dir>');
	process.exit(1);
}

const outDir = resolve('resources/notices/devworkspacepro');
const mocksDir = join(outDir, 'mocks');
mkdirSync(mocksDir, { recursive: true });

const styleRules = new Map();
/** `<style>` blocks move to mocks.css: the CSP allows only nonce'd or file styles. */
const styleBlocks = new Set();

function styleClass(style) {
	const normalized = style.trim().replace(/\s+/g, ' ').replace(/;?\s*$/, ';');
	const name = `dwp-s-${createHash('sha1').update(normalized).digest('hex').slice(0, 8)}`;
	styleRules.set(name, normalized);
	return name;
}

function transform(html) {
	return html
		.replace(/<style>([\s\S]*?)<\/style>/gi, (_, css) => { styleBlocks.add(css.trim()); return ''; })
		.replace(/\shref="#"/g, '')
		.replace(/\s+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')
		// Display text only (no links): keep the page free of http: so the CSP test stays strict.
		.replace(/>(\s*)http:\/\/(127\.0\.0\.1|localhost)/g, '>$1$2')
		.replace(/>(\s*)http:\/\//g, '>$1https://')
		.replace(/<([a-z][a-z0-9-]*)(\s[^>]*?)?>/gi, (tag, name, attrs = '') => {
			const style = attrs.match(/\sstyle="([^"]*)"/);
			if (!style) return tag;
			const cls = styleClass(style[1]);
			let rest = attrs.replace(style[0], '');
			rest = /\sclass="/.test(rest) ? rest.replace(/\sclass="([^"]*)"/, (_, c) => ` class="${c} ${cls}"`) : `${rest} class="${cls}"`;
			return `<${name}${rest}>`;
		})
		.replace(/\n\s*\n/g, '\n')
		.trim() + '\n';
}

for (const mock of MOCKS) {
	const html = transform(readFileSync(join(renderedDir, `${mock}.html`), 'utf8'));
	if (/<script|<style|\son[a-z]+=|\sstyle="|\sx-[a-z]+[=\s>]|http:/i.test(html)) {
		throw new Error(`${mock}: script, inline handler, inline style, Alpine attribute or http: left after transform`);
	}
	writeFileSync(join(mocksDir, `${mock}.html`), html);
}

const appColors = ['background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'secondary', 'secondary-foreground',
	'muted', 'muted-foreground', 'accent', 'accent-foreground', 'border', 'input', 'overlay', 'elevated', 'primary', 'primary-foreground', 'ring',
	'success', 'success-foreground', 'info', 'info-foreground', 'warning', 'warning-foreground', 'destructive', 'destructive-foreground',
	'highlight', 'highlight-foreground'];

// Values copied from devworkspacepro.com resources/css/app.css (:root and .dark app tokens).
const light = {
	background: '0 0% 98%', foreground: '240 10% 6%', card: '0 0% 100%', 'card-foreground': '240 10% 6%', popover: '0 0% 100%',
	'popover-foreground': '240 10% 6%', secondary: '240 5% 94%', 'secondary-foreground': '240 6% 12%', muted: '240 5% 95%',
	'muted-foreground': '240 4% 44%', accent: '240 5% 93%', 'accent-foreground': '240 6% 10%', border: '240 6% 90%', input: '240 6% 87%',
	overlay: '240 10% 4%', elevated: '0 0% 100%', primary: '142 64% 31%', 'primary-foreground': '0 0% 100%', ring: '142 64% 31%',
	success: '142 64% 31%', 'success-foreground': '0 0% 100%', info: '217 80% 46%', 'info-foreground': '0 0% 100%', warning: '30 92% 36%',
	'warning-foreground': '0 0% 100%', destructive: '0 72% 45%', 'destructive-foreground': '0 0% 100%', highlight: '262 62% 52%',
	'highlight-foreground': '0 0% 100%',
};
const dark = {
	background: '240 6% 7%', foreground: '0 0% 95%', card: '240 5% 10%', 'card-foreground': '0 0% 95%', popover: '240 5% 11%',
	'popover-foreground': '0 0% 95%', secondary: '240 4% 16%', 'secondary-foreground': '0 0% 95%', muted: '240 4% 14%',
	'muted-foreground': '240 5% 64%', accent: '240 4% 16%', 'accent-foreground': '0 0% 95%', border: '240 4% 18%', input: '240 4% 22%',
	overlay: '240 10% 2%', elevated: '240 4% 24%', primary: '142 60% 48%', 'primary-foreground': '240 6% 7%', ring: '142 60% 48%',
	success: '142 60% 48%', 'success-foreground': '240 6% 7%', info: '213 90% 65%', 'info-foreground': '240 6% 7%', warning: '38 92% 56%',
	'warning-foreground': '240 6% 7%', destructive: '0 78% 63%', 'destructive-foreground': '240 6% 7%', highlight: '262 85% 74%',
	'highlight-foreground': '240 6% 7%',
};
const vars = values => Object.entries(values).map(([k, v]) => `--app-${k}: ${v};`).join(' ');

const input = `@layer theme, base, utilities;
@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/utilities.css' layer(utilities) source(none);
@source '${mocksDir}';

@theme inline {
${appColors.map(c => `\t--color-app-${c}: hsl(var(--app-${c}));`).join('\n')}
}
@theme {
	--radius-lg: 0.5rem;
	--radius-md: calc(0.5rem - 2px);
	--radius-sm: calc(0.5rem - 4px);
}

/* Mocks follow the VS Code theme (webview body classes). */
.mock-frame { ${vars(light)} }
body.vscode-dark .mock-frame, body.vscode-high-contrast:not(.vscode-high-contrast-light) .mock-frame { ${vars(dark)} }

/* Scoped preflight, layered so utilities win. */
@layer base {
	.mock-frame *, .mock-frame ::before, .mock-frame ::after { box-sizing: border-box; border: 0 solid hsl(var(--app-border)); margin: 0; padding: 0; }
	.mock-frame svg, .mock-frame img { display: block; vertical-align: middle; }
	.mock-frame h1, .mock-frame h2, .mock-frame h3, .mock-frame h4, .mock-frame h5, .mock-frame h6 { font-size: inherit; font-weight: inherit; }
	.mock-frame ol, .mock-frame ul { list-style: none; }
	.mock-frame kbd, .mock-frame code, .mock-frame pre, .mock-frame button, .mock-frame input, .mock-frame textarea { font: inherit; color: inherit; background: transparent; }
	.mock-frame a { color: inherit; text-decoration: inherit; }
}
.mock-ui { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; letter-spacing: -0.01em; -webkit-font-smoothing: antialiased; }
.mock-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }

${[...styleBlocks].join('\n')}

${[...styleRules].map(([name, rule]) => `.${name} { ${rule} }`).join('\n')}
`;

const inputPath = join(tailwindDir, 'dwp-mocks.input.css');
writeFileSync(inputPath, input);
execFileSync(join(tailwindDir, 'node_modules/.bin/tailwindcss'), ['-i', inputPath, '-o', join(outDir, 'mocks.css'), '--minify'], { stdio: 'inherit' });
console.log(`Wrote ${MOCKS.length} mocks and mocks.css to ${outDir}`);
