# Memryon

Memryon is a local-first, MCP-native memory operating system for multi-agent AI systems. It gives agents and orchestration frameworks a shared memory layer with scope-aware visibility, provenance, contradiction tracking, and LangGraph-compatible exact store semantics.

## What It Does

- Stores memories in one of three scopes: `agent`, `project`, or `global`
- Preserves provenance on every write with `agent_id`, framework, and session metadata
- Tracks corroborations and contradictions instead of flattening everything into one vector index
- Serves memory tools over stdio MCP so other agents can connect without custom RPC glue
- Exposes LangGraph-style `store_*` tools and a native Python `MemryonStore` connector
- Uses SQLite with WAL mode and FTS5 for a local-first deployment model

## Current Implementation Snapshot

Implemented today:

- MCP server with `remember`, `recall`, `forget`, `conflicts`, `corroborate`, `promote`, `project_*`, and `store_*` tools
- SQLite schema for memories, projects, memberships, corroborations, conflicts, candidate buffering, LangGraph store rows, and FTS indexes
- Scope-aware recall fan-out across project, agent, and global visibility
- Hybrid retrieval that combines FTS, lexical similarity, and graph traversal with reciprocal rank fusion
- Adapter modules for Codex, Claude Code, Hermes, and OpenClaw
- Python package `memryon-langgraph` for `graph.compile(store=...)` and explicit tool loading
- Vitest coverage for the MCP server, scope logic, conflicts, projects, adapters, and LangGraph store behavior

Important caveats:

- Agent registration is currently internal. The repo has `registerAgent(...)` in code, but there is not yet a public MCP tool for creating agent records.
- Embedding columns already exist in the schema, but vector retrieval is still scaffolded. The current "vector" leg in hybrid search is lexical similarity, not a live `sqlite-vec` KNN query yet.
- The Python connector ships examples and install metadata, but the repository's automated test coverage is currently centered on the TypeScript side.

## Architecture At A Glance

### Scope model

Every memory lives in exactly one scope:

- `agent`: private to the writing agent
- `project`: shared with agents that belong to the same project
- `global`: visible across the user's projects

Queries fan out in priority order:

1. `project`
2. `agent`
3. `global`

### Core data model

| Table | Purpose |
| --- | --- |
| `agents` | Agent registry with `trust_tier`, display name, and capabilities |
| `projects` | Collaboration boundaries for shared memory |
| `project_agents` | Per-project agent membership and roles |
| `memories` | Core MemCells with scope, provenance, temporal validity, and links |
| `corroborations` | Agents vouching for an existing memory |
| `conflicts` | Contradiction log between memories |
| `candidate_buffer` | Fast-path ingestion staging area |
| `store_items` | Exact LangGraph namespace/key/value rows backed by memories |
| `memories_fts` / `store_items_fts` | FTS5 indexes for retrieval |

### MCP tools

| Tool | Purpose |
| --- | --- |
| `remember` | Store a memory in `agent`, `project`, or `global` scope |
| `recall` | Retrieve visible memories across scopes or from one targeted scope |
| `forget` | Soft-delete a memory by setting `valid_until` / `invalidated_at` |
| `conflicts` | List unresolved conflicts |
| `corroborate` | Vouch for an existing memory |
| `promote` | Promote a memory to a wider scope |
| `project_create` | Create a project and assign the requesting agent as owner |
| `project_join` | Join a project as `owner`, `contributor`, or `readonly` |
| `project_context` | Fetch project metadata, members, and recent activity |
| `store_put` | Upsert an exact LangGraph store item |
| `store_get` | Fetch an exact LangGraph store item |
| `store_search` | Search store items under a namespace prefix |
| `store_delete` | Delete an exact store item and invalidate its backing memory |
| `store_list_namespaces` | List visible namespaces with prefix/suffix filtering |

## Repository Layout

```text
.
|-- src/
|   |-- adapters/         # Framework adapters (Codex, Claude Code, Hermes, OpenClaw)
|   |-- db/               # SQLite connection, schema, and query modules
|   |-- ingestion/        # Fast-path extraction and consolidation flow
|   |-- mcp/              # MCP server and tool handlers
|   |-- retrieval/        # Router, hybrid search, and graph traversal
|   |-- scope/            # Scope fan-out, promotion, and conflict logic
|   `-- utils/
|-- python/
|   |-- examples/         # LangGraph usage examples
|   `-- src/memryon_langgraph/
|-- tests/
|   |-- integration/
|   `-- unit/
|-- package.json
`-- AGENTS.md
```

## Setup

### Prerequisites

