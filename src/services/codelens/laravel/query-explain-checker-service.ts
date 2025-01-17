import * as vscode from 'vscode';
import { Program, Node } from 'php-parser';
import { isNamespaced } from '../../laravel/code-runner/qualifier-service';
import { database } from '../../messenger';
import { showMissingDatabaseNotification } from '../../error-notification-service';

export function passesBasicExplainerCheck(document: vscode.TextDocument, selection: vscode.Selection, documentAst: Program, quietly = false): boolean {
	if (!database) {
		if (!quietly) showMissingDatabaseNotification()
		return false
	}

	if (database.getType() !== 'mysql') {
		if (!quietly) vscode.window.showErrorMessage('This feature is only available for MySQL databases.');
		return false
	}

	const isNamespacedCode = isNamespaced(documentAst);

	if (!isNamespacedCode) {
		if (!quietly) vscode.window.showErrorMessage('This feature is only available for namespaced PHP code.');
		return false
	}

	let selectionText = document.getText(selection).trim();
	if (!selectionText) {
		if (!quietly) vscode.window.showInformationMessage('No SQL query was selected');
		return false
	}

	return true
}

export function validateSelectedPhpCode(selectionAst: Program): { isValid: boolean; reason: string } {
	if (selectionAst.errors && selectionAst.errors.length > 0) {
		return {
			isValid: false,
			reason: `Parse errors found: ${selectionAst.errors.map(e => e.message).join(', ')}`
		};
	}

	if (!isLaravelDbRelatedCode(selectionAst)) {
		return {
			isValid: false,
			reason: 'No Laravel database or Eloquent code found in selection'
		};
	}

	if (!isValidPhpProgram(selectionAst)) {
		return {
			isValid: false,
			reason: 'Invalid or incomplete PHP syntax'
		};
	}

	return { isValid: true, reason: '' };
}

function isLaravelDbRelatedCode(node: Node): boolean {
	// Handle inline code
	if (node.kind === 'inline') {
		// The inline node might contain expressions that use DB
		const value = (node as any).value;

		// If the inline value is itself a node, recursively check it
		if (value && typeof value === 'object' && 'kind' in value) {
			return isLaravelDbRelatedCode(value);
		}

		// For raw inline expressions, check for common DB patterns
		if (typeof value === 'string') {
			return value.includes('DB::') ||
				value.includes('Illuminate\\Database') ||
				value.includes('Illuminate\\Support\\Facades\\DB');
		}
	}

	// Check if node is a class that extends Eloquent Model
	if (node.kind === 'class') {
		const extendsNode = (node as any).extends;
		if (extendsNode && extendsNode.name === 'Model') {
			return true;
		}
	}

	// Check for use of Illuminate\Database facades
	if (node.kind === 'usegroup') {
		const uses = (node as any).items;
		if (uses && Array.isArray(uses)) {
			return uses.some(use => {
				const name = use.name || '';
				return (
					name.includes('Illuminate\\Database') ||
					name.includes('Illuminate\\Support\\Facades\\DB')
				);
			});
		}
	}

	// Check for DB facade usage
	if (node.kind === 'staticlookup') {
		const what = (node as any).what;
		if (what && what.name === 'DB') {
			return true;
		}
	}

	// Recursively check children
	if ('children' in node && Array.isArray(node.children)) {
		return node.children.some(child => isLaravelDbRelatedCode(child));
	}
	if ('body' in node && Array.isArray(node.body)) {
		return node.body.some(child => isLaravelDbRelatedCode(child));
	}

	return false;
}

function isValidPhpProgram(ast: Program): boolean {
	// Basic AST validation
	if (!ast.children || !Array.isArray(ast.children)) {
		return false;
	}

	// Check for complete syntax
	function hasValidSyntax(node: Node): boolean {
		if (!node.kind) {
			return false;
		}

		// Recursively check children
		if ('children' in node && Array.isArray(node.children)) {
			return node.children.every(hasValidSyntax);
		}
		if ('body' in node && Array.isArray(node.body)) {
			return node.body.every(hasValidSyntax);
		}

		return true;
	}

	return ast.errors.length === 0 && hasValidSyntax(ast)
}
