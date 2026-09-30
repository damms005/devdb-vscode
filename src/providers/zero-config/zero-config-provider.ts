import * as vscode from 'vscode'
import { existsSync } from 'fs'
import { basename } from 'path'
import { DatabaseEngine, DatabaseEngineProvider } from '../../types'
import { SqliteEngine } from '../../database-engines/sqlite-engine'
import { MssqlEngine } from '../../database-engines/mssql-engine'
import { getConnectionFor } from '../../services/connector'
import { createRemoteEngine } from '../../services/connection-tester'
import { hasProLicense, PRO_ENGINE_TYPES } from '../../services/pro-gate'
import { errorMessage } from '../../services/remote-credential-service'
import { logToOutput } from '../../services/output-service'
import { connectionKey, DEFAULT_PORTS, DetectedDatastore, ENGINE_LABELS, ZeroConfigSource } from './detected-datastore'

const PROBE_TIMEOUT_MS = 10000

export interface ZeroConfigProvider extends DatabaseEngineProvider {
	detection: DetectedDatastore
	/**
	 * True when the engine needs DevDb Pro and no license is active. The row is shown locked and
	 * the datastore is never contacted.
	 */
	isProLocked(): boolean
}

/**
 * A detection plus the other sources that point at the same database.
 */
export interface MergedDetection {
	detection: DetectedDatastore
	alsoFoundIn: string[]
}

/**
 * Runs every source over every root. Detections of the same database (see {@link connectionKey})
 * collapse into the first one found; later sources are listed in `alsoFoundIn`.
 */
export function collectDetections(roots: string[], sources: ZeroConfigSource[]): MergedDetection[] {
	const merged = new Map<string, MergedDetection>()

	for (const root of roots) {
		for (const source of sources) {
			let detections: DetectedDatastore[] = []
			try {
				detections = source.detect(root)
			} catch (error) {
				logToOutput(`${source.name} detection failed in ${root}: ${errorMessage(error)}`, 'Zero-config')
			}

			for (const found of detections) {
				const detection = roots.length > 1 ? { ...found, source: `${found.source} · ${basename(root)}` } : found
				const key = connectionKey(detection)
				const existing = merged.get(key)

				if (!existing) {
					merged.set(key, { detection, alsoFoundIn: [] })
				} else if (existing.detection.source !== detection.source && !existing.alsoFoundIn.includes(detection.source)) {
					existing.alsoFoundIn.push(detection.source)
				}
			}
		}
	}

	return [...merged.values()]
}

export function describeTarget(detection: DetectedDatastore): string {
	if (detection.engine === 'sqlite') return detection.path ?? ''

	const port = detection.port ?? DEFAULT_PORTS[detection.engine]
	const database = detection.database ? `/${detection.database}` : ''

	return `${detection.host ?? 'localhost'}:${port}${database}`
}

function withTimeout<T>(promise: Promise<T>, onLate: (value: T) => void): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined
	let timedOut = false

	const timeout = new Promise<undefined>(resolve => {
		timer = setTimeout(() => {
			timedOut = true
			resolve(undefined)
		}, PROBE_TIMEOUT_MS)
	})

	return Promise.race([
		promise.then(value => {
			if (timedOut) onLate(value)
			return value
		}),
		timeout,
	]).finally(() => clearTimeout(timer))
}

/**
 * Opens and health-checks an engine for a detection. Returns undefined when the datastore is
 * missing or does not answer.
 */
