import { strict as assert } from 'node:assert';
import { extractUseStatements, getAst, isNamespaced } from '../../../services/laravel/code-runner/qualifier-service';

describe('extractUseStatements', () => {
	it('should extract plain use statements correctly', () => {
		const code = `
      <?php
				namespace App;

				use App\\Models\\User;
				use Illuminate\\Support\\Collection;
    `;
		const ast = getAst(code);
		const result = extractUseStatements(ast);
		assert.equal(result, `use App\\Models\\User;\nuse Illuminate\\Support\\Collection;\n`);
	});

	it('should extract aliased use statements correctly', () => {
		const code = `
      <?php
				namespace App;

				use Illuminate\\Database\\Eloquent\\Collection as EloquentCollection;
    `;
		const ast = getAst(code);
		const result = extractUseStatements(ast);
		assert.equal(result, `use Illuminate\\Database\\Eloquent\\Collection as EloquentCollection;\n`);
	});

	it('should return an empty string when there are no use statements', () => {
		const code = `
      <?php
				namespace App\\NamespaceOne {
					class User {}
				}
    `;
		const ast = getAst(code);
		const result = extractUseStatements(ast);
		assert.equal(result, '');
	});

	it('should handle a mix of use statements with and without aliases', () => {
		const code = `
      <?php
				namespace App\\Controllers;

				use App\\Models\\User;
				use Illuminate\\Database\\Eloquent\\Collection as EloquentCollection;
    `;
		const ast = getAst(code);
		const result = extractUseStatements(ast);
		assert.equal(result, `use App\\Models\\User;\nuse Illuminate\\Database\\Eloquent\\Collection as EloquentCollection;\n`);
	});
});

describe('isNamespaced', () => {
	it('should return true for code with a namespace', () => {
		const code = `
      <?php
				namespace App;

				class User {}
    `;
		const ast = getAst(code);
		const result = isNamespaced(ast);
		assert.equal(result, true);
	});

	it('should return false for code without a namespace', () => {
		const code = `
      <?php
				class User {}
    `;
		const ast = getAst(code);
		const result = isNamespaced(ast);
		assert.equal(result, false);
	});
});

it('handles multiple use statements in a group', () => {
	const code = `
				<?php
					namespace App\\Controllers;

					use App\\Models\\{User, Post};

					class PostController {
							public function index() {
									$user = User::first();
							}
					}`;

	const ast = getAst(code);
	const result = extractUseStatements(ast);
	assert.strictEqual(result, `use User;\nuse Post;\n`);
});
