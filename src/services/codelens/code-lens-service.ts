import * as vscode from 'vscode';
import { LaravelCodelensService } from './laravel/laravel-codelens-service';

export class CodelensProvider implements vscode.CodeLensProvider {

	private codeLenses: vscode.CodeLens[] = [];
	private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

	constructor() { }

	public async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
		this.codeLenses = [];

		const laravelCodeLenses = await LaravelCodelensService.getCodelensFor(document)

		if (laravelCodeLenses) {
			this.codeLenses = laravelCodeLenses
		}

		return this.codeLenses;
	}
}

