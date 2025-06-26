import * as vscode from 'vscode';

export class DevDbUriHandler implements vscode.UriHandler {
    public handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
        if (!uri.path.startsWith('/open/table')) {
            return;
        }

        const queryParams = new URLSearchParams(uri.query);
        const connectionId = queryParams.get('connectionId');
        const database = queryParams.get('database');
        const table = queryParams.get('table');
        const workspace = queryParams.get('workspace');
        const authority = queryParams.get('authority');

        if (!table) {
            vscode.window.showErrorMessage('DevDb: Missing required parameter "table" in URI');
            return;
        }

        if (workspace) {
            const currentWorkspaceFolders = vscode.workspace.workspaceFolders;
            if (!currentWorkspaceFolders || !currentWorkspaceFolders.some(folder =>
                folder.uri.fsPath === workspace ||
                folder.uri.path === workspace)) {
                return;
            }
        }

        if (authority) {
            const currentAuthority = vscode.env.remoteName;
            if (currentAuthority !== authority) {
                return;
            }
        }

        const params: any = { table: table };

        if (connectionId) {
            params.connectionId = connectionId;
        }

        if (database) {
            params.database = database;
        }

        return vscode.commands.executeCommand('devdb.openTable', params);
    }
}