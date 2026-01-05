# DevDB MCP Integration Refactoring Specification

## Overview

Refactor the MCP (Model Context Protocol) integration to use a port-based proxying architecture where each VS Code project instance exposes a single HTTP port (starting from 50001), and requests are transparently proxied to the appropriate MCP server instance based on project root directory.

## Goals

1. Single port per VS Code instance starting from 50001
2. Transparent request proxying based on project root directory
3. Seamless integration with MCP clients (especially Claude Code)
4. Persistent port assignments across restarts
5. Convert all MCP resources to tools for consistent API

## Architecture Changes

### 1. Port Assignment Strategy

**Current Behavior:**
- Each project gets a port assigned using workspace ID hash
- Port mapping stored in JSON: `{workspaceId: port}`

**New Behavior:**
- Each VS Code instance gets a port starting from 50001
- If port 50001 is taken, increment to 50002, 50003, etc.
- Port mapping stored in JSON: `{projectRoot: port}` where projectRoot is full absolute path
- Port assignments persist across VS Code restarts (same project gets same port)
- JSON file location: current location (as used by existing implementation)

### 2. Port Lifecycle Management

**Startup (Extension Activation):**
1. Check if MCP feature is enabled via `Devdb.enableMcpServer` setting
2. If disabled at any level (following hierarchy: project > workspace > global), skip MCP server initialization
3. Read workspace folder path (first/active workspace only - no multi-root support)
4. Check JSON mapping for existing port assignment for this project root
5. If port exists, attempt to bind to it
6. If port unavailable, find next available port starting from 50001
7. Update JSON mapping immediately after port allocation: `{projectRoot: port}`
8. Start HTTP server on allocated port
9. Spawn MCP SDK server process (stdio transport)

**Shutdown (Extension Deactivation):**
1. Clean up port mapping entry from JSON file for current project root
2. Stop HTTP server
3. Terminate MCP SDK server process

**Port Conflict Resolution:**
- If assigned port is occupied on restart, silently find next available port and update JSON mapping
- No user intervention required

### 3. JSON File Structure

**File Location:** Use existing location from current implementation

**Structure:**
```json
{
  "/Users/user/project1": 50001,
  "/Users/user/project2": 50002,
  "/home/user/workspace": 50003
}
```

**Key Format:** Full absolute path (platform-specific)

**Cleanup:**
- Entries removed on extension deactivation
- No automatic pruning of stale entries
- "Last one wins" if multiple VS Code instances open same project (overwrites port mapping)

### 4. Convert Resources to Tools

**Current Implementation:**
- Resources: `tables`, `schema`, `database-type`
- Tool: `run-query`

**New Implementation (All Tools):**

#### Tool: `get-tables`
```typescript
{
  name: 'get-tables',
  description: 'Get list of tables in database',
  inputSchema: {
    projectRoot: z.string(),
  }
}
```

#### Tool: `get-schema`
```typescript
{
  name: 'get-schema',
  description: 'Get schema for specified table',
  inputSchema: {
    projectRoot: z.string(),
    table: z.string(),
  }
}
```

#### Tool: `get-database-type`
```typescript
{
  name: 'get-database-type',
  description: 'Get database type (e.g. mysql2, postgres, mssql) to determine SQL syntax',
  inputSchema: {
    projectRoot: z.string(),
  }
}
```

#### Tool: `run-query` (Updated)
```typescript
{
  name: 'run-query',
  description: 'Run a SQL query',
  inputSchema: {
    projectRoot: z.string(),
    query: z.string(),
  }
}
```

### 5. Request Flow & Proxying Logic

**Client Request Flow:**
1. MCP client (e.g., Claude Code) connects to MCP server via stdio
2. Client calls tool (e.g., `get-tables`) with `projectRoot` parameter
3. Tool handler receives `projectRoot` parameter
4. Handler validates `projectRoot`:
   - Must be absolute path
   - Must exist on filesystem
   - If validation fails, return MCP standard error response: `{isError: true, content: [{type: 'text', text: 'error message'}]}`
