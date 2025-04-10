import * as path from 'path';
import * as fs from 'fs';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { log } from '../../services/logging-service';
import { MysqlEngine } from '../../database-engines/mysql-engine';
import { getConnectionInEnvFile } from '../../services/adonis/env-file-parser';
import { isAdonisProject } from '../../services/adonis/adonis-core';
import { logToOutput } from '../../services/output-service';
import { getBasePath } from '../../services/workspace';

export const AdonisMysqlProvider: DatabaseEngineProvider = {
    name: 'Adonis MySQL (Lucid ORM)',
    type: 'mysql',
    id: 'adonis-lucid-mysql',
    description: 'MySQL database for Adonis.js projects (Lucid ORM)',
    engine: undefined,

    async canBeUsedInCurrentWorkspace(): Promise<boolean> {
        try {
            const workspaceRoot = getBasePath();
            if (!workspaceRoot) {
                log('Adonis MySQL', 'No workspace root found');
                return false;
            }

            const databaseTsPath = path.join(workspaceRoot, 'config', 'database.ts');
            const databaseJsPath = path.join(workspaceRoot, 'config', 'database.js');

            if (!isAdonisProject()) {
                logToOutput('Not an AdonisJS project', 'MySQL AdonisJS')
                return false;
            }

            const configPath = fs.existsSync(databaseTsPath) ? databaseTsPath : databaseJsPath;
            const configContent = fs.readFileSync(configPath, 'utf8');

            if (!configContent.includes('mysql') || configContent.includes('postgresql') || configContent.includes('postgres')) {
                log('Adonis MySQL', 'MySQL not configured in Adonis database config');
                return false;
            }

            const connection = await getConnectionInEnvFile('mysql', 'mysql2');
            if (!connection) {
                log('Adonis MySQL', 'Could not extract MySQL connection details from .env file');
                return false;
            }

            this.engine = new MysqlEngine(connection);
            return this.engine.isOkay();
        } catch (error) {
            log('Adonis postgres', 'Error checking if Adonis MySQL provider can be used', error);
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
