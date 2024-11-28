import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { Column, DatabaseEngine } from '../../types';
import { getWorkspaceTables } from '../messenger';
import { getTable } from '../codelens/laravel/laravel-codelens-service';

const execAsync = promisify(exec);

export class LaravelFactoryGenerator {
    constructor(private database: DatabaseEngine | null) { }

    async generateFactory(modelName: string, modelFilePath: string): Promise<void> {
        if (!isConnected(this.database)) {
            return
        }

        // Get PHP path from settings
        const config = vscode.workspace.getConfiguration('Devdb');
        const phpPath = config.get<string>('phpExecutablePath') || 'php';

        // Run artisan command to create factory
        const { stdout, stderr } = await execAsync(
            `${phpPath} artisan make:factory ${modelName}Factory`
        ).catch(error => {
            vscode.window.showErrorMessage(
                `Failed to run artisan command: ${error.message}`
            );
            return { stdout: '', stderr: error.message };
        });

        if (stderr) {
            vscode.window.showErrorMessage(
                `Error generating factory: ${stderr}`
            );
            return;
        }

        // Get the factory file path
        const factoryPath = await this.findFactoryFile(`${modelName}Factory.php`);
        if (!factoryPath) {
            vscode.window.showErrorMessage(
                'Factory file not found after creation. Make sure your Laravel project structure is correct.'
            );
            return;
        }

        // Get table name using existing getTable function
        const tableName = await getTable(modelFilePath, modelName);
        if (!tableName) {
            vscode.window.showErrorMessage(
                `Could not determine table name for model ${modelName}`
            );
            return;
        }

        try {
            // Update factory content
            await this.updateFactoryContent(factoryPath, tableName);
            vscode.window.showInformationMessage(
                `Successfully generated factory for ${modelName}`
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to update factory content: ${String(error)}`
            );
        }
    }

    private async findFactoryFile(fileName: string): Promise<string | undefined> {
        const files = await vscode.workspace.findFiles(
            '**/database/factories/' + fileName
        );
        return files[0]?.fsPath;
    }

    private async updateFactoryContent(
        factoryPath: string,
        tableName: string
    ): Promise<void> {
        // Read the factory file
        const content = await fs.readFile(factoryPath, 'utf8');

        // Get table columns
        const columns = await this.database!.getColumns(tableName);

        const definitions = this.generateColumnDefinitions(columns);

        // Replace the return array content
        const updatedContent = content.replace(
            /return \[([\s\S]*?)\];/,
            `return [\n${definitions}\n        ];`
        );

        // Write back to file
        await fs.writeFile(factoryPath, updatedContent, 'utf8');
    }

    private generateColumnDefinitions(columns: Column[]): string {
        return columns
            .map(column => {
                const fakerMethod = this.getFakerMethodForColumn(column);
                return `            '${column.name}' => ${fakerMethod},`;
            })
            .join('\n');
    }

    private getFakerMethodForColumn(column: Column): string {
        const type = column.type.toLowerCase();

        // Special column name handling first
        const columnName = column.name.toLowerCase();
        if (columnName.includes('email')) {
            return 'fake()->safeEmail()';
        }
        if (columnName.includes('name')) {
            return 'fake()->name()';
        }
        if (columnName.includes('phone')) {
            return 'fake()->phoneNumber()';
        }
        if (columnName.includes('address')) {
            return 'fake()->address()';
        }

        // Basic type mapping
        const typeMap: Record<string, string> = {
            'varchar': 'fake()->text()',
            'char': 'fake()->text()',
            'text': 'fake()->paragraph()',
            'integer': 'fake()->numberBetween(1, 1000)',
            'bigint': 'fake()->numberBetween(1, 1000)',
            'boolean': 'fake()->boolean()',
            'date': 'fake()->date()',
            'datetime': 'fake()->dateTime()',
            'timestamp': 'fake()->dateTime()',
            'decimal': 'fake()->randomFloat(2, 0, 1000)',
            'float': 'fake()->randomFloat(2, 0, 1000)',
            'json': 'fake()->json()',
            'uuid': 'fake()->uuid()',
        };

        return typeMap[type] || 'fake()->text()';
    }
}

function isConnected(database: DatabaseEngine | null): boolean {
    const tables = getWorkspaceTables();
    if (!database || tables.length === 0) {
        vscode.window.showErrorMessage(
            'No database connection found. Please connect to a database before generating factory.',
            'Open DevDB'
        ).then(selection => {
            if (selection === 'Open DevDB') {
                vscode.commands.executeCommand('devdb.focus');
            }
        });
        return false;
    }

    return true
}

