/**
 * If the string is longer than 30 chars, it will be shortened to 30 chars with ellipsis. It will be shortened by
 * adding the first 14 chars and the last 13 chars of the string together with an ellipsis in the middle.
 * e.g. /home/damms005/.SchoolServer/test-workspace/database.db3 becomes /home/damms005.../database.db3
 */
export function brief(str: string) {
	if (str.length <= 30) return str

	const firstPart = str.substring(0, 14)
	const lastPart = str.substring(str.length - 13)

	return `${firstPart}...${lastPart}`
}