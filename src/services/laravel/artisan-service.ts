import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getBasePath } from '../workspace';

const execAsync = promisify(exec);

export class ArtisanService {
    constructor(private workspaceRoot: string) { }

    static create(): ArtisanService | undefined {
        const workspaceRoot = getBasePath();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder found');
            return undefined;
        }
        return new ArtisanService(workspaceRoot);
    }

    async runCommand(command: string, args: string[] = []): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('Devdb');
        const phpPath = config.get<string>('phpExecutablePath') || 'php';

        const fullCommand = `${phpPath} artisan ${command} ${args.join(' ')}`;

        const { stdout, stderr } = await execAsync(
            fullCommand,
            { cwd: this.workspaceRoot }
        ).catch(error => {
            vscode.window.showErrorMessage(
                `Failed to run artisan command: ${error.message}`
            );
            return { stdout: '', stderr: error.message };
        });

        if (stderr) {
            vscode.window.showErrorMessage(
                `Error running artisan command: ${stderr}`
            );
            return false;
        }

        return true;
    }
}
