import { Engine, Program } from 'php-parser';

export function getAst(code: string): Program {
	const parser = new Engine({
		parser: {
			php7: true
		},
		ast: {
			withPositions: true
		}
	});

	return parser.parseCode(code, 'file.php');
}

export function extractUseStatements(ast: Program): string {
	let useStatements = '';

	if (ast.children) {
		ast.children.forEach((node: any) => {
			if (node.kind === 'namespace' && node.name) {
				if (node.children) {
					node.children.forEach((childNode: any) => {
						if (childNode.kind === 'usegroup') {
							childNode.items.forEach((useItem: any) => {
								const alias = useItem.alias ? ` as ${getAlias(useItem.alias)}` : '';
								useStatements += `use ${useItem.name}${alias};\n`;
							});
						}
					});
				}
			}
		});
	}

	return useStatements;
}

function getAlias(alias: any) {
	return typeof alias === 'object'
		? `${alias.name}`
		: alias;
}

export function isNamespaced(ast: Program): boolean {
	return ast.children.some((node: any) => node.kind === 'namespace');
}