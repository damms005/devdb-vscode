import { _electron as electron } from "playwright-core";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SKILL = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SKILL, "../../..");
const WORK = process.env.DEVDB_DRIVER_DIR ?? path.join(os.tmpdir(), "devdb-driver");
const SHOTS = path.join(WORK, "shots");
const PROFILE = path.join(WORK, "profile");
const EXTS = path.join(WORK, "exts");
const LOG = path.join(WORK, "main.log");
const BRIDGE_FILE = path.join(WORK, "bridge.port");
const MOCK_LOG = path.join(WORK, "license-mock.log");
const STACK = path.join(SKILL, "local-datastores");
const WORKSPACE = path.resolve(process.env.DEVDB_WORKSPACE ?? path.join(STACK, "workspace"));
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const EXTENSION_ID = "damms005.devdb";

const DRIVER_SETTINGS = {
	"workbench.startupEditor": "none",
	"workbench.tips.enabled": false,
	"workbench.enableExperiments": false,
	"workbench.secondarySideBar.defaultVisibility": "hidden",
	"window.restoreWindows": "none",
	"update.mode": "none",
	"telemetry.telemetryLevel": "off",
	"extensions.autoCheckUpdates": false,
	"extensions.autoUpdate": false,
	"security.workspace.trust.enabled": false,
	"chat.disableAIFeatures": true,
	"git.enabled": false,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function prepareProfile() {
	if (process.env.DEVDB_FRESH_PROFILE) fs.rmSync(PROFILE, { recursive: true, force: true });
	fs.mkdirSync(path.join(PROFILE, "User"), { recursive: true });
	fs.mkdirSync(EXTS, { recursive: true });
	const file = path.join(PROFILE, "User", "settings.json");
	let settings = {};
	try {
		settings = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {}
	fs.writeFileSync(file, JSON.stringify({ ...settings, ...DRIVER_SETTINGS }, null, "\t"));
}

function prepareWorkspace() {
	const template = path.join(STACK, "workspace", ".devdbrc.template");
	const target = path.join(STACK, "workspace", ".devdbrc");
	if (WORKSPACE === path.join(STACK, "workspace") && !fs.existsSync(target) && fs.existsSync(template)) {
		fs.writeFileSync(target, fs.readFileSync(template, "utf8").replaceAll("__DATA_DIR__", path.join(STACK, "data")));
	}
	if (!fs.existsSync(WORKSPACE)) throw new Error(`workspace not found: ${WORKSPACE}`);
	// The Neon provider connects to any *.neon.tech host in .env at startup. Without an /etc/hosts entry
	// that host resolves to real Neon, so test credentials would leave this machine.
	const env = path.join(WORKSPACE, ".env");
	const hosts = fs.existsSync("/etc/hosts") ? fs.readFileSync("/etc/hosts", "utf8") : "";
	for (const host of fs.existsSync(env) ? (fs.readFileSync(env, "utf8").match(/[\w.-]+\.neon\.tech/g) ?? []) : []) {
		if (!new RegExp(`^\\s*127\\.0\\.0\\.1\\s+.*\\b${host.replaceAll(".", "\\.")}\\b`, "m").test(hosts)) {
			process.stdout.write(`NEON_HOST_NOT_LOCAL ${host} is not mapped to 127.0.0.1 in /etc/hosts. Stopped before launch.\n`);
			process.exit(2);
		}
	}
}

// The license API base is compiled into dist/extension.js by esbuild.js. The driver never talks to production:
// it only answers license calls itself when the build points at a loopback address.
function licenseApi() {
	const bundle = path.join(REPO, "dist", "extension.js");
	if (!fs.existsSync(bundle)) throw new Error(`no build at ${bundle}: run "node esbuild.js" in the repo root first`);
	const match = fs.readFileSync(bundle, "utf8").match(/https?:\/\/[^"'`\s]+\/api\/license/);
	return match?.[0] ?? "unknown";
}

async function startLicenseMock(base) {
	const url = new URL(base);
	if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol !== "http:") return "no";
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			fs.appendFileSync(MOCK_LOG, `${new Date().toISOString()} ${req.method} ${req.url} ${body}\n`);
			let input = {};
			try {
				input = JSON.parse(body || "{}");
			} catch {}
			const expires_at = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
			const valid = /^DEVDB[MY]-/.test(input.license ?? "");
			res.writeHead(valid ? 200 : 422, { "content-type": "application/json" });
			if (!valid) return res.end(JSON.stringify({ message: "Invalid license (local mock)" }));
			if (req.url.endsWith("/activate")) return res.end(JSON.stringify({ status: "granted", expires_at, message: "License activated (local mock)" }));
			return res.end(JSON.stringify({ is_valid: true, status: "granted", expires_at }));
		});
	});
	return new Promise((resolve) => {
		server.once("error", () => resolve("shared"));
		server.listen(Number(url.port) || 80, url.hostname, () => {
			server.unref();
			resolve("yes");
		});
	});
}

