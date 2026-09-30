import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type AwsProfile = {
	name: string
	/** Region set in ~/.aws/config for this profile, if any. */
	region?: string
	/** True when the profile signs in with AWS IAM Identity Center (SSO). */
	sso: boolean
}

/**
 * Lists the AWS profiles in the shared config and credentials files (`AWS_CONFIG_FILE` and
 * `AWS_SHARED_CREDENTIALS_FILE` override the default ~/.aws paths). Only profile names, regions
 * and the SSO flag are read; key values are never returned.
 */
export function listAwsProfiles(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): AwsProfile[] {
	const configPath = env.AWS_CONFIG_FILE || join(home, '.aws', 'config')
	const credentialsPath = env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials')

	const profiles = new Map<string, AwsProfile>()
	const upsert = (name: string, settings: Record<string, string>) => {
		const existing = profiles.get(name) ?? { name, sso: false }
		existing.region ??= settings.region
		existing.sso ||= Boolean(settings.sso_session || settings.sso_start_url)
		profiles.set(name, existing)
	}

	for (const [section, settings] of parseIniSections(readIfExists(configPath))) {
		if (section === 'default') {
			upsert('default', settings)
		} else if (section.startsWith('profile ')) {
			upsert(section.slice('profile '.length).trim(), settings)
		}
	}

	for (const [section, settings] of parseIniSections(readIfExists(credentialsPath))) {
		upsert(section, settings)
	}

	return [...profiles.values()].sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name)))
}

function readIfExists(path: string): string {
	try {
		return existsSync(path) ? readFileSync(path, 'utf8') : ''
	} catch {
		return ''
	}
}

/**
 * Minimal INI reader for AWS shared config files: `[section]` headers and `key = value` lines.
 * Indented lines (nested settings such as `s3 =` blocks) and comments are skipped.
 */
export function parseIniSections(text: string): Map<string, Record<string, string>> {
	const sections = new Map<string, Record<string, string>>()
	let current: Record<string, string> | null = null

	for (const line of text.split(/\r?\n/)) {
		if (/^\s*[#;]/.test(line) || !line.trim()) continue

		const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
		if (header) {
			const name = header[1].trim()
			current = sections.get(name) ?? {}
			sections.set(name, current)
			continue
		}

		if (!current || /^\s/.test(line)) continue

		const pair = line.match(/^([^=]+?)\s*=\s*(.*)$/)
		if (pair) {
			current[pair[1].trim()] = pair[2].trim()
		}
	}

	return sections
}
