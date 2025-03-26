import { Database } from '@vscode/sqlite3';
import { reportError } from '../services/initialization-error-service';
import { Column, QueryResponse, SerializedMutation } from '../types';
import { buildWhereClause } from '../services/sql';

export class SQLiteEngineProvider {
  private db: Database | null = null;
  public dbPath: string;
  private inMemory: boolean;

  constructor(dbPath: string = ':memory:') {
    this.dbPath = dbPath;
    this.inMemory = dbPath === ':memory:';
  }

  getType(): string {
    return 'sqlite';
  }

  getFilename(): string {
    return this.dbPath;
  }

  getConnection(): Promise<Database> {
    return new Promise((resolve, reject) => {
      if (this.db) {
        resolve(this.db);
        return;
      }

      try {
        this.db = new Database(this.dbPath, (err) => {
          if (err) {
            reportError(`SQLite connection error: ${err}`);
            reject(err);
            return;
          }

          // Enable foreign keys
          this.db!.run('PRAGMA foreign_keys = ON;', (pragmaErr) => {
            if (pragmaErr) {
              reportError(`SQLite PRAGMA error: ${pragmaErr}`);
              reject(pragmaErr);
              return;
            }
            resolve(this.db!);
          });
        });
      } catch (err) {
        reportError(`SQLite connection error: ${err}`);
        reject(err);
      }
    });
  }