async function launch() {
	fs.mkdirSync(SHOTS, { recursive: true });
	fs.writeFileSync(LOG, "");
	fs.rmSync(BRIDGE_FILE, { force: true });
	prepareProfile();
	prepareWorkspace();
	const api = licenseApi();
	const mock = await startLicenseMock(api);

	let executablePath = await downloadAndUnzipVSCode({ version: process.env.DEVDB_VSCODE_VERSION ?? "stable", cachePath: path.join(REPO, ".vscode-test") });
	// New macOS builds name the binary "Code"; @vscode/test-electron still returns ".../MacOS/Electron".
	if (!fs.existsSync(executablePath) && fs.existsSync(path.join(path.dirname(executablePath), "Code"))) executablePath = path.join(path.dirname(executablePath), "Code");
	const app = await electron.launch({
		executablePath,
		args: [
			WORKSPACE,
			`--extensionDevelopmentPath=${REPO}`,
			`--extensionDevelopmentPath=${path.join(SKILL, "bridge")}`,
			"--disable-extensions",
			`--user-data-dir=${PROFILE}`,
			`--extensions-dir=${EXTS}`,
			"--skip-welcome",
			"--skip-release-notes",
			"--disable-workspace-trust",
			"--use-inmemory-secretstorage",
			"--disable-telemetry",
			"--new-window",
			// No "-ApplePersistenceIgnoreState YES" here: the VS Code CLI parser reads it as short flags (-s = --status) and quits.
		],
		cwd: WORKSPACE,
		env: { ...process.env, DEVDB_DRIVER_BRIDGE_FILE: BRIDGE_FILE },
		timeout: 90_000,
	});
	app.process().stdout.on("data", (d) => fs.appendFileSync(LOG, d));
	app.process().stderr.on("data", (d) => fs.appendFileSync(LOG, d));

	const page = await app.firstWindow({ timeout: 60_000 });
	if (!process.env.DEVDB_FOREGROUND) await hideWindow(app);
	await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
	const deadline = Date.now() + 30_000;
	while (!fs.existsSync(BRIDGE_FILE) && Date.now() < deadline) await sleep(300);
	return { app, page, api, mock, webview: "view" };
}

// macOS: hide the app (as after Cmd+H) and show the window inactive, so it never covers other apps
// but still renders. Windows/Linux: minimize without focus. Rendering continues with throttling off.
async function hideWindow(app) {
	await app
		.evaluate(({ app: electronApp, BrowserWindow }, platform) => {
			for (const win of BrowserWindow.getAllWindows()) {
				win.webContents.setBackgroundThrottling(false);
				if (platform === "darwin") {
					electronApp.hide();
					win.showInactive();
					electronApp.hide();
				} else {
					win.minimize();
				}
			}
		}, process.platform)
		.catch((error) => fs.appendFileSync(LOG, `hideWindow failed: ${error.message}\n`));
}

async function bridge(route, payload) {
	if (!fs.existsSync(BRIDGE_FILE)) throw new Error("bridge extension is not running (see log)");
	const port = fs.readFileSync(BRIDGE_FILE, "utf8").trim();
	const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", body: JSON.stringify(payload) });
	const data = await res.json();
	if (!data.ok) throw new Error(data.error);
	return data.result;
}

