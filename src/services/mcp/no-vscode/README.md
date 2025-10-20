Modules in this folder should be self-contained and not access any VS Code APIs

This is because they contain dependencies that are consumed directly by the external MCP server. The MCP server runs in its own process space, not having access to VS Code APIs which are created at runtime.
