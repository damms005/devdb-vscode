import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel | undefined;

/**
 * Logs a message to the DevDb output channel
 */
export function logToOutput(message: string, description = ''): void {
    const channel = getOutputChannel();
    const formattedMessage = `${description ? `[${description}]` : ''} ${message}`;
    channel.appendLine(formattedMessage);
}

export function clearOutput(): void {
    const channel = getOutputChannel();
    channel.clear();
}

/**
 * Shows the DevDb output channel in the VS Code UI
 */
export function showOutput(): void {
    const channel = getOutputChannel();
    channel.show();
}

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("DevDb");
    }
    return outputChannel;
}