// Webviews are nested iframes: iframe.webview (outer, URL has extensionId + purpose) > iframe#active-frame (content).
async function webviewFrames(page) {
	const out = [];
	for (const outer of page.frames()) {
		const url = outer.url();
		if (!url.startsWith("vscode-webview://") || !url.includes("index.html")) continue;
		const params = new URL(url).searchParams;
		for (const inner of outer.childFrames()) {
			const title = await inner.evaluate(() => document.title).catch(() => null);
			if (title === null) continue;
			out.push({ frame: inner, extensionId: params.get("extensionId"), purpose: params.get("purpose"), title });
		}
	}
	return out;
}

async function webviewFrame(ctx, timeout = 15_000) {
	const deadline = Date.now() + timeout;
	while (true) {
		const frames = (await webviewFrames(ctx.page)).filter((f) => f.extensionId === EXTENSION_ID);
		const target = ctx.webview;
		const match =
			target === "view"
				? frames.find((f) => f.purpose === "webviewView")
				: target === "editor"
					? frames.find((f) => f.purpose !== "webviewView")
					: frames.find((f) => f.title.includes(target));
		if (match) return match.frame;
		if (Date.now() > deadline) throw new Error(`no DevDb webview "${target}" (open: ${frames.map((f) => `${f.purpose}:${f.title}`).join(", ") || "none"})`);
		await sleep(300);
	}
}

function clickByText(text) {
	const candidates = [...document.querySelectorAll("*")].filter((el) => el.children.length <= 3 && el.getClientRects().length > 0);
	const el = candidates.find((e) => e.textContent?.trim() === text) ?? candidates.find((e) => e.textContent?.trim().startsWith(text));
	if (!el) return "NOT_FOUND";
	(el.closest("a,button,[role=button],[role=tab],[role=option],[role=menuitem],[role=treeitem],li,.cursor-pointer") ?? el).click();
	return `OK ${el.tagName}`;
}

function found(result, target) {
	if (result === "NOT_FOUND") throw new Error(`"${target}" not found`);
	return result;
}

async function waitFor(fn, timeout = 60_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await fn().catch(() => false)) return true;
		await sleep(300);
	}
	return false;
}

async function quickInput(page, prefix, text) {
	await page.keyboard.press(`${MOD}+Shift+P`);
	const input = page.locator(".quick-input-widget .quick-input-box input");
	await input.waitFor({ timeout: 10_000 });
	await input.fill(`${prefix}${text}`);
	await sleep(400);
	const first = await page.locator(".quick-input-widget .quick-input-list .monaco-list-row").first().getAttribute("aria-label").catch(() => null);
	if (!first) {
		await page.keyboard.press("Escape");
		throw new Error(`no palette entry for "${text}"`);
	}
	await input.press("Enter");
	return `OK ${first}`;
}

function logFile(kind) {
	const logs = path.join(PROFILE, "logs");
	if (!fs.existsSync(logs)) return null;
	const session = fs.readdirSync(logs).sort().at(-1);
	const exthost = path.join(logs, session, "window1", "exthost");
	if (kind === "exthost") return path.join(exthost, "exthost.log");
	if (kind === "renderer") return path.join(logs, session, "window1", "renderer.log");
	if (!fs.existsSync(exthost)) return null;
	for (const dir of fs.readdirSync(exthost).filter((d) => d.startsWith("output_logging_")).sort().reverse()) {
		const hit = fs.readdirSync(path.join(exthost, dir)).find((f) => f.endsWith("-DevDb.log"));
		if (hit) return path.join(exthost, dir, hit);
	}
	return null;
}

function tail(file, lines) {
	if (!file || !fs.existsSync(file)) return "NO_LOG";
	return fs.readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
}

