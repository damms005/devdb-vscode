import * as vscode from 'vscode';

const NOTICE_SHOWN_KEY = 'newDatastores.notice.shownForVersion';
const NOTICE_DISMISSED_KEY = 'newDatastores.notice.dismissed';

export function showNewDatastoresNotice(
	context: vscode.ExtensionContext,
	version: string,
	isNewInstall: boolean = false,
	hasLicense: boolean = false,
) {
	const isDismissed = context.globalState.get<boolean>(NOTICE_DISMISSED_KEY, false);
	if (isDismissed) {
		return;
	}

	if (!isNewInstall) {
		const shownForVersion = context.globalState.get<string>(NOTICE_SHOWN_KEY);
		if (shownForVersion === version) {
			return;
		}
	}

	context.globalState.update(NOTICE_SHOWN_KEY, version);

	setTimeout(() => {
		createNewDatastoresWebview(context, hasLicense);
	}, 1200);
}

function createNewDatastoresWebview(context: vscode.ExtensionContext, hasLicense: boolean) {
	const panel = vscode.window.createWebviewPanel(
		'devdb-new-datastores-notice',
		'New in DevDb — 5 New Databases',
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: false,
			localResourceRoots: [],
		},
	);

	panel.webview.html = getNoticeHtml(hasLicense);

	panel.iconPath = {
		light: vscode.Uri.file(context.asAbsolutePath('resources/devdb.png')),
		dark: vscode.Uri.file(context.asAbsolutePath('resources/devdb.png')),
	};

	panel.webview.onDidReceiveMessage(
		message => {
			switch (message.command) {
				case 'getLicense':
					vscode.env.openExternal(vscode.Uri.parse('https://devdbpro.com/?ref=ide&pro=true#pricing'));
					panel.dispose();
					break;
				case 'learnMore':
					vscode.env.openExternal(vscode.Uri.parse('https://devdbpro.com/?ref=ide#features'));
					break;
				case 'dontShowAgain':
					context.globalState.update(NOTICE_DISMISSED_KEY, true);
					panel.dispose();
					break;
				case 'close':
					panel.dispose();
					break;
			}
		},
		undefined,
		context.subscriptions,
	);
}

