import type { Database } from "../../db/connection.js";
import { getValidMemories, type MemoryRow } from "../../db/queries/memories.js";
import { scopedRecall, type ScoredMemoryRow } from "../../scope/fan-out.js";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface RecallArgs {
  user_id: string;
  agent_id: string;
  query?: string | undefined;
  intent_hint?: string | undefined;
  scope?: "agent" | "project" | "global" | undefined;
  project_id?: string | undefined;
  framework_filter?: string | undefined;
  top_k?: number | undefined;
}

export interface RecallResult {
  results: MemoryRow[];
  scope_breakdown: { project: number; agent: number; global: number };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleRecall(db: Database, args: RecallArgs): RecallResult {
  const limit = args.top_k ?? 20;

  let rows: (MemoryRow | ScoredMemoryRow)[];

  if (args.scope === undefined) {
    // Fan-out across all three tiers.
    rows = scopedRecall(db, {
      userId: args.user_id,
      agentId: args.agent_id,
      ...(args.project_id !== undefined ? { projectId: args.project_id } : {}),
      ...(args.query !== undefined ? { query: args.query } : {}),
      limit,
    });
  } else {
    // Scoped query against a single tier.
    // Only filter by agent_id for agent scope (private memories are per-agent).
    // Project and global scope are shared — all members can see all memories.
    const agentFilter =
      args.scope === "agent" ? { agent_id: args.agent_id } : {};

    rows = getValidMemories(
      db,
      {
        user_id: args.user_id,
        scope: args.scope,
        ...(args.project_id !== undefined ? { project_id: args.project_id } : {}),
        ...agentFilter,
      },
      limit
    );
  }

  // Apply post-fetch filters for framework and agent_id that couldn't be
  // pushed into scopedRecall.
  if (args.framework_filter !== undefined) {
    const ff = args.framework_filter;
    rows = rows.filter((r) => r.framework === ff);
  }

  // scope_breakdown counts
  const breakdown = { project: 0, agent: 0, global: 0 };
  for (const r of rows) {
    if (r.scope === "project") breakdown.project++;
    else if (r.scope === "agent") breakdown.agent++;
    else breakdown.global++;
  }

  return {
    results: rows as MemoryRow[],
    scope_breakdown: breakdown,
  };
}
