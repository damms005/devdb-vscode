import * as vscode from 'vscode';
import { FileExportType, TableFilterExportPayload, TableQueryResponse } from '../types';
import { getFilteredTableData } from './messenger';

export async function exportTableData(payload: TableFilterExportPayload) {
    let tableData: TableQueryResponse | undefined = await getFilteredTableData(payload)

    if (!tableData) return [];

    if (payload.exportTo === 'file') {
        await exportToFile(tableData.rows, payload.exportType, payload.table);
    } else if (payload.exportTo === 'clipboard') {
        await copyToClipboard(tableData.rows);
    }
}

async function exportToFile(data: Record<string, any>[], exportType: FileExportType | undefined, table: string) {
    const fileUri = await vscode.window.showSaveDialog({
        filters: {
            'JSON Files': ['json'],
            'SQL Files': ['sql'],
            'All Files': ['*']
        }
    });

    if (fileUri) {
        let fileContent: string;

        switch (exportType) {
            case 'json':
                fileContent = JSON.stringify(data, null, 2);
                break;
            case 'sql':
                fileContent = generateSQLInsertStatements(data, table);
                break;
            default:
                vscode.window.showErrorMessage('Unsupported file type');
                return;
        }

        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(fileContent, 'utf-8'));
        vscode.window.showInformationMessage(`Data exported to ${fileUri.fsPath}`);
    }
}

function generateSQLInsertStatements(data: Record<string, any>[], table: string): string {
    if (!data.length) return '';

    const keys = Object.keys(data[0]);
    const sqlStatements = data.map(row => {
        const values = keys.map(key => `'${row[key]}'`).join(', ');
        return `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${values});`;
    });

    return sqlStatements.join('\n');
}

async function copyToClipboard(data: Record<string, any>[]) {
    const jsonData = JSON.stringify(data, null, 2);
    await vscode.env.clipboard.writeText(jsonData);
    vscode.window.showInformationMessage('Data copied to clipboard');
}
