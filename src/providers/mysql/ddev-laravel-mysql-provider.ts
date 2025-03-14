import * as vscode from 'vscode';
import { MysqlEngine } from '../../database-engines/mysql-engine';
import { isDdevAvailable, getDatabaseConnection } from '../../services/ddev/ddev-service';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';

export const DdevLaravelMysqlProvider: DatabaseEngineProvider = {
  name: 'DDEV - Laravel MySQL',
  type: 'mysql',
  id: 'laravel-mysql-ddev',
  ddev: true,
  description: 'MySQL databases in Laravel projects running in DDEV',
  engine: undefined,

  /**
   * Checks if this provider can be used in the current workspace
   * @returns Promise<boolean> true if DDEV is active and MySQL connection is available
   */
  async canBeUsedInCurrentWorkspace(): Promise<boolean> {
    try {
      // Check if DDEV is available
      const isDdevActive = await isDdevAvailable(this.name);

      if (!isDdevActive) {
        return false;
      }

      // Get database connection from DDEV
      const connection = await getDatabaseConnection('mysql');

      if (!connection) {
        return false;
      }

      // Initialize the engine
      this.engine = new MysqlEngine(connection);

      // Verify the connection is working
      return await this.engine.isOkay();
    } catch (error) {
      vscode.window.showErrorMessage(`Error initializing Laravel MySQL DDEV provider: ${error}`);
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
