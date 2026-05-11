const BLOCKED_PATTERNS = [
    /^\s*DROP\s+DATABASE\b/i,
    /^\s*DROP\s+SCHEMA\b/i,
    /^\s*TRUNCATE\s+/i,
];

const WARNING_PATTERNS = [
    { pattern: /^\s*DROP\s+/i, label: 'DROP' },
    { pattern: /^\s*ALTER\s+/i, label: 'ALTER' },
    { pattern: /^\s*CREATE\s+USER\b/i, label: 'CREATE USER' },
    { pattern: /^\s*GRANT\s+/i, label: 'GRANT' },
    { pattern: /^\s*REVOKE\s+/i, label: 'REVOKE' },
];

const DELETE_WITHOUT_WHERE = /^\s*DELETE\s+(?!.*\bWHERE\b)/is;

export type QueryValidationResult = {
    allowed: boolean;
    warning?: string;
};

export function validateQuery(query: string): QueryValidationResult {
    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(query)) {
            return {
                allowed: false,
                warning: `Query blocked: ${query.trim().split(/\s+/).slice(0, 3).join(' ').toUpperCase()} is not allowed via MCP`,
            };
        }
    }

    if (DELETE_WITHOUT_WHERE.test(query)) {
        return {
            allowed: true,
            warning: 'Warning: DELETE without WHERE clause detected',
        };
    }

    for (const { pattern, label } of WARNING_PATTERNS) {
        if (pattern.test(query)) {
            return {
                allowed: true,
                warning: `Warning: ${label} statement detected`,
            };
        }
    }

    return { allowed: true };
}

export function getQueryType(query: string): string {
    const match = query.trim().match(/^\s*(\w+)/);
    return match ? match[1].toUpperCase() : 'UNKNOWN';
}