function getNoticeHtml(hasLicense: boolean): string {
	const primaryLabel = hasLicense ? 'Start Exploring' : 'Unlock with DevDb Pro';
	const primaryCommand = hasLicense ? 'close' : 'getLicense';
	const bannerTitle = hasLicense ? '✨ Included in your DevDb Pro license' : '✨ Unlock all five with DevDb Pro';
	const bannerBody = hasLicense
		? 'These new databases are ready to use — open the DevDb panel and connect.'
		: 'One-time payment · lifetime access · use on all your IDEs.';

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>New in DevDb — 5 New Databases</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
			line-height: 1.6;
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
			padding: 32px;
			max-width: 820px;
			margin: 0 auto;
		}
		.header { text-align: center; margin-bottom: 32px; }
		.title {
			font-size: 2.4em;
			font-weight: 700;
			margin-bottom: 12px;
			background: linear-gradient(135deg, var(--vscode-textLink-foreground), var(--vscode-textLink-activeForeground));
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
			background-clip: text;
		}
		.subtitle { font-size: 1.15em; opacity: 0.9; }
		.features { margin: 32px 0; }
		.features h3 { font-size: 1.3em; margin-bottom: 16px; color: var(--vscode-textLink-foreground); }
		.feature {
			display: flex;
			gap: 14px;
			padding: 14px 0;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.feature .icon { font-size: 1.6em; line-height: 1.2; flex-shrink: 0; width: 38px; text-align: center; }
		.feature .name { font-weight: 600; font-size: 1.08em; }
		.feature .desc { opacity: 0.85; font-size: 0.95em; }
		.pro-pill {
			display: inline-block;
			font-size: 0.62em;
			font-weight: 700;
			letter-spacing: 0.5px;
			padding: 2px 7px;
			border-radius: 999px;
			background: var(--vscode-editorWarning-foreground, #e2a03f);
			color: #1e1e1e;
			margin-left: 8px;
			vertical-align: middle;
		}
		.banner {
			background: var(--vscode-editor-selectionBackground, rgba(173, 214, 255, 0.15));
			padding: 22px;
			border-radius: 12px;
			text-align: center;
			margin: 28px 0;
			border: 2px solid var(--vscode-focusBorder);
		}
		.banner h3 { font-size: 1.25em; margin-bottom: 6px; font-weight: 600; }
		.banner p { opacity: 0.9; }
		.cta-section { text-align: center; margin-top: 32px; }
		.btn {
			padding: 15px 30px; margin: 8px; border: none; border-radius: 8px;
			font-size: 1.05em; font-weight: 600; cursor: pointer;
			transition: all 0.25s ease; text-decoration: none; display: inline-block;
		}
		.btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
		.btn-primary:hover { background: var(--vscode-button-hoverBackground); transform: translateY(-2px); }
		.btn-secondary { background: transparent; color: var(--vscode-textLink-foreground); border: 2px solid var(--vscode-textLink-foreground); }
		.btn-secondary:hover { background: var(--vscode-textLink-foreground); color: var(--vscode-button-foreground); transform: translateY(-2px); }
		.btn-text { background: none; color: var(--vscode-descriptionForeground); border: none; font-size: 0.9em; padding: 8px 16px; text-decoration: underline; opacity: 0.8; cursor: pointer; }
		.btn-text:hover { opacity: 1; }
		.close-btn {
			position: absolute; top: 16px; right: 16px; background: none; border: none;
			font-size: 24px; cursor: pointer; color: var(--vscode-foreground); opacity: 0.7; padding: 4px; border-radius: 4px;
		}
		.close-btn:hover { opacity: 1; background: var(--vscode-button-secondaryBackground); }
		@media (max-width: 600px) { body { padding: 16px; } .title { font-size: 1.9em; } .btn { display: block; margin: 8px 0; } }
	</style>
</head>
<body>
	<button class="close-btn" onclick="send('close')">×</button>

	<div class="header">
		<h1 class="title">5 New Databases in DevDb</h1>
		<p class="subtitle">AI-era datastores — embeddings, analytics, cache &amp; cloud Postgres, right inside your IDE.</p>
	</div>

	<div class="features">
		<h3>What's new</h3>

		<div class="feature">
			<div class="icon">🧬</div>
			<div>
				<div class="name">Vector search — pgvector<span class="pro-pill">PRO</span></div>
				<div class="desc">Inspect embedding columns humanely and run "find similar rows" right from a cell — in any Postgres or Neon database.</div>
			</div>
		</div>

		<div class="feature">
			<div class="icon">⚡</div>
			<div>
				<div class="name">Redis / Valkey<span class="pro-pill">PRO</span></div>
				<div class="desc">Browse keys as tables — strings, hashes, lists, sets, sorted sets and streams.</div>
			</div>
		</div>

		<div class="feature">
			<div class="icon">📊</div>
			<div>
				<div class="name">ClickHouse<span class="pro-pill">PRO</span></div>
				<div class="desc">Explore real-time analytics tables over HTTP — arrays, nullables and all.</div>
			</div>
		</div>

		<div class="feature">
			<div class="icon">🦆</div>
			<div>
				<div class="name">DuckDB<span class="pro-pill">PRO</span></div>
				<div class="desc">Open embedded analytics databases and read LIST / STRUCT / MAP columns.</div>
			</div>
		</div>

		<div class="feature">
			<div class="icon">☁️</div>
			<div>
				<div class="name">Neon<span class="pro-pill">PRO</span></div>
				<div class="desc">Connect to serverless Postgres securely over SSL.</div>
			</div>
		</div>
	</div>

	<div class="banner">
		<h3>${bannerTitle}</h3>
		<p>${bannerBody}</p>
	</div>

	<div class="cta-section">
		<button class="btn btn-primary" onclick="send('${primaryCommand}')">${primaryLabel}</button>
		<button class="btn btn-secondary" onclick="send('learnMore')">Learn More</button>
		<br><br>
		<button class="btn-text" onclick="send('dontShowAgain')">Don't show this again</button>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		function send(command) { vscode.postMessage({ command }); }
	</script>
</body>
</html>`;
}
