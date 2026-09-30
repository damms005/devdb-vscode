export interface ParsedVersion {
	core: [number, number, number];
	prerelease: string[];
}

/**
 * Parses `major[.minor[.patch]][-prerelease][+build]`. Returns undefined for
 * anything else.
 */
export function parseVersion(version: string): ParsedVersion | undefined {
	const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
	if (!match) {
		return undefined;
	}

	return {
		core: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
		prerelease: match[4] ? match[4].split('.') : [],
	};
}

/**
 * Semver-style compare: numeric core first, then a prerelease sorts before
 * the release with the same core. Returns <0, 0 or >0.
 */
export function compareVersions(a: string, b: string): number {
	const left = parseVersion(a) ?? { core: [0, 0, 0], prerelease: [] };
	const right = parseVersion(b) ?? { core: [0, 0, 0], prerelease: [] };

	for (let i = 0; i < 3; i++) {
		if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
	}

	if (!left.prerelease.length || !right.prerelease.length) {
		return right.prerelease.length - left.prerelease.length;
	}

	const length = Math.max(left.prerelease.length, right.prerelease.length);
	for (let i = 0; i < length; i++) {
		const l = left.prerelease[i];
		const r = right.prerelease[i];
		if (l === undefined) return -1;
		if (r === undefined) return 1;
		if (l === r) continue;

		const lNum = /^\d+$/.test(l);
		const rNum = /^\d+$/.test(r);
		if (lNum && rNum) return Number(l) - Number(r);
		if (lNum) return -1;
		if (rNum) return 1;
		return l < r ? -1 : 1;
	}

	return 0;
}
