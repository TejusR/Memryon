import type { Database } from "../../db/connection.js";
import { insertMemory } from "../../db/queries/memories.js";
import { isAgentMember } from "../../db/queries/projects.js";
import { logConflict } from "../../db/queries/conflicts.js";
import {
  checkIntraProjectConflicts,
  checkCrossScopeConflicts,
} from "../../scope/conflict-detection.js";
import { ScopeViolationError } from "../../utils/errors.js";

// ---------------------------------------------------------------------------
// Input type (matches MCP tool Zod shape in server.ts)
// ---------------------------------------------------------------------------

export interface RememberArgs {
  content: string;
  agent_id: string;
  user_id: string;
  scope: "agent" | "project" | "global";
  project_id?: string | undefined;
  framework?: string | undefined;
  session_id?: string | undefined;
  importance_hint?: number | undefined;
  confidence?: number | undefined;
  source_type?: string | undefined;
  supersedes?: string | undefined;
  content_type?: string | undefined;
  tags?: string[] | undefined;
}

export interface RememberResult {
  memcell_id: string;
  status: "stored";
  conflict_ids?: string[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Stores a memory and records any project or cross-scope conflicts detected for it.
 */
export function handleRemember(db: Database, args: RememberArgs): RememberResult {
  // Enforce membership when writing to a project scope.
  if (args.scope === "project") {
    const projectId = args.project_id;
    if (!projectId) {
      throw new ScopeViolationError(
        "project_id is required when scope is 'project'"
      );
    }
    if (!isAgentMember(db, projectId, args.agent_id)) {
      throw new ScopeViolationError(
        `Agent '${args.agent_id}' is not a member of project '${projectId}'`
      );
    }
  }

  // Build insert input.  The discriminated union requires project_id only for
  // scope='project', so we construct the object conditionally.
  const baseFields = {
    user_id: args.user_id,
    agent_id: args.agent_id,
    content: args.content,
    content_type: args.content_type ?? "text/plain",
    tags: args.tags ?? [],
    confidence: args.confidence ?? 1,
    importance: args.importance_hint ?? 0.5,
    source_type: args.source_type ?? "manual",
    ...(args.framework !== undefined ? { framework: args.framework } : {}),
    ...(args.session_id !== undefined ? { session_id: args.session_id } : {}),
    ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
  };

  const insertInput =
    args.scope === "project"
      ? { ...baseFields, scope: "project" as const, project_id: args.project_id! }
      : args.scope === "global"
      ? { ...baseFields, scope: "global" as const }
      : { ...baseFields, scope: "agent" as const };

  const memory = insertMemory(db, insertInput);

  // Conflict detection — only meaningful for project-scoped writes.
  const conflictIds: string[] = [];

  if (memory.scope === "project") {
    const intra = checkIntraProjectConflicts(db, memory);
    const cross = checkCrossScopeConflicts(db, memory);

    for (const candidate of [...intra, ...cross]) {
      const conflict = logConflict(db, {
        memoryA: memory.id,
        memoryB: candidate.existingMemoryId,
        projectId: memory.project_id ?? undefined,
        conflictType: candidate.conflictType,
      });
      conflictIds.push(conflict.id);
    }
  }

  const result: RememberResult = {
    memcell_id: memory.id,
    status: "stored",
  };

  if (conflictIds.length > 0) {
    result.conflict_ids = conflictIds;
  }

  return result;
}
