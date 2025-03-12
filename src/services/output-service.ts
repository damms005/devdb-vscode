import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel | undefined;

/**
 * Logs a message to the DevDb output channel with a tag prefix
 *
 * @param message - The message to log
 * @param tag - A tag or description to prefix the message (e.g., "INFO", "ERROR", "DATABASE")
 */
export function logToOutput(message: string, tag = 'INFO'): void {
    const channel = getOutputChannel();
    const formattedMessage = `[${tag}] ${message}`;
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
