import * as vscode from 'vscode';
import { PostgresEngine } from '../../database-engines/postgres-engine';
import { isSupabaseProject, isSupabaseRunning, getSupabaseConnection } from '../../services/supabase/supabase-service';
import { DatabaseEngine, DatabaseEngineProvider } from '../../types';
import { logToOutput } from '../../services/output-service';

export const SupabasePostgresProvider: DatabaseEngineProvider = {
  name: 'Supabase - PostgreSQL',
  type: 'postgres',
  id: 'supabase-postgres',
  description: 'PostgreSQL databases in local Supabase projects',
  engine: undefined as PostgresEngine | undefined,

  async canBeUsedInCurrentWorkspace(): Promise<boolean> {
    try {
      if (!isSupabaseProject()) {
        logToOutput('Not a Supabase project', 'Supabase Postgres')
        return false;
      }

      if (!(await isSupabaseRunning())) {
        logToOutput('Supabase is not running', 'Supabase Postgres')
        return false;
      }

      const connection = await getSupabaseConnection();
      if (!connection) {
        return false;
      }

      this.engine = new PostgresEngine(connection);

      return await this.engine.isOkay();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to initialize Supabase PostgreSQL engine: ${error instanceof Error ? error.message : String(error)}`);
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
