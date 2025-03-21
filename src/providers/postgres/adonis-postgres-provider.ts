import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { log } from '../../services/logging-service';
import { PostgresEngine } from '../../database-engines/postgres-engine';
import { getConnectionInEnvFile } from '../../services/adonis/env-file-parser';
import { isAdonisProject } from '../../services/adonis/adonis-core';
import { logToOutput } from '../../services/output-service';

export const AdonisPostgresProvider: DatabaseEngineProvider = {
    name: 'Adonis PostgreSQL (Lucid ORM)',
    type: 'postgres',
    id: 'adonis-lucid-postgres',
    description: 'PostgreSQL database for Adonis.js projects (Lucid ORM)',
    engine: undefined,

    async canBeUsedInCurrentWorkspace(): Promise<boolean> {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!workspaceRoot) {
                log('Adonis PostgreSQL', 'No workspace root found');
                return false;
            }

            const databaseTsPath = path.join(workspaceRoot, 'config', 'database.ts');
            const databaseJsPath = path.join(workspaceRoot, 'config', 'database.js');

            if (!isAdonisProject()) {
                logToOutput('Not an AdonisJS project', 'Postgres AdonisJS')
                return false;
            }

            const configPath = fs.existsSync(databaseTsPath) ? databaseTsPath : databaseJsPath;
            const configContent = fs.readFileSync(configPath, 'utf8');

            // Look for PostgreSQL configuration in the Adonis database config
            const isPgConfigured = configContent.includes('postgres') ||
                configContent.includes('pg') ||
                configContent.includes('postgresql');

            if (!isPgConfigured) {
                return false;
            }

            // Extract connection details from .env file
            const connection = await getConnectionInEnvFile('pgsql', 'postgres');
            if (!connection) {
                return false;
            }

            this.engine = new PostgresEngine(connection);

            return (await this.engine.isOkay());
        } catch (error) {
            log('Adonis PostgreSQL', 'Could not check if Adonis PostgreSQL provider can be used:' + String(error));
            return false;
        }
    },

    reconnect(): Promise<boolean> {
        return this.canBeUsedInCurrentWorkspace()
    },

    async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
        return this.engine
    }
};