async function run(ctx, cmd, arg) {
	const { page } = ctx;
	switch (cmd) {
		case "shot": {
			const file = path.join(SHOTS, `${arg || Date.now()}.png`);
			await page.screenshot({ path: file });
			return file;
		}
		case "text":
			return (await page.evaluate(() => document.body.innerText)).slice(0, Number(arg) || 2000);
		case "click":
			return found(await page.evaluate(clickByText, arg), arg);
		case "click-css":
			await page.locator(arg).first().click({ timeout: 10_000 });
			return "OK";
		case "type":
			await page.keyboard.type(arg, { delay: 30 });
			return "OK";
		case "key":
			await page.keyboard.press(arg.replaceAll("Mod+", `${MOD}+`));
			return "OK";
		case "assert": {
			const ok = await page.evaluate((t) => document.body.innerText.includes(t), arg);
			if (!ok) throw new Error(`assert failed: "${arg}" not on screen`);
			return "OK";
		}
		case "wait-text":
			if (!(await waitFor(() => page.evaluate((t) => document.body.innerText.includes(t), arg)))) throw new Error(`timeout waiting for "${arg}"`);
			return "OK";
		case "eval":
			return page.evaluate(arg);
		case "host-eval":
			return bridge("/eval", { code: arg });
		case "palette":
			return quickInput(page, ">", arg);
		case "exec": {
			const space = arg.indexOf(" ");
			const id = space < 0 ? arg : arg.slice(0, space);
			const args = space < 0 ? [] : JSON.parse(arg.slice(space + 1));
			bridge("/exec", { command: id, args: Array.isArray(args) ? args : [args] }).catch((error) => fs.appendFileSync(LOG, `exec ${id} failed: ${error.message}\n`));
			await sleep(500);
			return "OK";
		}
		case "exec-wait": {
			const space = arg.indexOf(" ");
			const id = space < 0 ? arg : arg.slice(0, space);
			const args = space < 0 ? [] : JSON.parse(arg.slice(space + 1));
			return bridge("/exec", { command: id, args: Array.isArray(args) ? args : [args] });
		}
		case "panel":
			await bridge("/exec", { command: "devdb.focus", args: [] });
			if (arg === "max") await bridge("/exec", { command: "workbench.action.toggleMaximizedPanel", args: [] });
			ctx.webview = "view";
			await webviewFrame(ctx, 30_000);
			return "OK";
		case "license": {
			if (ctx.mock === "no") throw new Error(`build uses ${ctx.api}; rebuild with DEVDB_LICENSE_API_BASE=http://127.0.0.1:47181/api/license node esbuild.js`);
			bridge("/exec", { command: "devdb.license.manage", args: [] }).catch(() => {});
			const input = page.locator('.quick-input-widget .quick-input-box input[placeholder^="DEVDB"]');
			await input.waitFor({ timeout: 15_000 });
			await sleep(300);
			await input.fill(arg || "DEVDBM-LOCAL-TEST");
			await input.press("Enter");
			if (!(await waitFor(() => page.evaluate(() => document.body.innerText.includes("License activated")), 20_000))) throw new Error("no activation message (see license-mock.log)");
			await bridge("/exec", { command: "workbench.action.webview.reloadWebviewAction", args: [] });
			return "OK";
		}
		case "webview":
			ctx.webview = arg || "view";
			await webviewFrame(ctx);
			return `OK target=${ctx.webview}`;
		case "webviews":
			return (await webviewFrames(page)).map((f) => `${f.extensionId} ${f.purpose} "${f.title}"`);
		case "webview-text":
			return (await (await webviewFrame(ctx)).evaluate(() => document.body.innerText)).slice(0, Number(arg) || 3000);
		case "webview-click":
			return found(await (await webviewFrame(ctx)).evaluate(clickByText, arg), arg);
		case "webview-click-css": {
			// DOM click: VS Code toasts float above the webview and would catch a mouse click.
			const el = (await webviewFrame(ctx)).locator(arg).first();
			await el.waitFor({ timeout: 10_000 });
			await el.evaluate((node) => node.click());
			return "OK";
		}
		case "webview-fill": {
			const [target, value] = Array.isArray(arg) ? arg : [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)];
			const frame = await webviewFrame(ctx);
			const field = target.startsWith("css:") ? frame.locator(target.slice(4)).first() : frame.getByPlaceholder(target, { exact: true }).or(frame.getByLabel(target)).first();
			await field.fill(value, { timeout: 10_000 });
			return "OK";
		}
		case "webview-type":
			await (await webviewFrame(ctx)).locator(":focus").pressSequentially(arg, { delay: 30 });
			return "OK";
		case "webview-key":
			await (await webviewFrame(ctx)).locator(":focus").press(arg);
			return "OK";
		case "webview-eval":
			return (await webviewFrame(ctx)).evaluate(arg);
		case "webview-assert": {
			const ok = await (await webviewFrame(ctx)).evaluate((t) => document.body.innerText.includes(t), arg);
			if (!ok) throw new Error(`webview-assert failed: "${arg}" not in webview`);
			return "OK";
		}
		case "webview-wait": {
			const ok = await waitFor(async () => (await webviewFrame(ctx)).evaluate((t) => document.body.innerText.includes(t), arg));
			if (!ok) throw new Error(`timeout waiting for "${arg}" in webview`);
			return "OK";
		}
		case "quickpick":
			return page.evaluate(() => [...document.querySelectorAll(".quick-input-widget .quick-input-list .monaco-list-row")].map((r) => r.getAttribute("aria-label")));
		case "quickpick-select": {
			const row = page.locator(".quick-input-widget .quick-input-list .monaco-list-row", { hasText: arg }).first();
			await row.click({ timeout: 10_000 });
			return "OK";
		}
		case "editor-tabs":
			return page.evaluate(() => [...document.querySelectorAll(".tabs-container .tab")].map((t) => `${t.classList.contains("active") ? "* " : ""}${t.getAttribute("aria-label") ?? t.textContent.trim()}`));
		case "notifications":
			return page.evaluate(() =>
				[...document.querySelectorAll(".notifications-toasts .notification-list-item, .notifications-center .notification-list-item")].map((n) => {
					const message = n.querySelector(".notification-list-item-message")?.textContent.trim() ?? "";
					const buttons = [...n.querySelectorAll(".notification-list-item-buttons-container .monaco-button")].map((b) => b.textContent.trim());
					return buttons.length ? `${message} [${buttons.join(" | ")}]` : message;
				}),
			);
		case "click-notification-button": {
			const button = page.locator(".notification-list-item-buttons-container .monaco-button", { hasText: arg }).first();
			await button.click({ timeout: 10_000 });
			return "OK";
		}
		case "sleep":
			await sleep(Number(arg));
			return "OK";
		case "log": {
			const [kind = "devdb", lines = "40"] = arg.split(/\s+/).filter(Boolean);
			if (kind === "main") return tail(LOG, Number(lines));
			if (kind === "license") return tail(MOCK_LOG, Number(lines));
			return tail(logFile(kind), Number(lines));
		}
		default:
			throw new Error(`unknown command: ${cmd}`);
	}
}

