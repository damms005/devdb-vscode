import * as assert from 'assert';
import { extractVariables, replaceVariables } from '../../../services/string';

describe('Variable Replacement', () => {
	describe('extractVariables', () => {
		it('should extract single object property variable', () => {
			const text = 'SessionInfo::where("program_id", $program->id)';
			const variables = extractVariables(text);
			assert.deepStrictEqual(variables, ['$program->id']);
		});

		it('should extract multiple object property variables', () => {
			const text = 'SessionInfo::where("program_id", $program->id)->where("type", $program->type->name)';
			const variables = extractVariables(text);
			assert.deepStrictEqual(variables, ['$program->id', '$program->type->name']);
		});

		it('should extract nested object property variables', () => {
			const text = 'SessionInfo::where("type_id", $program->type->another->thing_id)';
			const variables = extractVariables(text);
			assert.deepStrictEqual(variables, ['$program->type->another->thing_id']);
		});
	});

	describe('replaceVariables', () => {
		it('should replace single object property variable', () => {
			const text = 'SessionInfo::where("program_id", $program->id)';
			const variableValues = {
				'$program->id': '123'
			};
			const result = replaceVariables(text, variableValues);
			assert.deepStrictEqual(result, 'SessionInfo::where("program_id", 123)');
		});

		it('should replace multiple object property variables', () => {
			const text = 'SessionInfo::where("program_id", $program->id)->where("type", $program->type->name)';
			const variableValues = {
				'$program->id': '123',
				'$program->type->name': '"active"'
			};
			const result = replaceVariables(text, variableValues);
			assert.deepStrictEqual(result, 'SessionInfo::where("program_id", 123)->where("type", "active")');
		});

		it('should replace nested object property variables', () => {
			const text = 'SessionInfo::where("type_id", $program->type->another->thing_id)';
			const variableValues = {
				'$program->type->another->thing_id': '456'
			};
			const result = replaceVariables(text, variableValues);
			assert.deepStrictEqual(result, 'SessionInfo::where("type_id", 456)');
		});

		it('should handle multiple occurrences of same variable', () => {
			const text = 'SessionInfo::where("program_id", $program->id)->orWhere("backup_id", $program->id)';
			const variableValues = {
				'$program->id': '123'
			};
			const result = replaceVariables(text, variableValues);
			assert.deepStrictEqual(result, 'SessionInfo::where("program_id", 123)->orWhere("backup_id", 123)');
		});
	});
});