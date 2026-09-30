let licenseChecker: (() => boolean) | null = null

/**
 * Engine types that need a DevDb Pro license, wherever they are opened from
 * (remote connection, .devdbrc entry, or local provider).
 */
export const PRO_ENGINE_TYPES: readonly string[] = ['redis', 'clickhouse', 'duckdb', 'd1', 'libsql', 'dynamodb']

/**
 * Local providers that open Pro datastores.
 */
export const PRO_PROVIDER_IDS: readonly string[] = ['file-picker-duckdb', 'neon-postgres', 'turso', 'dynamodb-local']

export function setProLicenseChecker(checker: () => boolean): void {
	licenseChecker = checker
}

export function hasProLicense(): boolean {
	try {
		return licenseChecker?.() ?? false
	} catch {
		return false
	}
}

const PRO_ENGINE_LABELS: Record<string, string> = {
	redis: 'Redis / Valkey',
	clickhouse: 'ClickHouse',
	duckdb: 'DuckDB',
	dynamodb: 'DynamoDB',
	d1: 'Cloudflare D1 (remote)',
	libsql: 'Turso / libSQL',
}

/**
 * Display name of a Pro engine type, for refusal messages.
 */
export function proEngineLabel(type: string): string {
	return PRO_ENGINE_LABELS[type] ?? type
}

export function proRequiredMessage(feature: string): string {
	return `DevDb Pro required: ${feature} is a DevDb Pro feature. Activate a DevDb Pro license to use it.`
}
