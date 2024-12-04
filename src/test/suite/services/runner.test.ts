import * as assert from 'assert';
import { extractUseStatements } from '../../../services/laravel/code-runner/qualifier';

describe('Use Statement Tests', () => {
    it('adds use statements before code and selection', () => {
        const fullCode = `<?php
                            namespace App\\Controllers;

                            use App\\Models\\User;
                            use App\\Models\\Post;

                            class PostController {
                                public function index() {
                                    $user = User::first();
                                }
                            }`;

        const result = extractUseStatements(fullCode);
        assert.strictEqual(result, `use App\\Models\\User;\nuse App\\Models\\Post;\n`);
    });

    it('handles multiple use statements in a group', () => {
        const fullCode = `<?php
                            namespace App\\Controllers;

                            use App\\Models\\{User, Post};

                            class PostController {
                                public function index() {
                                    $user = User::first();
                                }
                            }`;

        const result = extractUseStatements(fullCode);
        assert.strictEqual(result, `use User;\nuse Post;\n`);
    });
});