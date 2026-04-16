import type { Database } from "../../db/connection.js";
import {
  getUnresolvedConflicts,
  type ConflictRow,
} from "../../db/queries/conflicts.js";

export interface ConflictsArgs {
  since?: string | undefined;
  framework?: string | undefined;
  project_id?: string | undefined;
  scope?: "agent" | "project" | "global" | undefined;
}

export interface ConflictsResult {
  conflict_log: ConflictRow[];
  count: number;
}

/**
 * Lists unresolved conflicts that match the supplied tool filters.
 */
export function handleConflicts(
  db: Database,
  args: ConflictsArgs
): ConflictsResult {
  const rows = getUnresolvedConflicts(db, {
    ...(args.project_id !== undefined ? { projectId: args.project_id } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.framework !== undefined ? { framework: args.framework } : {}),
  });

  return { conflict_log: rows, count: rows.length };
}