- Node.js 20+ and npm
- Python 3.11+ if you want the LangGraph connector
- A working native build toolchain for `better-sqlite3` if your environment does not already have a compatible prebuild

### 1. Install JavaScript dependencies

```bash
npm install
```

### 2. Build the MCP server

```bash
npm run build
```

This produces the stdio MCP entry point at `dist/mcp/server.js`.

### 3. Choose a database location

Memryon creates the SQLite database and schema automatically on first open. If you do not set a path, it defaults to `memryon.db` in the current working directory.

PowerShell:

```powershell
$env:MEMRYON_DB_PATH = "$PWD\memryon.db"
```

Bash:

```bash
export MEMRYON_DB_PATH="$PWD/memryon.db"
```

### 4. Start the server

```bash
npm start
```

The server speaks MCP over stdio, so it is usually launched by an MCP client rather than visited in a browser.

## Using It As An MCP Server

Example MCP server config:

```json
{
  "mcpServers": {
    "memryon": {
      "command": "node",
      "args": ["C:/Projects/Memryon/dist/mcp/server.js"],
      "env": {
        "MEMRYON_DB_PATH": "C:/Projects/Memryon/memryon.db"
      }
    }
  }
}
```

If your client starts servers from the repository root, you can also use the compiled server with `npm start`.

## Agent Bootstrap

The current MCP surface assumes the writing agent already exists in the `agents` table. Project creation automatically adds the requesting agent as the project owner, but it does not create the base agent record for you.

In application code, seed agents before the first write:

```ts
import { getDb } from "./src/db/connection.js";
import { registerAgent } from "./src/db/queries/agents.js";

const db = getDb(process.env.MEMRYON_DB_PATH ?? "memryon.db");

registerAgent(db, {
  agentId: "codex",
  displayName: "Codex",
  trustTier: 2,
  capabilities: ["remember", "recall", "project_context", "store_put"],
});
```

Once the agent exists, a typical flow is:

1. Register the agent record.
2. Call `project_create` if you need shared project memory.
3. Call `project_join` for additional agents.
4. Use `remember` / `recall` or `store_*` tools during normal operation.

## LangGraph Connector

The Python package lives in [`python/`](./python) and installs as `memryon-langgraph`.

### Install

PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .\python
```

Bash:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ./python
```

### Quick example

```python
from memryon_langgraph import MemryonStore


store = MemryonStore.from_stdio(
    user_id="user-123",
    agent_id="agent-abc",
    project_id="project-xyz",
    server_command="node",
    server_args=["/absolute/path/to/memryon/dist/mcp/server.js"],
)
```

You can also configure the connector through environment variables:

- `MEMRYON_USER_ID`
- `MEMRYON_AGENT_ID`
- `MEMRYON_PROJECT_ID`
- `MEMRYON_SCOPE`
- `MEMRYON_SESSION_ID`
- `MEMRYON_SERVER_COMMAND`
- `MEMRYON_SERVER_ARGS` as a JSON array of strings
- `MEMRYON_SERVER_ENV` as a JSON object of strings

See [`python/examples/quickstart.py`](./python/examples/quickstart.py) and [`python/examples/hybrid_agent.py`](./python/examples/hybrid_agent.py) for concrete usage.

## Development Workflow

Useful commands:

```bash
npm run build
npm run dev
npm test
npm run test:coverage
npm run typecheck
```

What these do:

- `npm run build`: compile the TypeScript MCP server
- `npm run dev`: watch TypeScript changes
- `npm test`: run the Vitest suite
- `npm run test:coverage`: run tests with coverage
- `npm run typecheck`: run TypeScript type-checking without emitting files

## Verified Behavior

The current test suite covers:

- memory round-trips through `remember` and `recall`
- scope visibility and project membership enforcement
- promotion rules based on `trust_tier`
- conflict logging
- project collaboration flows
- LangGraph store round-trips for `store_put`, `store_get`, `store_search`, and `store_list_namespaces`
- adapter behavior and retrieval logic

## Notes And Caveats

- SQLite is opened in WAL mode with foreign keys enabled.
- Soft deletes preserve provenance by marking `invalidated_at`, `invalidated_by`, and `valid_until`.
- `store_items` keeps one current row per visibility bucket plus namespace/key, while older versions are retained as deleted rows.
- The schema already includes embedding fields and conflict metadata, so the project is positioned for deeper vector and consolidation work without a table redesign.

## Near-Term Roadmap

- Wire retrieval and contradiction checks to live `sqlite-vec` embeddings
- Expose agent registration through a public API or MCP tool
- Expand Python-side automated tests
- Harden the consolidation worker for long-running background use