5. Handler calls corresponding fetch function (e.g., `fetchTables(projectRoot)`)
6. Fetch function calls `getServerUrl(projectRoot)`
7. `getServerUrl` calls `getPort(projectRoot)` to lookup port in JSON file
8. If project not found in JSON, return MCP error: "MCP server not running for this project"
9. If port found, construct URL: `http://localhost:{port}`
10. Make HTTP request to that port (e.g., `GET http://localhost:50001/tables`)
11. HTTP server at that port handles request using local database connection
12. Response returned through the chain back to client

**Key Points:**
- Proxying happens transparently in `server.ts` before fetch calls
- HTTP server endpoints (`http-server.ts`) unchanged - they always serve local project's database
- No logging of proxy operations (silent, normal behavior)
- Always use HTTP fetch even if projectRoot matches current instance (consistent code path)
- No local optimization or shortcuts

### 6. File Modifications Required

#### `src/services/mcp/no-vscode/port-manager.ts`

**Changes:**
1. Update `McpConfig` interface:
   ```typescript
   interface McpConfig {
     [projectRoot: string]: number;
   }
   ```

2. Update `savePort` function signature:
   ```typescript
   export function savePort(port: number, projectRoot: string): void
   ```
   - Change parameter from `workspaceId` to `projectRoot`
   - Update logic to use `projectRoot` as key
   - Remove hash logic (store full path directly)

3. Update `getPort` function signature:
   ```typescript
   export function getPort(projectRoot: string): number | null
   ```
   - Remove `process.env.WORKSPACE_ID` check
   - Accept `projectRoot` as parameter
   - Lookup port by `projectRoot` in config
   - Return port or null

4. Update `clearPort` function signature:
   ```typescript
   export function clearPort(projectRoot: string): void
   ```
   - Change parameter from `workspaceId` to `projectRoot`

#### `src/services/mcp/http-server.ts`

**Changes:**
1. Update `getWorkspaceId()`:
   - Rename to `getProjectRoot()`
   - Return full workspace path instead of hash:
     ```typescript
     export function getProjectRoot(): string {
       const workspaceFolders = vscode.workspace.workspaceFolders;
       const workspacePath = workspaceFolders?.[0]?.uri.fsPath;
       if (!workspacePath) {
         throw new Error('No workspace found');
       }
       return workspacePath;
     }
     ```

2. Update `startHttpServer()`:
   - Call `getProjectRoot()` instead of `getWorkspaceId()`
   - Pass `projectRoot` to `savePort(availablePort, projectRoot)`
   - Update logging to use `projectRoot` instead of `workspaceId`

3. Update `stopHttpServer()`:
   - Call `getProjectRoot()` instead of `getWorkspaceId()`
   - Pass `projectRoot` to `clearPort(projectRoot)`

4. Keep all endpoint handlers unchanged:
   - `/tables`, `/tables/:tableName/schema`, `/query`, `/database-type`
   - These serve the local project's database
   - No proxying logic needed here

#### `src/services/mcp/no-vscode/server.ts`

**Changes:**

1. Update server version:
   ```typescript
   const server = new McpServer({
     name: "DevDB",
     version: "1.1.0"  // bump from 1.0.2
   }, { /* capabilities */ });
   ```

2. Remove all `registerResource` calls

