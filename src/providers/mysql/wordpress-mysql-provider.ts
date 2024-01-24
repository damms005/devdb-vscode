import * as vscode from 'vscode'
import { DatabaseEngine, DatabaseEngineProvider } from '../../types'
import { MysqlEngine } from '../../database-engines/mysql-engine'
import { getConnectionInEnvFile } from '../../services/wordpress/env-file-parser'

export const WordPressMysqlProvider: DatabaseEngineProvider = {
	name: 'WordPress Mysql',
	type: 'mysql',
	id: 'wordpress-mysql',
	description: 'WordPress MySQL with default wp-config.php or wp-config-local.php file',
	engine: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		const connection = await getConnectionInEnvFile('mysql', 'mysql')
		if (!connection) return false

		try {
			this.engine = new MysqlEngine(connection)
		} catch (error) {
			vscode.window.showErrorMessage(`MySQL connection error: ${String(error)}`)
			return false
		}

		return (await this.engine.getTables()).length > 0
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		return this.engine
	},
}
