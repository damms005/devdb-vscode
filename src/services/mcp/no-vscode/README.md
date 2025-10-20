Modules in this folder should be self-contained and not access any VS Code APIs

This is because they contain dependencies that are consumed directly by the external MCP server. The MCP server runs in its own process space, not having access to VS Code APIs which are created at runtime.

Also, since we are using STDIO transport, no writing to stdio from our script, e.g. using console.log, etc. See https://modelcontextprotocol.io/docs/develop/build-server#logging-in-mcp-servers
