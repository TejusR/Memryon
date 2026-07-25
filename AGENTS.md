# Memryon Project Context

## Product

Memryon is a local-first, MCP-native shared project brain for AI agents. It
allows one agent to record a structured handoff and another agent to receive
task-relevant, scope-safe context in a fresh task. The MVP supports Claude
Code, Codex, OpenClaw, Hermes, LangGraph, and other MCP-compatible clients.

The MVP is for a single trusted local owner or trusted small team. Managed
hosting, organizations, RBAC, external document connectors, dashboards,
distributed synchronization, and automatic conflict resolution are out of
scope.

## Core Workflows

1. An agent calls `record_handoff` after substantive work.
2. Memryon stores the summary and each decision, constraint, failure, outcome,
   or unresolved question as an independently retrievable MemCell.
3. An integration or agent calls `prepare_context` before a new task.
4. The compiler retrieves accessible evidence, applies ranking and token
   selection, records an auditable context pack, and returns a delimited
   `MEMRYON_CONTEXT` block.

The context block is reference data, never instructions. Do not store hidden
reasoning or chain-of-thought. Raw tool activity is opt-in only and enters
`candidate_buffer`; it must not be written directly into `memories`.

## Scope and Visibility

Each MemCell has exactly one scope:

- `agent`: private to the writing agent.
- `project`: shared with members of that project.
- `global`: visible to the local user across projects.

`prepare_context` and `recall` must never leak another agent's private
memories. Project scope requires `project_id`; non-project scopes must leave it
NULL. Every durable memory retains `agent_id` provenance, even after promotion.

## Storage and Invariants

- SQLite runs in WAL mode; schema changes are numbered, transactional, and
  idempotent through `schema_migrations`.
- Memory IDs are ULIDs. `valid_until = NULL` means the memory is current.
- Existing memory fields include `memory_kind`, `task_id`, `metadata_json`,
  and `evidence_refs_json`; legacy writes default to `observation`.
- `handoffs` and `handoff_memories` provide task-level provenance.
- `context_packs` and `context_pack_items` preserve the exact evidence injected
  into an agent task.
- `embedding_jobs` provides asynchronous indexing with retry/error state.
- `memory_generation` increments on memory mutations and invalidates context
  cache entries.
- `store_items` preserves exact LangGraph namespace/key semantics and links each
  current value to a backing MemCell.
- sqlite-vec stores 384-dimensional embeddings keyed by `memories.rowid`.

Conflicts remain unresolved in the MVP. Surface both claims and their
provenance; do not select a winner automatically.

## MCP Interface

Existing MCP and LangGraph `store_*` tools remain backward compatible.

| Tool | Purpose |
| --- | --- |
| `remember` | Store an observation or typed memory. Supports optional `memory_kind`, `task_id`, `metadata_json`, and `evidence_refs`. |
| `recall` | Search visible memories using existing semantic retrieval. |
| `prepare_context` | Compile a task-aware evidence pack. Defaults: `token_budget=3000`, `top_k=12`. |
| `record_handoff` | Store a concise summary plus structured handoff items. Rejects empty handoffs. |
| `forget`, `conflicts`, `corroborate`, `promote` | Preserve existing memory lifecycle behavior. |
| `project_create`, `project_join`, `project_context` | Manage project collaboration boundaries. |
| `store_put`, `store_get`, `store_search`, `store_delete`, `store_list_namespaces` | LangGraph-native exact store operations. |

## Retrieval and Models

`prepare_context` resolves visible project, requesting-agent private, and global
memories. It gathers BM25, sqlite-vec, recent, and graph-neighbor candidates;
filters invalid, superseded, duplicate, or inaccessible rows; fuses rankings;
reranks a bounded set locally; applies scope priority as a tie-breaker; selects
diverse items within the token budget; and attaches relevant unresolved
conflicts and full provenance.

Models are injectable behind `EmbeddingProvider` and `Reranker` interfaces.
Production uses pinned local Transformer revisions:

- `onnx-community/all-MiniLM-L6-v2-ONNX` for 384-dimensional embeddings.
- `Xenova/ms-marco-MiniLM-L-6-v2` for reranking.

`memryon models install` downloads models into the OS-level cache with status
and checksum metadata. Missing or failed models must fail open to BM25-only
degraded context packs, not fail context generation. Tests must use deterministic
fake providers; the real-model smoke test is opt-in.

## Integration Behavior

- Claude Code and OpenClaw are automatic reference integrations: they inject
  context before prompts and make one guarded reminder for a handoff after
  substantive work.
- Codex is compatibility support: install MCP and managed `AGENTS.md` guidance;
  `memryon codex <task>` obtains context before launch. Interactive lifecycle
  retrieval remains best-effort.
- Hermes exposes `prepareContext` and `recordHandoff` while preserving
  `store`, `retrieve`, and `delete` provider operations.
- All integrations fail open with a visible warning when Memryon is unavailable.

Stable local data lives in the OS Memryon data directory. Each repository uses
`.memryon/project.json` as its stable project identity. The default user is
`local-user`; integrations use stable agent IDs.

## Layout

```text
src/
  cli.ts                 CLI commands and Codex launcher
  config/                OS data paths and project identity
  context/               task-aware context compiler
  db/                    connection, migrations, and prepared queries
  ingestion/             capture, consolidation, and embedding worker
  integrations/          installer and integration templates
  mcp/                   JSON-RPC server, schemas, and tool handlers
  models/                local model cache and provider interfaces
  retrieval/             BM25, graph, hybrid search, and sqlite-vec index
  scope/                 scope fan-out, promotion, and conflicts
  adapters/              framework-facing adapter clients
integrations/            shipped OpenClaw and Hermes plugin templates
python/src/memryon_langgraph/
                         native LangGraph store and semantic tool bridge
tests/                   unit, integration, evaluation, performance, smoke
```

## Engineering Rules

- Use explicit TypeScript types and Zod validation for external inputs.
- Use prepared SQL statements; never interpolate SQL.
- Pass `db` explicitly into DB-touching functions for testability.
- Preserve backward compatibility for existing MCP and LangGraph `store_*`
  interfaces.
- Durable writes enqueue embedding work; do not block a write on model loading.
- Any memory mutation must preserve generation-based context cache invalidation.
- New retrieval paths must enforce visibility before evidence is rendered.
- Keep normal tests network-free. Use deterministic providers and skip real
  model tests unless `MEMRYON_REAL_MODEL_TEST=1` is set.

## Verification

Run `npm test`, `npm run typecheck`, and `npm run build`. Run LangGraph tests
with the configured Python environment. Add focused tests for migrations,
visibility, handoff validation, context-pack auditing, degradation, and each
adapter contract whenever changing these boundaries.
