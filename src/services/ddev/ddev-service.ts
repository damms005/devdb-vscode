import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Sequelize } from 'sequelize';
import { getConnectionFor } from '../sequelize-connector';
import path from 'path';
import fs from 'fs';
import { logToOutput } from '../output-service';

const execAsync = promisify(exec);

interface DdevConfig {
  raw: {
    database_type: string;
    dbinfo: {
      database_type: string;
      database_version: string;
      dbPort: string;
      dbname: string;
      host: string;
      password: string;
      published_port: number;
      username: string;
    };
  };
}

/**
 * Checks if DDEV is available in the current environment
 * @returns Promise<boolean> indicating if DDEV is installed
 */
export async function isDdevAvailable(requester: string): Promise<boolean> {
  try {
    const output = await execAsync('ddev --version');
    logToOutput(`${output.stdout.trim()}`, requester);
    return true;
  } catch (error) {
    logToOutput(`Could not get DDEV version: ${String(error).trim()}`, requester);
    return false;
  }
}

/**
 * Retrieves DDEV configuration by executing 'ddev describe -j' command
 * @returns Promise<DdevConfig | undefined> The parsed DDEV configuration or undefined if command fails
 */
export async function getDdevConfig(): Promise<DdevConfig | undefined> {
  try {
    let path = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!path) {
      throw new Error('No workspace folder found');
    }

    const { stdout } = await execAsync(`ddev describe -j`, { cwd: path });
    return JSON.parse(stdout) as DdevConfig;
  } catch (error) {
    console.log('Failed to get DDEV configuration:', error);
    return undefined;
  }
}

/**
 * Gets a database connection for the specified dialect using DDEV configuration
 * @param dialect The database dialect ('mysql', 'postgres', or 'sqlite')
 * @returns Promise<Sequelize | undefined> A Sequelize instance or undefined if connection fails
 */
export async function getDatabaseConnection(dialect: 'mysql' | 'postgres' | 'sqlite'): Promise<Sequelize | undefined> {
  try {
    const config = await getDdevConfig();

    if (!config) {
      return undefined;
    }

    const { dbinfo, database_type } = config.raw;

    // Check if the requested dialect matches the DDEV database type
    if (dialect === 'mysql' && (database_type === 'mysql' || database_type === 'mariadb')) {
      return getConnectionFor(
        'DDEV provider',
        'mysql',
        '127.0.0.1',
        dbinfo.published_port,
        dbinfo.username,
        dbinfo.password,
        dbinfo.dbname
      );
    } else if (dialect === 'postgres' && database_type === 'postgres') {
      return getConnectionFor(
        'DDEV provider',
        'postgres',
        '127.0.0.1',
        dbinfo.published_port,
        dbinfo.username,
        dbinfo.password,
        dbinfo.dbname
      );
    }

    return undefined;
  } catch (error) {
    console.log(`Failed to get ${dialect} connection from DDEV:`, error);
    return undefined;
  }
}

export function isDdevProject(): boolean {
  // simply check if workspace root contains a .ddev directory
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return false;
  }

  return fs.existsSync(path.join(workspaceRoot, '.ddev'));
}