3. Add new tool registrations:

   **Tool: get-tables**
   ```typescript
   server.registerTool(
     'get-tables',
     {
       title: 'Get tables',
       description: 'Get list of tables in database',
       inputSchema: {
         projectRoot: z.string()
       }
     },
     async ({ projectRoot }) => {
       if (!path.isAbsolute(projectRoot)) {
         return {
           content: [{
             type: 'text',
             text: 'Error: projectRoot must be an absolute path'
           }],
           isError: true
         };
       }

       if (!fs.existsSync(projectRoot)) {
         return {
           content: [{
             type: 'text',
             text: 'Error: projectRoot does not exist'
           }],
           isError: true
         };
       }

       try {
         const tables = await fetchTables(projectRoot);
         return {
           content: [{
             type: 'text',
             text: JSON.stringify(tables)
           }]
         };
       } catch (error) {
         return {
           content: [{
             type: 'text',
             text: String(error)
           }],
           isError: true
         };
       }
     }
   );
   ```

   **Tool: get-schema**
   ```typescript
   server.registerTool(
     'get-schema',
     {
       title: 'Get table schema',
       description: 'Get schema for specified table',
       inputSchema: {
         projectRoot: z.string(),
         table: z.string()
       }
     },
     async ({ projectRoot, table }) => {
       // Similar validation as get-tables
       // Call fetchTableSchema(projectRoot, table)
     }
   );
   ```

   **Tool: get-database-type**
   ```typescript
   server.registerTool(
     'get-database-type',
     {
       title: 'Get database type',
       description: 'Get database type to determine SQL syntax',
       inputSchema: {
         projectRoot: z.string()
       }
     },
     async ({ projectRoot }) => {
       // Similar validation as get-tables
       // Call fetchDatabaseType(projectRoot)
     }
   );
   ```

   **Tool: run-query (Updated)**
   ```typescript
   server.registerTool(
     'run-query',
     {
       title: 'Run a query',
       description: 'Run a SQL query',
       inputSchema: {
         projectRoot: z.string(),
         query: z.string()
       }
     },
     async ({ projectRoot, query }) => {
       // Add projectRoot validation
       // Call executeQuery(projectRoot, query)
     }
   );
   ```

4. Update `getServerUrl` function:
   ```typescript
   function getServerUrl(projectRoot: string): string {
     const port = getPort(projectRoot);
     if (!port) {
       throw new Error(`MCP server not running for project: ${projectRoot}`);
     }
     return `http://localhost:${port}`;
   }
   ```

5. Update fetch functions:
   ```typescript
   async function fetchTables(projectRoot: string): Promise<string[]> {
     const baseUrl = getServerUrl(projectRoot);
     const resp = await fetch(`${baseUrl}/tables`);
     if (!resp.ok) {
       throw new Error('Could not establish database connection');
     }
     const { tables } = await resp.json();
     return tables;
   }

   async function fetchTableSchema(projectRoot: string, name: string): Promise<string> {
     const baseUrl = getServerUrl(projectRoot);
     const resp = await fetch(`${baseUrl}/tables/${encodeURIComponent(name)}/schema`);
     if (!resp.ok) {
       throw new Error('Could not establish database connection');
     }
     const { schema } = await resp.json();
     return schema;
   }

   async function executeQuery(projectRoot: string, query: string): Promise<any> {
     const baseUrl = getServerUrl(projectRoot);
     const resp = await fetch(`${baseUrl}/query`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ query })
     });
     if (!resp.ok) {
       const errorData = await resp.json().catch(() => ({ message: 'Unknown error' }));
       throw new Error(errorData.message);
     }
     const { result } = await resp.json();
     return result;
   }

   async function fetchDatabaseType(projectRoot: string): Promise<string> {
     const baseUrl = getServerUrl(projectRoot);
     const resp = await fetch(`${baseUrl}/database-type`);
     if (!resp.ok) {
       throw new Error('Could not establish database connection');
     }
     const { type } = await resp.json();
     return type;
   }
   ```

6. Remove `getPort()` call without parameter (now requires `projectRoot`)

### 7. Error Handling

**Validation Errors:**
- Invalid projectRoot (not absolute): "Error: projectRoot must be an absolute path"
- projectRoot doesn't exist: "Error: projectRoot does not exist"
- Project not in port mapping: "MCP server not running for project: {projectRoot}"

**Connection Errors:**
- HTTP request fails: "Could not establish database connection"
- Port lookup fails: "MCP server not running for this project"

**Error Response Format:**
All errors use MCP standard error response:
```typescript
{
  content: [{
    type: 'text',
    text: 'error message'
  }],
  isError: true
}
```

**Failure Modes:**
- If target MCP server is not running or port is stale: Return error to client immediately (no retry, no auto-restart)
- If HTTP request fails: Return connection error to client
- If projectRoot validation fails: Return validation error to client

**User Notifications:**
- On MCP server failure: Show toast notification (info only, no action buttons)
- No notifications for successful operations
- No notifications for proxy operations (transparent)

### 8. Settings Integration

**Existing Setting:** `Devdb.enableMcpServer` (boolean)

**Behavior:**
- Hierarchy: project > workspace > global (most specific wins)
- When disabled: MCP server doesn't start on extension activation
- When enabled: MCP server starts automatically on extension activation
- No runtime enable/disable behavior (takes effect on next activation)

**Current Implementation:** Already exists in package.json, no changes needed

### 9. VS Code Integration

**Commands:**
- No new commands needed
- No port mapping viewer command
- Users can manually check JSON file if needed

**Multi-root Workspaces:**
- Not supported
- Only first/active workspace folder is used
- No special handling for multi-root scenarios

### 10. Testing Strategy

**Manual Testing with Claude Code:**
1. Open project A in VS Code instance 1
2. Verify MCP server starts on port 50001
3. Connect Claude Code via stdio
4. Call `get-tables` with projectRoot pointing to project A
5. Verify tables are returned
6. Open project B in VS Code instance 2
7. Verify MCP server starts on port 50002
8. Call `get-tables` from instance 1 with projectRoot pointing to project B
9. Verify request is proxied and returns project B's tables
10. Close instance 2, verify port mapping is cleaned up
11. Reopen project B, verify it gets port 50002 again (persistence)

**Error Testing:**
1. Call tool with invalid projectRoot (relative path)
2. Call tool with non-existent projectRoot
3. Call tool with projectRoot for closed project
4. Verify proper error messages

**Port Conflict Testing:**
1. Manually bind port 50001
2. Start VS Code with project
3. Verify MCP server finds port 50002
4. Verify JSON mapping is updated

### 11. Documentation Updates

**README.md:**
- No updates needed for now
- MCP section remains minimal
- Can be enhanced later after implementation stabilizes

**Migration Guide:**
- Not needed (breaking change but internal architecture)
- Clients just need to pass `projectRoot` parameter to all tools

### 12. Breaking Changes

1. **Resources → Tools:** All MCP resources converted to tools
   - `db://tables` → `get-tables` tool
   - `db://tables/{table}/schema` → `get-schema` tool
   - `db://database-type` → `get-database-type` tool

