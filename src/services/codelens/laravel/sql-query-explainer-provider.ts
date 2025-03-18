import * as vscode from 'vscode';
import { Runner } from '../../laravel/code-runner/runner';
import { CancellationToken, CodeLens, ProviderResult, TextDocument } from 'vscode';
import {
    extractUseStatements,
    getAst,
} from '../../laravel/code-runner/qualifier-service';
import { database } from '../../messenger';
import { getCurrentVersion } from '../../welcome-message-service';
import { extractVariables, replaceVariables } from '../../string';
import httpClient from '../../http-client';
import { passesBasicExplainerCheck, validateSelectedPhpCode } from './query-explain-checker-service';
import { logToOutput } from '../../output-service';

export class SqlQueryCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {
        vscode.window.onDidChangeTextEditorSelection(() => {
            this._onDidChangeCodeLenses.fire();
        });
    }

    public provideCodeLenses(document: TextDocument, token: CancellationToken): ProviderResult<CodeLens[]> {

        if (!database || !this.isLaravelPhpFile(document)) {
            return [];
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.selection || editor.selection.isEmpty) {
            return [];
        }

        if (!isCodeLensForTextSelectionEnabled()) {
            return [];
        }

        const selection = editor.selection;
        const range = new vscode.Range(selection.start, selection.end);

        let selectionText = document.getText(selection).trim();
        const terminatedWithSemicolon = selectionText.endsWith(';');
        if (!terminatedWithSemicolon) {
            selectionText += ';';
        }

        const documentAst = getAst(document.getText())
        const passesCheck = passesBasicExplainerCheck(document, selection, documentAst, true)
        if (!passesCheck) {
            return [];
        }

        const selectionAst = getAst(selectionText)
        const validation = validateSelectedPhpCode(selectionAst)
        if (!validation.isValid) {
            logToOutput(`Invalid php code. ${validation.reason}`)
            return [];
        }

        return [
            new vscode.CodeLens(range, {
                title: "Explain query",
                command: 'devdb.laravel.explain-query',
                arguments: [document, selection]
            })
        ]
    }

    private isLaravelPhpFile(document: vscode.TextDocument): boolean {
        return document.languageId === 'php' &&
            document.fileName.includes('app/') &&
            !document.fileName.includes('vendor/');
    }
}

export async function explainSelectedQuery(document: vscode.TextDocument, selection: vscode.Selection) {
    const documentAst = getAst(document.getText())

    const passesCheck = passesBasicExplainerCheck(document, selection, documentAst)
    if (!passesCheck) {
        return;
    }

    const useStatements = extractUseStatements(documentAst);
    let selectionText = document.getText(selection).trim();
    const terminatedWithSemicolon = selectionText.endsWith(';');
    if (!terminatedWithSemicolon) {
        selectionText += ';';
    }

    try {
        selectionText = await getVariableReplacements(selectionText);

        let explanationUrl: string | undefined;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Analyzing SQL Query',
            cancellable: false
        }, async (progress) => {

            progress.report({ message: 'Running query...' });

            if (!database) {
                vscode.window.showErrorMessage('No database connection found. Please select a database in DevDb and try again.', 'Connect').then(selection => {
                    if (selection === 'Connect') {
                        vscode.commands.executeCommand('devdb.focus');
                    }
                });

                return;
            }

            const queriesWithBindings: [string, any[], string][] = await Runner.runLaravelCode(useStatements, selectionText);

            if (queriesWithBindings.length === 0) {
                vscode.window.showInformationMessage('No SQL queries were executed');
                return;
            }

            if (queriesWithBindings.length > 1) {
                const queriesMessage = queriesWithBindings.map((query, index) => `${index + 1}. ${query}`).join('\r\n');
                vscode.window.showErrorMessage(`MySQL code explainer only supports single SQL query. Found ${queriesWithBindings.length} queries:\r\n\r\n${queriesMessage}`);
                return;
            }

            const [unboundQuery, bindings, boundQuery] = queriesWithBindings[0];

            progress.report({ message: 'Getting MySQL version...' });
            const version = await database.getVersion();

            progress.report({ message: 'Getting query execution plan...' });
            const explainJsonResult = await database.rawQuery(`EXPLAIN FORMAT=JSON ${boundQuery}`);
            if (!Array.isArray(explainJsonResult) || !explainJsonResult[0] || !explainJsonResult[0]['EXPLAIN']) {
                vscode.window.showErrorMessage('Failed to get EXPLAIN JSON output from MySQL. The query might not be supported for explanation.');
                return;
            }
            const explainJson = explainJsonResult[0]['EXPLAIN'];

            let explainTree: string | undefined;
            try {
                const explainTreeResult = await database.rawQuery(`EXPLAIN FORMAT=TREE ${boundQuery}`);
                if (Array.isArray(explainTreeResult) && explainTreeResult[0] && explainTreeResult[0]['EXPLAIN']) {
                    explainTree = explainTreeResult[0]['EXPLAIN'];
                }
            } catch (error) {
                // Silently handle error since TREE format is optional
            }

            progress.report({ message: 'Generating explanation...' });

            try {
                const response = await httpClient.post(
                    'https://api.mysqlexplain.com/v2/explains',
                    {
                        query: unboundQuery,
                        bindings,
                        version,
                        explain_json: explainJson,
                        explain_tree: explainTree
                    },
                    {
                        'Accept': 'application/json',
                        'User-Agent': `DevDb/${getCurrentVersion()}`,
                    });

                const { url } = response.data;
                if (!url) {
                    vscode.window.showErrorMessage('Failed to get explanation URL from the API. Response:', response.data);
                    return;
                }

                explanationUrl = url;
            } catch (error) {
                const message = (error as any)?.data?.message || (typeof error === 'string' ? error : JSON.stringify(error));
                vscode.window.showErrorMessage(`Failed to send SQL query to explainer API: ${message}`);
            }
        });

        if (explanationUrl) {
            const selection = await vscode.window.showInformationMessage(
                'SQL query explanation is ready. Would you like to open it in your browser?',
                'Open in Browser',
                'Copy URL'
            );

            if (selection === 'Open in Browser') {
                vscode.env.openExternal(vscode.Uri.parse(explanationUrl));
            } else if (selection === 'Copy URL') {
                await vscode.env.clipboard.writeText(explanationUrl);
                vscode.window.showInformationMessage('Explanation URL copied to clipboard');
            }
        }
    } catch (error) {
        if (error) {
            vscode.window.showErrorMessage(`Could not process the SQL. ${error}`);
        }
    }
}

