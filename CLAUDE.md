# Memryon — Project Context

## What This Is

Memryon is a local-first, MCP-native memory operating system for multi-agent AI systems. It serves as the shared brain across OpenClaw, Hermes, Claude Code, Codex CLI, and any MCP-compatible agent. The core differentiator vs existing tools (MemClaw, memsearch) is **conflict-aware intelligence**: agent provenance, contradiction detection, causal reasoning, and scoped memory.

## Architecture Overview

### Three-Tier Memory Scope Model

Every memory (MemCell) lives in exactly one scope:

- **agent** — private to the writing agent (e.g., Claude Code's internal refactoring notes)
- **project** — shared across all agents who are members of that project
- **global** — visible to all agents for this user, across all projects

Queries fan out across scopes in priority order: project (highest) → agent → global.

### Core Tables

| Table | Purpose |
|-------|---------|
| `memories` | All MemCells with scope, project_id, agent_id, bi-temporal columns, embedding, causal links |
| `projects` | Named collaboration boundaries with user_id, description, archived_at |
| `project_agents` | Agent membership in projects with role (owner/contributor/readonly) |
| `agents` | Agent registry with trust_tier (1-3), capabilities, display_name |
| `corroborations` | Agents vouching for existing memories (prevents duplication) |
| `conflicts` | Contradiction log with project_id, conflict_type, resolution status |
| `candidate_buffer` | Fast-path ingestion staging table (status: PENDING/ACCEPTED/REJECTED) |
| `adapter_errors` | Per-framework failure logging |
| `memories_fts` | FTS5 virtual table for full-text search |

### Key Constraints & Invariants

- `scope` is an enum: `'agent'`, `'project'`, `'global'`
- `CHECK (scope != 'project' OR project_id IS NOT NULL)` — project scope requires project_id
- `CHECK (scope = 'project' OR project_id IS NULL)` — non-project scope must have NULL project_id
- `agent_id` is always set on every write — provenance is never lost, even after promotion/demotion
- `valid_from` / `valid_until` are bi-temporal — `valid_until = NULL` means currently valid
- `invalidated_at` / `invalidated_by` track who killed a memory and when
- Memory IDs are ULIDs (temporally sortable)
- SQLite WAL mode for concurrent reads with serialized writes
- All embeddings use sqlite-vec (NOT sqlite-vss, which is abandoned)

### MCP Tools (JSON-RPC 2.0)

| Tool | Signature |
|------|-----------|
| `remember` | `(content, agent_id, framework, session_id, scope, project_id?, importance_hint?)` |
| `recall` | `(query, intent_hint?, scope?, project_id?, framework_filter?, agent_id?, top_k?)` |
| `forget` | `(memcell_id, reason?)` — soft delete only, sets valid_until |
| `conflicts` | `(since?, framework?, project_id?, scope?)` |
| `corroborate` | `(memory_id)` |
| `promote` | `(memory_id, new_scope, project_id?)` |
| `project_create` | `(name, description)` |
| `project_join` | `(project_id, role?)` |
| `project_context` | `(project_id)` |

### Conflict Detection

1. **Write-time**: candidate vs valid MemCells, cosine similarity > 0.9, then LLM polarity check
2. **Intra-project**: project writes vs same-project memories, similarity > 0.85
3. **Cross-scope**: project writes vs global memories
4. **Resolution**: higher trust_tier wins; same tier → surface via `conflicts()` tool; 60s timeout → force-accept at confidence 0.5

### Retrieval

- Hybrid: BM25 (FTS5) + Vector (sqlite-vec) + Graph traversal
- Merged via Reciprocal Rank Fusion (k=60, weights: BM25=1.0, Vector=1.0, Graph=1.2)
- Intent-aware soft router outputs weight vector: {causal, temporal, entity, semantic}
- Recall fan-out respects scope visibility and project membership

### Dual-Stream Ingestion

- **Fast path** (< 300ms): lightweight entity/fact extraction → candidate_buffer with PENDING status
- **Slow path**: Quality Gate LLM (temperature=0) → ACCEPT/UPDATE/REJECT with confidence score

## Tech Stack

- **Language**: TypeScript (MCP server, adapters) + Python (embedding generation, consolidation worker)
- **Database**: SQLite with FTS5, sqlite-vec, WAL mode
- **Embeddings**: ONNX Runtime with a local model (track `embedding_model_version` per MemCell)
- **MCP**: JSON-RPC 2.0 server over stdio
- **Testing**: Vitest (TS), pytest (Python)

## File Structure Convention

```
memryon/
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── src/
│   ├── mcp/              # MCP server and tool handlers
│   │   ├── server.ts
│   │   ├── tools/
│   │   │   ├── remember.ts
│   │   │   ├── recall.ts
│   │   │   ├── forget.ts
│   │   │   ├── conflicts.ts
│   │   │   ├── corroborate.ts
│   │   │   ├── promote.ts
│   │   │   ├── project-create.ts
│   │   │   ├── project-join.ts
│   │   │   └── project-context.ts
│   │   └── schemas.ts    # Zod schemas for all tool inputs
│   ├── db/
│   │   ├── schema.ts     # DDL, migrations, indexes
│   │   ├── connection.ts # WAL setup, pragma config
│   │   └── queries/      # Prepared statement modules per table
│   ├── ingestion/
│   │   ├── fast-path.ts  # Entity/fact extraction
│   │   └── consolidation.ts  # Quality Gate, contradiction detection
│   ├── retrieval/
│   │   ├── router.ts     # Intent-aware soft router
│   │   ├── hybrid-search.ts  # BM25 + vector + graph fusion
│   │   └── graph-traversal.ts
│   ├── scope/
│   │   ├── fan-out.ts    # Three-tier query fan-out
│   │   ├── promotion.ts  # Scope transitions with trust checks
│   │   └── conflict-detection.ts  # Intra-project + cross-scope
│   ├── adapters/
│   │   ├── openclaw.ts
│   │   ├── hermes.ts
│   │   ├── claude-code.ts
│   │   └── codex.ts
│   └── utils/
│       ├── ulid.ts
│       ├── embedding.ts  # ONNX wrapper
│       └── staleness.ts  # Corroboration sweep
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
└── scripts/
    └── consolidation-worker.py
```

## Code Style

- Explicit types everywhere, no `any`
- Zod for all external input validation
- Prepared statements for all SQL (no string interpolation)
- Every function that touches the DB takes a `db` parameter (dependency injection for testing)
- Error types are explicit: `MemryonError`, `ScopeViolationError`, `ConflictError`, etc.
- Tests colocated in `tests/` mirror `src/` structure

## What "Done" Looks Like

Each prompt targets a shippable increment. The system is done when:
1. All 9 MCP tools work end-to-end against SQLite
2. Scope visibility is enforced (agent can't read another agent's private memories)
3. Conflict detection fires on contradictions within and across scopes
4. Corroboration prevents duplicate memories
5. Promotion respects trust_tier
6. Retrieval fan-out returns scope-prioritized results
7. All adapters can write memories with correct provenance
8. Integration tests cover the multi-agent collaboration flow
