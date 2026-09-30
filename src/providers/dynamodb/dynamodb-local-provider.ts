import { DatabaseEngine, DatabaseEngineProvider, DynamodbConfig } from '../../types'
import { DynamodbEngine } from '../../database-engines/dynamodb-engine'
import { getWorkspaceFileContent } from '../../services/workspace'
import { logToOutput } from '../../services/output-service'
import { hasProLicense } from '../../services/pro-gate'
import { COMPOSE_FILE_NAMES, DetectedDynamodbEndpoint, ENV_FILE_NAMES, findDynamodbEndpointInEnv, findDynamodbEndpointsInCompose } from './dynamodb-local-detection'

/**
 * Zero-config DynamoDB Local / LocalStack: finds an endpoint in the workspace compose files
 * (`amazon/dynamodb-local`, `localstack/localstack` with DynamoDB) or in `.env`
 * (`AWS_ENDPOINT_URL_DYNAMODB`, `DYNAMODB_ENDPOINT`).
 *
 * DynamoDB is a Pro datastore. Without a license the provider still reports a detected endpoint
 * (the webview shows it as a locked row) but opens no connection; the host refuses to connect.
 */
export const DynamoDbLocalProvider: DatabaseEngineProvider & { detected?: DetectedDynamodbEndpoint } = {
	name: 'DynamoDB Local',
	type: 'dynamodb',
	id: 'dynamodb-local',
	description: 'DynamoDB Local / LocalStack endpoint found in this workspace',
	engine: undefined as DynamodbEngine | undefined,
	detected: undefined,

	async canBeUsedInCurrentWorkspace(): Promise<boolean> {
		const candidates = detectDynamodbEndpoints()
		if (!candidates.length) {
			return false
		}

		if (!hasProLicense()) {
			this.detected = candidates[0]
			this.description = `${candidates[0].endpoint} (${candidates[0].source})`
			logToOutput('DynamoDB Local found; DevDb Pro is needed to open it', 'DynamoDB Local')
			return true
		}

		for (const candidate of candidates) {
			const engine = new DynamodbEngine(configFor(candidate))
			try {
				await engine.connect()
				this.engine = engine
				this.detected = candidate
				this.description = `${candidate.endpoint} (${candidate.source})`
				return true
			} catch (error) {
				logToOutput(`DynamoDB endpoint ${candidate.endpoint} from ${candidate.source} is not reachable: ${error instanceof Error ? error.message : String(error)}`, 'DynamoDB Local')
			}
		}

		return false
	},

	reconnect(): Promise<boolean> {
		return this.canBeUsedInCurrentWorkspace()
	},

	async getDatabaseEngine(): Promise<DatabaseEngine | undefined> {
		if (!this.engine && this.detected && hasProLicense()) {
			const engine = new DynamodbEngine(configFor(this.detected))
			try {
				await engine.connect()
				this.engine = engine
			} catch (error) {
				logToOutput(`DynamoDB endpoint ${this.detected.endpoint} is not reachable: ${error instanceof Error ? error.message : String(error)}`, 'DynamoDB Local')
			}
		}

		return this.engine
	},
}

/**
 * Endpoints from compose files first, then `.env` files, without duplicates.
 */
export function detectDynamodbEndpoints(): DetectedDynamodbEndpoint[] {
	const found: DetectedDynamodbEndpoint[] = []

	for (const fileName of COMPOSE_FILE_NAMES) {
		const text = getWorkspaceFileContent(fileName)?.toString()
		if (text) found.push(...findDynamodbEndpointsInCompose(text, fileName))
	}

	for (const fileName of ENV_FILE_NAMES) {
		const detected = findDynamodbEndpointInEnv(getWorkspaceFileContent(fileName)?.toString(), fileName)
		if (!detected) continue

		const sameEndpoint = found.find(candidate => normalizeEndpoint(candidate.endpoint) === normalizeEndpoint(detected.endpoint))
		if (sameEndpoint) {
			sameEndpoint.region ??= detected.region
			sameEndpoint.accessKeyId ??= detected.accessKeyId
			sameEndpoint.secretAccessKey ??= detected.secretAccessKey
		} else {
			found.push(detected)
		}
	}

	return found
}

function normalizeEndpoint(endpoint: string): string {
	return endpoint.replace(/\/+$/, '').replace('127.0.0.1', 'localhost').toLowerCase()
}

function configFor(candidate: DetectedDynamodbEndpoint): DynamodbConfig {
	return {
		name: 'DynamoDB Local',
		type: 'dynamodb',
		endpoint: candidate.endpoint,
		region: candidate.region,
		authMethod: 'keys',
		accessKeyId: candidate.accessKeyId,
		secretAccessKey: candidate.secretAccessKey,
	}
}
