const eslint = require('@typescript-eslint/eslint-plugin')
const parser = require('@typescript-eslint/parser')

module.exports = [
	{
		ignores: ['out/**', 'dist/**', '**/*.d.ts']
	},
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: parser,
			ecmaVersion: 6,
			sourceType: 'module'
		},
		plugins: {
			'@typescript-eslint': eslint
		},
		rules: {
			'@typescript-eslint/naming-convention': 'off',
			'@typescript-eslint/semi': 'off',
			'curly': 'off',
			'no-throw-literal': 'warn',
			'semi': 'off'
		}
	}
]