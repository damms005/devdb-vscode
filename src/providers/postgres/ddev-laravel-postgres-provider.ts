import * as vscode from 'vscode';
import { PostgresEngine } from '../../database-engines/postgres-engine';
import { isDdevAvailable, getDatabaseConnection } from '../../services/ddev/ddev-service';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';

export const DdevLaravelPostgresProvider: DatabaseEngineProvider = {
  name: 'Laravel PostgreSQL (DDEV)',
  type: 'postgres',
  id: 'laravel-postgres-ddev',
  description: 'PostgreSQL database running in a DDEV environment for Laravel projects',
  engine: undefined as PostgresEngine | undefined,

  /**
   * Checks if this provider can be used in the current workspace
   * @returns Promise<boolean> indicating if the provider can be used
   */
  async canBeUsedInCurrentWorkspace(): Promise<boolean> {
    try {
      // Check if DDEV is available
      if (!(await isDdevAvailable())) {
        return false;
      }

      // Get PostgreSQL connection from DDEV
      const connection = await getDatabaseConnection('postgres');
      if (!connection) {
        return false;
      }

      // Initialize the engine with the connection
      this.engine = new PostgresEngine(connection);

      // Check if the engine is okay
      return await this.engine.isOkay();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to initialize PostgreSQL engine: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  },

  async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine
	}
};
