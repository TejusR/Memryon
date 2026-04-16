import type { Database } from "../../db/connection.js";
import {
  hybridSearch,
  type HybridSearchResult,
} from "../../retrieval/hybrid-search.js";
import { classifyIntent } from "../../retrieval/router.js";

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
  results: HybridSearchResult[];
  scope_breakdown: { project: number; agent: number; global: number };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleRecall(db: Database, args: RecallArgs): RecallResult {
  const limit = args.top_k ?? 20;

  let rows = hybridSearch(db, {
    userId: args.user_id,
    agentId: args.agent_id,
    ...(args.project_id !== undefined ? { projectId: args.project_id } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    query: args.query ?? "",
    intentWeights: classifyIntent(args.query ?? ""),
    limit,
  });

  if (args.framework_filter !== undefined) {
    rows = rows.filter((row) => row.framework === args.framework_filter);
  }

  const breakdown = { project: 0, agent: 0, global: 0 };
  for (const row of rows) {
    if (row.scope === "project") breakdown.project++;
    else if (row.scope === "agent") breakdown.agent++;
    else breakdown.global++;
  }

  return {
    results: rows,
    scope_breakdown: breakdown,
  };
}
