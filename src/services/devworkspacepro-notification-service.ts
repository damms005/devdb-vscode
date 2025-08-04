import * as vscode from 'vscode';
import { isDdevProject } from './workspace';

const NOTICE_SHOWN_KEY = 'devworkspacepro.notice.shown';
const NOTICE_DISMISSED_KEY = 'devworkspacepro.notice.dismissed';

export function showDevWorkspaceProNoticeForDdevWorkspaces(context: vscode.ExtensionContext, version: string, isNewInstall: boolean = false) {
    if (!isDdevProject()) {
        return;
    }

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
        createDevWorkspaceProWebview(context, isNewInstall);
    }, 1000);
}

function createDevWorkspaceProWebview(context: vscode.ExtensionContext, isNewInstall: boolean = false) {
    const panel = vscode.window.createWebviewPanel(
        'devworkspacepro-notice',
        isNewInstall ? 'Welcome to DevDb - Get DevWorkspace Pro' : 'DevWorkspace Pro - The Best GUI for DDEV',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: false,
            localResourceRoots: []
        }
    );

    panel.webview.html = getNoticeHtml(isNewInstall);

    panel.iconPath = {
        light: vscode.Uri.file(context.asAbsolutePath('resources/devdb.png')),
        dark: vscode.Uri.file(context.asAbsolutePath('resources/devdb.png'))
    };
    panel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'getLicense':
                    vscode.env.openExternal(vscode.Uri.parse('https://devworkspacepro.com/#pricing'));
                    panel.dispose();
                    break;
                case 'learnMore':
                    vscode.env.openExternal(vscode.Uri.parse('https://devworkspacepro.com'));
                    break;
                case 'close':
                    panel.dispose();
                    break;
            }
        },
        undefined,
        context.subscriptions
    );

    // Removed auto-disposal - let user decide when to close the promotional tab
}

function getNoticeHtml(isNewInstall: boolean = false): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DevWorkspace Pro - The Best GUI for DDEV</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 32px;
            max-width: 800px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            margin-bottom: 40px;
        }

        .title {
            font-size: 2.5em;
            font-weight: 700;
            color: var(--vscode-textLink-foreground);
            margin-bottom: 16px;
            background: linear-gradient(135deg, var(--vscode-textLink-foreground), var(--vscode-textLink-activeForeground));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .subtitle {
            font-size: 1.2em;
            opacity: 0.9;
            margin-bottom: 32px;
        }

        .screenshot {
            width: 100%;
            max-width: 600px;
            height: auto;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            margin: 32px auto;
            display: block;
            border: 1px solid var(--vscode-panel-border);
        }

        .features {
            margin: 40px 0;
        }

        .features h3 {
            font-size: 1.4em;
            margin-bottom: 20px;
            color: var(--vscode-textLink-foreground);
        }

        .features ul {
            list-style: none;
            padding: 0;
        }

        .features li {
            padding: 12px 0;
            padding-left: 30px;
            position: relative;
            font-size: 1.1em;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .features li:before {
            content: "✅";
            position: absolute;
            left: 0;
            top: 12px;
            font-size: 1.2em;
        }

        .discount-banner {
            background: var(--vscode-editor-selectionBackground, rgba(173, 214, 255, 0.15));
            padding: 24px;
            border-radius: 12px;
            text-align: center;
            margin: 32px 0;
            border: 2px solid var(--vscode-focusBorder);
            color: var(--vscode-foreground);
        }

        .discount-banner h3 {
            font-size: 1.3em;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
            font-weight: 600;
        }

        .discount-banner p {
            color: var(--vscode-foreground);
            opacity: 0.9;
        }

        .discount-code {
            font-family: 'Courier New', monospace;
            font-size: 1.2em;
            font-weight: bold;
            background: var(--vscode-input-background);
            padding: 12px 20px;
            border-radius: 8px;
            display: inline-block;
            margin: 12px 0;
            color: var(--vscode-input-foreground);
            border: 2px solid var(--vscode-textLink-foreground);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            letter-spacing: 1px;
        }

        .cta-section {
            text-align: center;
            margin-top: 40px;
        }

        .btn {
            padding: 16px 32px;
            margin: 8px;
            border: none;
            border-radius: 8px;
            font-size: 1.1em;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            text-decoration: none;
            display: inline-block;
        }

        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
        }

        .btn-secondary {
            background: transparent;
            color: var(--vscode-textLink-foreground);
            border: 2px solid var(--vscode-textLink-foreground);
        }

        .btn-secondary:hover {
            background: var(--vscode-textLink-foreground);
            color: var(--vscode-button-foreground);
            transform: translateY(-2px);
        }

        .btn-text {
            background: none;
            color: var(--vscode-descriptionForeground);
            border: none;
            font-size: 0.9em;
            padding: 8px 16px;
            text-decoration: underline;
            opacity: 0.8;
        }

        .btn-text:hover {
            opacity: 1;
            background: var(--vscode-button-secondaryBackground);
        }

        .close-btn {
            position: absolute;
            top: 16px;
            right: 16px;
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            color: var(--vscode-foreground);
            opacity: 0.7;
            padding: 4px;
            border-radius: 4px;
        }

        .close-btn:hover {
            opacity: 1;
            background: var(--vscode-button-secondaryBackground);
        }

        @media (max-width: 600px) {
            body {
                padding: 16px;
            }

            .title {
                font-size: 2em;
            }

            .btn {
                display: block;
                margin: 8px 0;
            }
        }
    </style>
</head>
<body>
    <button class="close-btn" onclick="closeNotice()">×</button>

    <div class="header">
        <h1 class="title">DevWorkspace Pro (DevDb user discount)</h1>
        <p class="subtitle">
            The Ultimate GUI for DDEV with focus on Workflow Productivity
        </p>
    </div>

    <img src="http://devworkspacepro.com/images/screenshots/project-overview-tab-light.png"
         alt="DevWorkspace Pro Screenshot"
         class="screenshot"
         onerror="this.style.display='none'">

    <div class="features">
        <h3>Powerful Features for DDEV Developers</h3>
        <ul>
            <li>Intuitive project overview and management</li>
            <li>One-click DDEV container control (start, stop, restart)</li>
            <li>Built-in database management and visualization</li>
            <li>Integrated terminal with DDEV commands</li>
            <li>Real-time project status monitoring</li>
            <li>Seamless multi-project workspace support</li>
            <li>Beautiful, modern interface designed for productivity</li>
        </ul>
    </div>

    <div class="discount-banner">
        <h3>🎉 Special ${isNewInstall ? 'Welcome' : 'Launch'} Offer for DevDb Users!</h3>
        <p>Get ${isNewInstall ? '25%' : '30%'} off your first yearly license</p>
        <div class="discount-code">${isNewInstall ? 'GIFTFORDEVDBUSERS25' : 'LAUNCHDAYGIFTFORDEVDBUSERS'}</div>
    </div>

    <div class="cta-section">
        <button class="btn btn-primary" onclick="getLicense()">
            Get Your License Now
        </button>
        <button class="btn btn-secondary" onclick="learnMore()">
            Learn More
        </button>
        <br><br>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function getLicense() {
            vscode.postMessage({
                command: 'getLicense'
            });
        }

        function learnMore() {
            vscode.postMessage({
                command: 'learnMore'
            });
        }

        function closeNotice() {
            vscode.postMessage({
                command: 'close'
            });
        }
    </script>
</body>
</html>`;
}