import { Engine } from 'php-parser';

export function extractUseStatements(code: string): string {
	const parser = new Engine({
		parser: {
			php7: true
		},
		ast: {
			withPositions: true
		}
	});

	return getUseStatements(parser.parseCode(code, 'file.php'));
}

function getUseStatements(ast: any): string {
	let useStatements = '';

	if (ast.children) {
		ast.children.forEach((node: any) => {
			if (node.kind === 'namespace' && node.name) {
				if (node.children) {
					node.children.forEach((childNode: any) => {
						if (childNode.kind === 'usegroup') {
							childNode.items.forEach((useItem: any) => {
								useStatements += `use ${useItem.name};\n`;
							});
						}
					});
				}
			}
		});
	}

	return useStatements;
}