2. **Required Parameter:** All tools now require `projectRoot` parameter
   - Clients must pass absolute path to project root
   - No default or inference

3. **Version Bump:** MCP server version: 1.0.2 → 1.1.0

4. **JSON Structure Change:** Port mapping keys change from workspace ID hash to full project root path

## Implementation Checklist

- [ ] Update `port-manager.ts` interface and function signatures
- [ ] Update `http-server.ts` to use project root instead of workspace ID
- [ ] Convert all resources to tools in `server.ts`
- [ ] Add `projectRoot` parameter validation to all tools
- [ ] Update all fetch functions to accept `projectRoot` parameter
- [ ] Update `getServerUrl` and `getPort` to use `projectRoot`
- [ ] Remove `WORKSPACE_ID` environment variable dependencies
- [ ] Update port cleanup on extension deactivation
- [ ] Bump MCP server version to 1.1.0
- [ ] Test with Claude Code
- [ ] Test port persistence across restarts
- [ ] Test port conflict resolution
- [ ] Test error handling for invalid projectRoot
- [ ] Test proxying between multiple VS Code instances
- [ ] Verify settings hierarchy (project > workspace > global)

## Success Criteria

1. ✓ Single port per VS Code instance (50001, 50002, ...)
2. ✓ Transparent proxying based on projectRoot parameter
3. ✓ Port assignments persist across restarts
4. ✓ All resources converted to tools with consistent API
5. ✓ Validation errors return proper MCP error responses
6. ✓ Works seamlessly with Claude Code
7. ✓ JSON mapping uses full project root paths
8. ✓ Extension deactivation cleans up port mapping
9. ✓ Port conflicts resolved automatically
10. ✓ Settings integration working (enable/disable)
