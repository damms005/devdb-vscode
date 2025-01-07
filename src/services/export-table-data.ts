import * as vscode from 'vscode';
import { DatabaseEngine, FileExportType, TableFilterExportPayload, TableQueryResponse } from '../types';
import { getFilteredTableData } from './messenger';
import { formatDialect, sql } from 'sql-formatter';
import { showMissingDatabaseError } from './error-notification-service';

export async function exportTableData(payload: TableFilterExportPayload, database: DatabaseEngine | null) {
    if (!database) {
        return showMissingDatabaseError()
    };

    let tableData: TableQueryResponse | undefined = await getFilteredTableData(payload)

    if (!tableData) return [];

    try {
        if (payload.exportTo === 'file') {
            await exportToFile(tableData.rows, payload.exportType, payload.table);
        } else if (payload.exportTo === 'clipboard') {
            await copyToClipboard(tableData.rows, payload.exportType, payload.table);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Error exporting data to file: ${String(error)}`);
    }
}

async function exportToFile(data: Record<string, any>[], exportType: FileExportType | undefined, table: string) {

    const filters: Record<string, any> = {
        'All Files': ['*']
    }

    switch (exportType) {
        case 'json':
            filters['JSON Files'] = ['json']
            break;

        default:
            filters['SQL Files'] = ['sql']
            break;
    }

    const fileUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.parse(`${table}.${exportType}`),
        filters,
    });

    if (!fileUri) {
        return;
    }

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

async function copyToClipboard(data: Record<string, any>[], exportType: FileExportType | undefined, table: string) {
    let fileContent = JSON.stringify(data, null, 2);

    switch (exportType) {
        case 'sql':
            fileContent = generateSQLInsertStatements(data, table);
            break;
    }

    await vscode.env.clipboard.writeText(fileContent);

    vscode.window.showInformationMessage('Data copied to clipboard');
}

function generateSQLInsertStatements(data: Record<string, any>[], table: string): string {
    if (!data.length) return '';

    const keys = Object.keys(data[0]);
    const sqlStatements = data.map(row => {
        const values = keys.map(key => escapeSql(row[key])).join(', ');
        return `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${values});`;
    });

    const query = sqlStatements.join('\n');

    try {
        return formatDialect(query, {
            dialect: sql,
            keywordCase: 'upper',
        });
    } catch (error) {
        vscode.window.showErrorMessage('Query could not be formatted');
        return query
    }
}

function escapeSql(value: string): any {
    if (!value) return 'NULL';

    const safelyStringableTypes = [
        'string',
        'object', // e.g. Date
    ]

    if (safelyStringableTypes.indexOf(typeof value) === -1) {
        return value
    };

    value = String(value)
        .replace(/'/g, "''")
        .replace(/\n/g, '\\n');

    return `'${value}'`;
}