  async isOkay(): Promise<boolean> {
    try {
      const db = await this.getConnection();

      // For in-memory databases, just check if connection is valid
      if (this.inMemory) {
        return !!db;
      }

      // For file-based databases, run integrity check
      return new Promise<boolean>((resolve, reject) => {
        db.get('PRAGMA integrity_check;', (err, result) => {
          if (err) {
            reportError(`SQLite integrity check error: ${err}`);
            resolve(false);
            return;
          }

          // If integrity_check returns 'ok', the database is fine
          resolve(result && result.integrity_check === 'ok');
        });
      });
    } catch (err) {
      reportError(`SQLite isOkay check error: ${err}`);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve();
        return;
      }

      this.db.close((err) => {
        if (err) {
          reportError(`SQLite disconnect error: ${err}`);
          reject(err);
          return;
        }
        this.db = null;
        resolve();
      });
    });
  }

  async getTableCreationSql(table: string): Promise<string> {
    try {
      const db = await this.getConnection();

      return new Promise<string>((resolve, reject) => {
        const query = `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`;

        db.get(query, [table], (err, row: any) => {
          if (err) {
            reportError(`SQLite get table creation SQL error: ${err}`);
            reject(err);
            return;
          }

          if (!row || !row.sql) {
            resolve('');
            return;
          }

          // Format the SQL for better readability
          try {
            // Dynamically import sql-formatter
            import('sql-formatter').then(({ format }) => {
              const formattedSql = format(row.sql, {
                language: 'sqlite',
                tabWidth: 2,
                keywordCase: 'upper',
              });
              resolve(formattedSql);
            }).catch(formatErr => {
              reportError(`SQL formatting error: ${formatErr}`);
              resolve(row.sql);
            });
          } catch (formatErr) {
            // If formatting fails, return the original SQL
            reportError(`SQL formatting error: ${formatErr}`);
            resolve(row.sql);
          }
        });
      });
    } catch (err) {
      reportError(`SQLite get table creation SQL error: ${err}`);
      return '';
    }
  }

  async getTables(): Promise<string[]> {
    try {
      const db = await this.getConnection();

      return new Promise<string[]>((resolve, reject) => {
        const query = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`;

        db.all(query, (err, rows: any[]) => {
          if (err) {
            reportError(`SQLite get tables error: ${err}`);
            reject(err);
            return;
          }

          const tableNames = rows.map(row => row.name);
          resolve(tableNames);
        });
      });
    } catch (err) {
      reportError(`SQLite get tables error: ${err}`);
      return [];
    }
  }

  async getColumns(table: string): Promise<Column[]> {
    try {
      const db = await this.getConnection();

      // Get column information
      const columnsPromise = new Promise<any[]>((resolve, reject) => {
        db.all(`PRAGMA table_info(${this.escapeIdentifier(table)})`, (err, rows) => {
          if (err) {
            reportError(`SQLite get columns error: ${err}`);
            reject(err);
            return;
          }
          resolve(rows);
        });
      });

      // Get foreign key information
      const foreignKeysPromise = new Promise<any[]>((resolve, reject) => {
        db.all(`PRAGMA foreign_key_list(${this.escapeIdentifier(table)})`, (err, rows) => {
          if (err) {
            reportError(`SQLite get foreign keys error: ${err}`);
            reject(err);
            return;
          }
          resolve(rows);
        });
      });

      // Wait for both promises to resolve
      const [columns, foreignKeys] = await Promise.all([columnsPromise, foreignKeysPromise]);

      // Map foreign keys to their respective columns
      return columns.map((column): Column => {
        const foreignKey = foreignKeys.find(fk => fk.from === column.name);

        const col: Column = {
          name: column.name,
          type: column.type,
          isNullable: column.notnull === 0,
          isPrimaryKey: column.pk > 0,
          isNumeric: this.getNumericColumnTypeNamesLowercase().includes(column.type.toLowerCase()),
          foreignKey: foreignKey ? {
            table: foreignKey.table,
            column: foreignKey.to
          } : undefined
        }

        return col
      });
    } catch (err) {
      reportError(`SQLite get columns error: ${err}`);
      return [];
    }
  }

  getNumericColumnTypeNamesLowercase(): string[] {
    return ['integer', 'real', 'numeric'];
  }

  async getTotalRows(
    table: string,
    columns: Column[],
    whereClause?: Record<string, any>
  ): Promise<number> {
    try {
      const db = await this.getConnection();

      let query = `SELECT COUNT(*) as count FROM ${this.escapeIdentifier(table)}`;
      const params: any[] = [];

      if (whereClause && Object.keys(whereClause).length > 0) {
        const { whereString, whereParams } = this.buildWhereClause(whereClause, columns);
        query += whereString.trim() ? ` WHERE ${whereString}` : '';
        params.push(...whereParams);
      }

      return new Promise<number>((resolve, reject) => {
        db.get(query, params, (err, row: any) => {
          if (err) {
            reportError(`SQLite get total rows error: ${err}`);
            reject(err);
            return;
          }

          resolve(row ? row.count : 0);
        });
      });
    } catch (err) {
      reportError(`SQLite get total rows error: ${err}`);
      return 0;
    }
  }

  async getRows(table: string, columns: Column[], limit: number, offset: number, whereClause?: Record<string, any>): Promise<QueryResponse | undefined> {
    try {
      const db = await this.getConnection();

      const columnNames = columns.map(col => this.escapeIdentifier(col.name)).join(', ');
      let query = `SELECT ${columnNames} FROM ${this.escapeIdentifier(table)}`;
      const params: any[] = [];

      if (whereClause && Object.keys(whereClause).length > 0) {
        const { whereString, whereParams } = this.buildWhereClause(whereClause, columns);
        query += whereString.trim() ? ` WHERE ${whereString}` : '';
        params.push(...whereParams);
      }

      query += ` LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      return new Promise<QueryResponse | undefined>((resolve, reject) => {
        db.all(query, params, (err, rows: any[]) => {
          if (err) {
            reportError(`SQLite get rows error: ${err}`);
            reject(err);
            return;
          }

          resolve({ rows, sql: query });
        });
      });
    } catch (err) {
      reportError(`SQLite get rows error: ${err}`);
    }
  }

  async getVersion(): Promise<string> {
    try {
      const db = await this.getConnection();

      return new Promise<string>((resolve, reject) => {
        db.get('SELECT sqlite_version() as version', (err, row: any) => {
          if (err) {
            reportError(`SQLite get version error: ${err}`);
            reject(err);
            return;
          }

          resolve(row ? row.version : 'unknown');
        });
      });
    } catch (err) {
      reportError(`SQLite get version error: ${err}`);
      return 'unknown';
    }
  }

  async transaction(): Promise<SQLiteTransaction> {
    try {
      const db = await this.getConnection();

      return new Promise<SQLiteTransaction>((resolve, reject) => {
        db.run('BEGIN TRANSACTION', (err) => {
          if (err) {
            reportError(`SQLite begin transaction error: ${err}`);
            reject(err);
            return;
          }
          resolve(new SQLiteTransaction(db));
        });
      });
    } catch (err) {
      reportError(`SQLite begin transaction error: ${err}`);
      throw err;
    }
  }

  async commitChange(mutation: SerializedMutation, transaction?: Database | SQLiteTransaction): Promise<void> {
    try {
      let db: Database;

      if (transaction instanceof SQLiteTransaction) {
        db = transaction.getConnection();
      } else {
        db = transaction || await this.getConnection();
      }

      return new Promise<void>((resolve, reject) => {
        const { type, table, primaryKeyColumn, primaryKey } = mutation;

        if (type === 'cell-update') {
          const setClauses: string[] = [];
          const params: any[] = [];

          setClauses.push(`${this.escapeIdentifier(mutation.column.name)} = ?`);
          params.push(this.transformValueForSqlite(mutation.newValue));

          // Add primary key value to params
          params.push(this.transformValueForSqlite(primaryKey));

          const query = `UPDATE ${this.escapeIdentifier(table)}
                         SET ${setClauses.join(', ')}
                         WHERE ${this.escapeIdentifier(primaryKeyColumn)} = ?`;

          db.run(query, params, function (err) {
            if (err) {
              reportError(`SQLite update error: ${err}`);
              reject(err);
              return;
            }
            resolve();
          });
        } else if (type === 'row-delete') {
          const query = `DELETE FROM ${this.escapeIdentifier(table)}
                         WHERE ${this.escapeIdentifier(primaryKeyColumn)} = ?`;

          db.run(query, [this.transformValueForSqlite(primaryKey)], function (err) {
            if (err) {
              reportError(`SQLite delete error: ${err}`);
              reject(err);
              return;
            }
            resolve();
          });
        } else {
          reject(new Error(`Unsupported mutation type: ${type}`));
        }
      });
    } catch (err) {
      reportError(`SQLite commit change error: ${err}`);
      throw err;
    }
  }

  async raw(code: string): Promise<any> {
    return this.rawQuery(code)
  }

  async rawQuery(code: string): Promise<any> {
    try {
      const db = await this.getConnection();

      return new Promise<any>((resolve, reject) => {
        // Determine if the query is a SELECT or PRAGMA statement
        const isSelect = /^\s*(SELECT|PRAGMA)\s+/i.test(code);

        if (isSelect) {
          db.all(code, (err, rows) => {
            if (err) {
              reportError(`SQLite run arbitrary query error: ${err}`);
              reject(err);
              return;
            }
            resolve(rows);
          });
        } else {
          db.run(code, function (err) {
            if (err) {
              reportError(`SQLite run arbitrary query error: ${err}`);
              reject(err);
              return;
            }

            // For non-SELECT queries, return information about the operation
            resolve({
              changes: this.changes,
              lastID: this.lastID
            });
          });
        }
      });
    } catch (err) {
      reportError(`SQLite run arbitrary query error: ${err}`);
      throw err;
    }
  }

  async beginTransaction(): Promise<Database> {
    try {
      const db = await this.getConnection();

      return new Promise<Database>((resolve, reject) => {
        db.run('BEGIN TRANSACTION', (err) => {
          if (err) {
            reportError(`SQLite begin transaction error: ${err}`);
            reject(err);
            return;
          }
          resolve(db);
        });
      });
    } catch (err) {
      reportError(`SQLite begin transaction error: ${err}`);
      throw err;
    }
  }

  async commitTransaction(transaction: Database): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      transaction.run('COMMIT', (err) => {
        if (err) {
          reportError(`SQLite commit transaction error: ${err}`);
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async rollbackTransaction(transaction: Database): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      transaction.run('ROLLBACK', (err) => {
        if (err) {
          reportError(`SQLite rollback transaction error: ${err}`);
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private buildWhereClause(whereClause: Record<string, any>, columns: Column[]): { whereString: string; whereParams: any[] } {

    const wheres: string[] = []
    const whereParams: any[] = []

    const clause = buildWhereClause(this, 'sqlite3', whereClause, columns)

    for (const entry of clause) {
      wheres.push(`${entry.column} ${entry.operator} ?`)
      whereParams.push(entry.value)
    }

    return { whereString: wheres.join(' AND '), whereParams }
  }

  private transformValueForSqlite(value: any): any {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    return value;
  }

  async runQuery(sql: string, params: any[] = []): Promise<any> {
    try {
      const db = await this.getConnection();

      return new Promise<any>((resolve, reject) => {
        // Determine if the query is a SELECT or PRAGMA statement
        const isSelect = /^\s*(SELECT|PRAGMA)\s+/i.test(sql);

        if (isSelect) {
          db.all(sql, params, (err, rows) => {
            if (err) {
              reportError(`SQLite run query error: ${err}`);
              reject(err);
              return;
            }
            resolve(rows);
          });
        } else {
          db.run(sql, params, function (err) {
            if (err) {
              reportError(`SQLite run query error: ${err}`);
              reject(err);
              return;
            }

            // For non-SELECT queries, return information about the operation
            resolve({
              changes: this.changes,
              lastID: this.lastID
            });
          });
        }
      });
    } catch (err) {
      reportError(`SQLite run query error: ${err}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    return this.disconnect();
  }

  private escapeIdentifier(identifier: string): string {
    // SQLite identifiers can be escaped with double quotes
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  destroy() { }
}

export class SQLiteTransaction {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  getConnection(): Database {
    return this.db;
  }

  async commit(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.db.run('COMMIT', (err) => {
        if (err) {
          reportError(`SQLite commit transaction error: ${err}`);
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async rollback(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.db.run('ROLLBACK', (err) => {
        if (err) {
          reportError(`SQLite rollback transaction error: ${err}`);
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}
