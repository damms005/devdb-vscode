import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { getConnectionFor } from '../connector';
import { logToOutput } from '../output-service';
import { getBasePath } from '../workspace';
import knexlib from "knex";

const execAsync = promisify(exec);

const SUPABASE_DEFAULT_HOST = '127.0.0.1';
const SUPABASE_DEFAULT_PORT = 54322;
const SUPABASE_DEFAULT_USER = 'postgres';
const SUPABASE_DEFAULT_PASSWORD = 'postgres';
const SUPABASE_DEFAULT_DATABASE = 'postgres';

export function isSupabaseProject(): boolean {
	const workspaceRoot = getBasePath();
	if (!workspaceRoot) {
		return false;
	}

	return fs.existsSync(path.join(workspaceRoot, 'supabase', 'config.toml'));
}

export async function isSupabaseRunning(): Promise<boolean> {
	try {
		const workspaceRoot = getBasePath();
		if (!workspaceRoot) {
			return false;
		}

		const { stdout } = await execAsync('supabase status', {
			cwd: workspaceRoot,
			timeout: 10000,
		});

		return stdout.includes('DB URL') || stdout.includes('supabase local');
	} catch (error) {
		logToOutput(`Supabase status check failed: ${String(error)}`, 'Supabase');
		return false;
	}
}

interface SupabaseStatusParsed {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

function parseSupabaseStatus(stdout: string): SupabaseStatusParsed {
	const dbUrlMatch = stdout.match(/DB URL\s*[:=]\s*postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(\S+)/);

	if (dbUrlMatch) {
		return {
			user: dbUrlMatch[1],
			password: dbUrlMatch[2],
			host: dbUrlMatch[3],
			port: parseInt(dbUrlMatch[4], 10),
			database: dbUrlMatch[5],
		};
	}

	return {
		host: SUPABASE_DEFAULT_HOST,
		port: SUPABASE_DEFAULT_PORT,
		user: SUPABASE_DEFAULT_USER,
		password: SUPABASE_DEFAULT_PASSWORD,
		database: SUPABASE_DEFAULT_DATABASE,
	};
}

export async function getSupabaseConnection(): Promise<knexlib.Knex | undefined> {
	try {
		const workspaceRoot = getBasePath();
		if (!workspaceRoot) {
			return undefined;
		}

		let connectionDetails: SupabaseStatusParsed;

		try {
			const { stdout } = await execAsync('supabase status', {
				cwd: workspaceRoot,
				timeout: 10000,
			});
			connectionDetails = parseSupabaseStatus(stdout);
		} catch {
			connectionDetails = {
				host: SUPABASE_DEFAULT_HOST,
				port: SUPABASE_DEFAULT_PORT,
				user: SUPABASE_DEFAULT_USER,
				password: SUPABASE_DEFAULT_PASSWORD,
				database: SUPABASE_DEFAULT_DATABASE,
			};
		}

		logToOutput(
			`Connecting to Supabase PostgreSQL at ${connectionDetails.host}:${connectionDetails.port}`,
			'Supabase'
		);

		return getConnectionFor(
			'Supabase provider',
			'postgres',
			connectionDetails.host,
			connectionDetails.port,
			connectionDetails.user,
			connectionDetails.password,
			connectionDetails.database
		);
	} catch (error) {
		logToOutput(`Failed to get Supabase connection: ${String(error)}`, 'Supabase');
		return undefined;
	}
}
