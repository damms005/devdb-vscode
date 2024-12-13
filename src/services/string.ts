/**
 * If the string is longer than 30 chars, it will be shortened to 30 chars with ellipsis. It will be shortened by
 * adding the first 14 chars and the last 13 chars of the string together with an ellipsis in the middle.
 * e.g. /home/damms005/.SchoolServer/test-workspace/database.db3 becomes /home/damms005.../database.db3
 */
export function brief(str: string, length: number = 60) {
	if (str.length <= length) return str

	const halfLength = length / 2

	const firstPart = str.substring(0, halfLength)
	const lastPart = str.substring(str.length - halfLength)

	return `${firstPart}...${lastPart}`
}

/**
 * Extracts unique variables from a given text
 * @param text The input text containing variables
 * @returns An array of unique variables found
 */
export function extractVariables(text: string): string[] {
	const variableRegex = /\$[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*(?:->[\w]+)+/g;
	return [...new Set(text.match(variableRegex) || [])];
}

/**
* Replaces variables in the text with user-provided values
* @param text The original text with variables
* @param variableValues A map of variables to their replacement values
* @returns The text with variables replaced
*/
export function replaceVariables(text: string, variableValues: { [key: string]: string }): string {
	const variableRegex = /\$[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*(?:->[\w]+)+/g;

	return text.replace(variableRegex, (match) => {
			return variableValues[match] || match;
	});
}