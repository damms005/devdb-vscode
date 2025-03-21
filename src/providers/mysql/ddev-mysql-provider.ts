import * as vscode from 'vscode';
import { MysqlEngine } from '../../database-engines/mysql-engine';
import { isDdevAvailable, getDatabaseConnection } from '../../services/ddev/ddev-service';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { isDdevProject } from '../../services/workspace';
import { logToOutput } from '../../services/output-service';

export const DdevMysqlProvider: DatabaseEngineProvider = {
  name: 'DDEV - MySQL',
  type: 'mysql',
  id: 'ddev-mysql',
  ddev: true,
  description: 'MySQL databases in projects running in DDEV',
  engine: undefined,

  /**
   * Checks if this provider can be used in the current workspace
   * @returns Promise<boolean> true if DDEV is active and MySQL connection is available
   */
  async canBeUsedInCurrentWorkspace(): Promise<boolean> {
    try {
      if (!isDdevProject()) {
        logToOutput('Not a DDEV project', 'Postgres DDEV')
        return false;
      }

      // Check if DDEV is available
      const isDdevActive = await isDdevAvailable(this.name);

      if (!isDdevActive) {
        return false;
      }

      // Get database connection from DDEV
      const connection = await getDatabaseConnection('mysql2');

      if (!connection) {
        return false;
      }

      // Initialize the engine
      this.engine = new MysqlEngine(connection);

      // Verify the connection is working
      return await this.engine.isOkay();
    } catch (error) {
      vscode.window.showErrorMessage(`Error initializing MySQL DDEV provider: ${error}`);
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
