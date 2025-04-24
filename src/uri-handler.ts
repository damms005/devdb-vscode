import * as vscode from 'vscode';

/**
 * URI Handler for DevDb extension
 * Handles URIs in the format: devdb://open/table?connectionId=x&database=y&table=z&workspace=path&authority=remote
 */
export class DevDbUriHandler implements vscode.UriHandler {
    /**
     * Handle incoming URIs for DevDb
     * @param uri The URI to handle
     */
    public handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
        // Only handle URIs with the correct path
        if (!uri.path.startsWith('/open/table')) {
            return;
        }

        // Parse query parameters
        const queryParams = new URLSearchParams(uri.query);
        const connectionId = queryParams.get('connectionId');
        const database = queryParams.get('database');
        const table = queryParams.get('table');
        const workspace = queryParams.get('workspace');
        const authority = queryParams.get('authority');

        // Validate required parameters
        if (!table) {
            vscode.window.showErrorMessage('DevDb: Missing required parameter "table" in URI');
            return;
        }

        // Check if this is the correct workspace
        if (workspace) {
            const currentWorkspaceFolders = vscode.workspace.workspaceFolders;
            if (!currentWorkspaceFolders || !currentWorkspaceFolders.some(folder =>
                folder.uri.fsPath === workspace ||
                folder.uri.path === workspace)) {
                // This URI is meant for a different workspace, ignore it
                return;
            }
        }

        // Check if this is the correct remote authority
        if (authority) {
            const currentAuthority = vscode.env.remoteName;
            if (currentAuthority !== authority) {
                // This URI is meant for a different remote window, ignore it
                return;
            }
        }

        // Execute the command to open the table
        const params: any = { table: table };

        // Add optional parameters if they exist
        if (connectionId) {
            params.connectionId = connectionId;
        }

        if (database) {
            params.database = database;
        }

        // Execute the command to open the specified table
        return vscode.commands.executeCommand('devdb.openTable', params);
    }
}