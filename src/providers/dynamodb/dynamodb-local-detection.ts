import { parse as parseEnv } from 'dotenv'
import { parse as parseYaml } from 'yaml'

/**
 * A DynamoDB-compatible endpoint found in the workspace (DynamoDB Local or LocalStack).
 */
export type DetectedDynamodbEndpoint = {
	endpoint: string
	/** Where it was found, e.g. `docker-compose.yml service "dynamodb"` or `.env AWS_ENDPOINT_URL_DYNAMODB`. */
	source: string
	region?: string
	/** Only set from `.env` for loopback endpoints (DynamoDB Local keys its data by access key ID and region). */
	accessKeyId?: string
	secretAccessKey?: string
}

export const COMPOSE_FILE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'docker-compose.override.yml', 'docker-compose.override.yaml']

export const ENV_FILE_NAMES = ['.env', '.env.local']

const ENV_ENDPOINT_KEYS = ['AWS_ENDPOINT_URL_DYNAMODB', 'DYNAMODB_ENDPOINT']

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal']

/**
 * Finds `amazon/dynamodb-local` services and `localstack/localstack` services that run DynamoDB
 * (SERVICES unset, or listing `dynamodb`) in a compose file, and returns the host endpoint for each
 * one that publishes its port (8000 for DynamoDB Local, 4566 for LocalStack).
 */
export function findDynamodbEndpointsInCompose(text: string, fileName = 'docker-compose.yml'): DetectedDynamodbEndpoint[] {
	let document: any
	try {
		document = parseYaml(text)
	} catch {
		return []
	}

	const services = document?.services
	if (!services || typeof services !== 'object') return []

	const endpoints: DetectedDynamodbEndpoint[] = []
	for (const [serviceName, service] of Object.entries<any>(services)) {
		const image = String(service?.image ?? '').toLowerCase()
		const environment = environmentOf(service?.environment)
		let containerPort: number | undefined

		if (/(^|\/)amazon\/dynamodb-local(:|$)/.test(image) || /(^|\/)dynamodb-local(:|$)/.test(image)) {
			containerPort = dynamodbLocalPortFromCommand(service?.command) ?? 8000
		} else if (/(^|\/)localstack\/localstack(-pro)?(:|$)/.test(image)) {
			const enabledServices = environment.SERVICES
			if (enabledServices !== undefined && !enabledServices.split(',').map(name => name.trim().toLowerCase()).includes('dynamodb')) continue
			containerPort = 4566
		} else {
			continue
		}

		const hostPort = publishedPortFor(service?.ports, containerPort)
		if (hostPort === undefined) continue

		endpoints.push({
			endpoint: `http://localhost:${hostPort}`,
			source: `${fileName} service "${serviceName}"`,
			region: environment.AWS_DEFAULT_REGION || environment.AWS_REGION || environment.DEFAULT_REGION || undefined,
		})
	}

	return endpoints
}

/**
 * Reads `AWS_ENDPOINT_URL_DYNAMODB` or `DYNAMODB_ENDPOINT` (plus the region) from a `.env` file.
 * For a loopback endpoint it also takes `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, because
 * DynamoDB Local without `-sharedDb` keeps one database per access key ID and region.
 */
export function findDynamodbEndpointInEnv(text: string | undefined, fileName = '.env'): DetectedDynamodbEndpoint | undefined {
	if (!text) return undefined

	const env = parseEnv(text)
	const key = ENV_ENDPOINT_KEYS.find(candidate => env[candidate]?.trim())
	if (!key) return undefined

	const endpoint = env[key].trim()
	const detected: DetectedDynamodbEndpoint = {
		endpoint,
		source: `${fileName} ${key}`,
		region: env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined,
	}

	if (isLoopbackEndpoint(endpoint) && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
		detected.accessKeyId = env.AWS_ACCESS_KEY_ID
		detected.secretAccessKey = env.AWS_SECRET_ACCESS_KEY
	}

	return detected
}

export function isLoopbackEndpoint(endpoint: string): boolean {
	try {
		return LOOPBACK_HOSTS.includes(new URL(endpoint).hostname.toLowerCase())
	} catch {
		return false
	}
}

function environmentOf(environment: unknown): Record<string, string> {
	if (Array.isArray(environment)) {
		const result: Record<string, string> = {}
		for (const entry of environment) {
			const [name, ...rest] = String(entry).split('=')
			result[name.trim()] = rest.join('=').trim()
		}
		return result
	}

	if (environment && typeof environment === 'object') {
		return Object.fromEntries(Object.entries(environment).map(([name, value]) => [name, value === null || value === undefined ? '' : String(value)]))
	}

	return {}
}

function dynamodbLocalPortFromCommand(command: unknown): number | undefined {
	const text = Array.isArray(command) ? command.join(' ') : String(command ?? '')
	const match = text.match(/-port\s+(\d+)/)
	return match ? Number(match[1]) : undefined
}

/**
 * Host port published for a container port, from short (`"8000:8000"`, `"127.0.0.1:8001:8000"`,
 * `"8000"` gives none) or long (`{ target, published }`) port syntax.
 */
export function publishedPortFor(ports: unknown, containerPort: number): number | undefined {
	if (!Array.isArray(ports)) return undefined

	for (const entry of ports) {
		if (entry && typeof entry === 'object') {
			const { target, published } = entry as { target?: unknown, published?: unknown }
			if (Number(target) === containerPort && published !== undefined && /^\d+$/.test(String(published))) {
				return Number(published)
			}
			continue
		}

		const spec = String(entry).replace(/\/(tcp|udp)$/, '')
		const parts = spec.split(':')
		const container = parts[parts.length - 1]
		if (Number(container) !== containerPort) continue

		// "8000" alone publishes to a random host port, which cannot be known from the file.
		if (parts.length === 1) continue

		const host = parts[parts.length - 2]
		if (/^\d+$/.test(host)) return Number(host)
	}

	return undefined
}
