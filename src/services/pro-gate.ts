let licenseChecker: (() => boolean) | null = null

/**
 * Engine types that need a DevDb Pro license, wherever they are opened from
 * (remote connection, .devdbrc entry, or local provider).
 */
export const PRO_ENGINE_TYPES: readonly string[] = ['redis', 'clickhouse', 'duckdb', 'd1', 'libsql']

/**
 * Local providers that open Pro datastores.
 */
export const PRO_PROVIDER_IDS: readonly string[] = ['file-picker-duckdb', 'neon-postgres', 'turso']

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

export function proRequiredMessage(feature: string): string {
	return `DevDb Pro required: ${feature} is a DevDb Pro feature. Activate a DevDb Pro license to use it.`
}