function parseLine(line) {
	const trimmed = line.trim();
	const space = trimmed.indexOf(" ");
	return space < 0 ? [trimmed, ""] : [trimmed.slice(0, space), trimmed.slice(space + 1)];
}

function print(cmd, result) {
	const text = typeof result === "string" ? result : JSON.stringify(result, null, 1);
	process.stdout.write(`${cmd}> ${text}\n`);
}

const ctx = await launch();
process.stdout.write(
	`READY window="${await ctx.page.title()}" workspace=${WORKSPACE} profile=${PROFILE} bridge=${fs.existsSync(BRIDGE_FILE) ? "yes" : "no"} license_api=${ctx.api} license_mock=${ctx.mock} shots=${SHOTS} log=${LOG}\n`,
);

const batch = process.argv[2];
if (batch) {
	const steps = JSON.parse(fs.existsSync(batch) ? fs.readFileSync(batch, "utf8") : batch);
	let failed = false;
	for (const [cmd, ...args] of steps) {
		try {
			print(cmd, await run(ctx, cmd, args.length > 1 ? args.map(String) : String(args[0] ?? "")));
		} catch (error) {
			print(cmd, `ERROR ${error.message}`);
			failed = true;
			break;
		}
	}
	await ctx.app.close();
	process.exit(failed ? 1 : 0);
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
	if (!line.trim()) continue;
	const [cmd, arg] = parseLine(line);
	if (cmd === "quit") break;
	try {
		print(cmd, await run(ctx, cmd, arg));
	} catch (error) {
		print(cmd, `ERROR ${error.message}`);
	}
}
await ctx.app.close();
process.exit(0);