/**
 * Gets the variables in the php code, prompts user for the values for
 * each of them, and returns a string where the variables are replaced with
 * user-provided values
 */
export async function getVariableReplacements(selectionText: string): Promise<string> {
    const variables = extractVariables(selectionText);

    if (variables.length === 0) {
        return selectionText;
    }

    const inputBox = vscode.window.createInputBox();
    const values: { [key: string]: string } = {};

    return new Promise((resolve, reject) => {
        let currentVariableIndex = 0;

        inputBox.title = getTitle(currentVariableIndex, variables);
        inputBox.prompt = `Enter value for ${variables[currentVariableIndex]}`;
        inputBox.placeholder = 'Value';
        inputBox.totalSteps = variables.length;
        inputBox.step = 1;

        inputBox.onDidAccept(() => {
            values[variables[currentVariableIndex]] = inputBox.value;
            currentVariableIndex++;

            if (currentVariableIndex === variables.length) {
                inputBox.hide();

                // Check if any values are empty
                const emptyVariables = Object.entries(values)
                    .filter(([_, value]) => !value.trim())
                    .map(([variable]) => variable);

                if (emptyVariables.length > 0) {
                    const these = emptyVariables.length === 1 ? 'this' : 'these';
                    const vars = emptyVariables.length === 1 ? 'variable' : 'variables';
                    vscode.window.showErrorMessage(`You did not provide values for ${these} ${vars}: ${emptyVariables.join(', ')}`);
                    reject();
                    return;
                }

                // Replace variables
                const replacedText = replaceVariables(selectionText, values);
                resolve(replacedText);
            } else {
                inputBox.title = getTitle(currentVariableIndex, variables);
                inputBox.prompt = `Enter value for ${variables[currentVariableIndex]}`;
                inputBox.value = '';
                inputBox.step = currentVariableIndex + 1;
            }
        });

        inputBox.onDidHide(() => {
            if (currentVariableIndex < variables.length) {
                reject(new Error('Variable replacement cancelled'));
            }
        });

        inputBox.show();
    });
}

function getTitle(currentVariableIndex: number, variables: unknown[]) {
    return `Variable values (${currentVariableIndex + 1} of ${variables.length} variable${variables.length === 1 ? '' : 's'})`;
}

function isCodeLensForTextSelectionEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('Devdb');
    return config.get<boolean>('enableCodeLensForTextSelection', true);
}