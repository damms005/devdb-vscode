import * as vscode from 'vscode';
import { LaravelCodelensService } from './laravel/laravel-codelens-service';

export class CodelensProvider implements vscode.CodeLensProvider {

	private codeLenses: vscode.CodeLens[] = [];
	private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

	constructor() { }

	public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
		this.codeLenses = [];

		return Promise.all([
			LaravelCodelensService.getCodelensFor(document),
		])
			.then(laravelCodeLenses => {
				laravelCodeLenses.filter(Boolean).forEach(laravelCodeLens => {
					this.codeLenses.push(laravelCodeLens as vscode.CodeLens)
				})

				return Promise.resolve(this.codeLenses);
			})
	}
}

