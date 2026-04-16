import type { Database } from "better-sqlite3";
import {
  findByFTS,
  getValidMemories,
  type MemoryRow,
} from "../db/queries/memories.js";
import type { MemoryFilters } from "../mcp/schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Scope priority: lower number = higher priority in merged results.
 * 1 = project (wins over everything), 2 = agent-private, 3 = global.
 */
export type ScopePriority = 1 | 2 | 3;

export interface ScoredMemoryRow extends MemoryRow {
  scopePriority: ScopePriority;
}

export interface ScopedRecallInput {
  userId: string;
  agentId: string;
  projectId?: string;
  /** Optional FTS query. When present, each tier is filtered via BM25. */
  query?: string;
  limit?: number;
}

export interface VisibleMemoryInput {
  userId: string;
  agentId: string;
  projectId?: string;
  scope?: "agent" | "project" | "global";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function priorityForScope(scope: "agent" | "project" | "global"): ScopePriority {
  if (scope === "project") return 1;
  if (scope === "agent") return 2;
  return 3;
}

function sortScoredRows(rows: ScoredMemoryRow[]): ScoredMemoryRow[] {
  rows.sort((a, b) => {
    if (a.scopePriority !== b.scopePriority) {
      return a.scopePriority - b.scopePriority;
    }
    return b.recorded_at.localeCompare(a.recorded_at);
  });

  return rows;
}

export function collectVisibleMemories(
  db: Database,
  input: VisibleMemoryInput
): ScoredMemoryRow[] {
  const { userId, agentId, projectId, scope } = input;

  if (!userId) throw new Error("userId is required");
  if (!agentId) throw new Error("agentId is required");

  const rowsById = new Map<string, ScoredMemoryRow>();
  const addRows = (rows: MemoryRow[]) => {
    for (const row of rows) {
      if (!rowsById.has(row.id)) {
        rowsById.set(row.id, {
          ...row,
          scopePriority: priorityForScope(row.scope),
        });
      }
    }
  };

  if (scope === undefined || scope === "project") {
    if (projectId !== undefined) {
      addRows(
        getValidMemories(db, {
          user_id: userId,
          scope: "project",
          project_id: projectId,
        })
      );
    }
  }

  if (scope === undefined || scope === "agent") {
    addRows(
      getValidMemories(db, {
        user_id: userId,
        scope: "agent",
        agent_id: agentId,
      })
    );
  }

  if (scope === undefined || scope === "global") {
    addRows(
      getValidMemories(db, {
        user_id: userId,
        scope: "global",
      })
    );
  }

  return sortScoredRows([...rowsById.values()]);
}

// ---------------------------------------------------------------------------
// scopedRecall
// ---------------------------------------------------------------------------

/**
 * Fan-out retrieval across all three memory tiers.
 *
 * Order of precedence: project (1) → agent-private (2) → global (3).
 * Within a tier, rows are ordered by recorded_at DESC (most recent first).
 * Duplicate memory IDs (same memory visible in multiple tiers) are
 * deduplicated, keeping the highest-priority occurrence.
 */
export function scopedRecall(
  db: Database,
  input: ScopedRecallInput
): ScoredMemoryRow[] {
  const { userId, agentId, query, limit = 20 } = input;

  if (!userId) throw new Error("userId is required");
  if (!agentId) throw new Error("agentId is required");

  if (query === undefined) {
    return collectVisibleMemories(db, input).slice(0, limit);
  }

  // Build a tier fetcher that delegates to FTS when a query is provided,
  // or falls back to recency ordering via getValidMemories.
  const fetchTier = (filters: MemoryFilters): MemoryRow[] =>
    findByFTS(db, query, filters, limit);

  // Tier 1 — project-scoped: any member's memories in this project.
  const projectRows: MemoryRow[] = input.projectId !== undefined
    ? fetchTier({
        user_id: userId,
        scope: "project",
        project_id: input.projectId,
      })
    : [];

  // Tier 2 — agent-private: only this agent's agent-scoped memories.
  const agentRows: MemoryRow[] = fetchTier({
    user_id: userId,
    scope: "agent",
    agent_id: agentId,
  });

  // Tier 3 — global: visible to all agents for this user.
  const globalRows: MemoryRow[] = fetchTier({ user_id: userId, scope: "global" });

  // Annotate each row with its scope priority, deduplicate by id (keeping the
  // first occurrence, which is always the highest-priority tier), then sort.
  const seen = new Set<string>();
  const scored: ScoredMemoryRow[] = [];

  const tiers: [ScopePriority, MemoryRow[]][] = [
    [1, projectRows],
    [2, agentRows],
    [3, globalRows],
  ];

  for (const [priority, rows] of tiers) {
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        scored.push({ ...row, scopePriority: priority });
      }
    }
  }

  return sortScoredRows(scored).slice(0, limit);
}