export async function openDetectedEngine(detection: DetectedDatastore, id: string, name: string): Promise<DatabaseEngine | undefined> {
	const open = async (): Promise<DatabaseEngine | undefined> => {
		switch (detection.engine) {
			case 'sqlite': {
				if (!detection.path || !existsSync(detection.path)) return undefined
				const engine = new SqliteEngine(detection.path)
				return (await engine.isOkay()) ? engine : undefined
			}

			case 'mssql': {
				const connection = await getConnectionFor(name, 'mssql', detection.host ?? 'localhost', detection.port ?? DEFAULT_PORTS.mssql, detection.username ?? 'sa', detection.password ?? '', detection.database, false, {
					encrypt: detection.encrypt !== false,
					trustServerCertificate: detection.trustServerCertificate === true,
				})
				if (!connection) return undefined

				const engine = new MssqlEngine(connection)
				if (await engine.isOkay()) return engine

				await engine.disconnect()
				return undefined
			}

			default: {
				const result = await createRemoteEngine({
					id,
					name,
					type: detection.engine,
					host: detection.host ?? 'localhost',
					port: detection.port,
					username: detection.username,
					database: detection.database,
					ssl: detection.ssl,
					allowUnauthorizedCertificate: detection.allowUnauthorizedCertificate,
					tls: detection.tls,
					protocol: detection.protocol,
				}, { password: detection.password, connectionString: detection.connectionString })

				if (!result.engine) {
					logToOutput(`${name}: ${result.error}`, 'Zero-config')
					return undefined
				}

				return result.engine
			}
		}
	}

	try {
		return await withTimeout(open(), engine => { engine?.disconnect?.() })
	} catch (error) {
		logToOutput(`${name}: ${errorMessage(error)}`, 'Zero-config')
		return undefined
	}
}

export function zeroConfigProviderId(detection: DetectedDatastore): string {
	return `zero-config:${detection.source}:${connectionKey(detection)}`
}

/**
 * Wraps a detection as a provider row: `Redis (docker-compose: cache)`.
 */
export function createZeroConfigProvider({ detection, alsoFoundIn }: MergedDetection): ZeroConfigProvider {
	const name = `${ENGINE_LABELS[detection.engine]} (${detection.source})`
	const id = zeroConfigProviderId(detection)
	const also = alsoFoundIn.length ? ` · also in ${alsoFoundIn.join(', ')}` : ''

	const provider: ZeroConfigProvider = {
		name,
		type: detection.engine,
		id,
		description: `${describeTarget(detection)}${also}`,
		detection,
		engine: undefined,

		isProLocked(): boolean {
			return PRO_ENGINE_TYPES.includes(detection.engine) && !hasProLicense()
		},

		async canBeUsedInCurrentWorkspace(): Promise<boolean> {
			if (provider.isProLocked()) return false

			if (provider.engine && await provider.engine.isOkay().catch(() => false)) return true

			provider.engine = await openDetectedEngine(detection, id, name)
			return Boolean(provider.engine)
		},

		reconnect(): Promise<boolean> {
			return provider.canBeUsedInCurrentWorkspace()
		},

		async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
			if (provider.isProLocked()) return undefined
			if (!provider.engine) await provider.canBeUsedInCurrentWorkspace()

			return provider.engine
		},
	}

	return provider
}

/**
 * Workspace folders searched for zero-config datastores. `Devdb.customBasePath` wins when set.
 */
export function workspaceRoots(): string[] {
	const customBasePath = vscode.workspace.getConfiguration('Devdb').get<string>('customBasePath')
	if (customBasePath && customBasePath.trim() !== '' && existsSync(customBasePath)) return [customBasePath]

	return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
}

/**
 * Keeps providers (and their open engines) across refreshes while the detection is unchanged.
 */
const knownProviders = new Map<string, ZeroConfigProvider>()

export function detectZeroConfigProviders(sources: ZeroConfigSource[], roots: string[] = workspaceRoots()): ZeroConfigProvider[] {
	const detected = collectDetections(roots, sources)
	const current: ZeroConfigProvider[] = []

	for (const merged of detected) {
		const fresh = createZeroConfigProvider(merged)
		const known = knownProviders.get(fresh.id)
		const unchanged = known && JSON.stringify(known.detection) === JSON.stringify(fresh.detection)

		if (known && unchanged) {
			known.description = fresh.description
			current.push(known)
		} else {
			current.push(fresh)
		}
	}

	knownProviders.clear()
	for (const provider of current) knownProviders.set(provider.id, provider)

	return current
}

export function getKnownZeroConfigProviders(): ZeroConfigProvider[] {
	return [...knownProviders.values()]
}
