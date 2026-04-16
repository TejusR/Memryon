import type { Database } from "better-sqlite3";
import { type MemoryRow } from "../db/queries/memories.js";
import { isAgentMember } from "../db/queries/projects.js";
import { getAgentTrustTier } from "../db/queries/agents.js";
import { ScopeViolationError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Scope hierarchy — higher rank = wider scope
// ---------------------------------------------------------------------------

function scopeRank(scope: string): number {
  if (scope === "agent") return 1;
  if (scope === "project") return 2;
  if (scope === "global") return 3;
  throw new ScopeViolationError(`Unknown scope: '${scope}'`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadMemory(db: Database, memoryId: string): MemoryRow {
  const row = db
    .prepare<[string], MemoryRow>(`SELECT * FROM memories WHERE id = ?`)
    .get(memoryId);
  if (row === undefined) {
    throw new ScopeViolationError(`Memory '${memoryId}' not found`);
  }
  return row;
}

function applyScope(
  db: Database,
  memoryId: string,
  newScope: "agent" | "project" | "global",
  projectId: string | null
): MemoryRow {
  db.prepare(
    `UPDATE memories SET scope = ?, project_id = ? WHERE id = ?`
  ).run(newScope, projectId, memoryId);

  return db
    .prepare<[string], MemoryRow>(`SELECT * FROM memories WHERE id = ?`)
    .get(memoryId) as MemoryRow;
}

// ---------------------------------------------------------------------------
// promoteMemory
// ---------------------------------------------------------------------------

export interface PromoteInput {
  memoryId: string;
  requestingAgentId: string;
  /** Target scope must be wider than the current scope. */
  newScope: "project" | "global";
  /** Required when newScope === 'project'. */
  projectId?: string;
}

/**
 * Promote a memory to a wider scope.
 *
 * Rules:
 * - Only the author (agent_id) can promote.
 * - agent → project: requesting agent must be a member of the target project.
 * - agent → global / project → global: agent's trust_tier must be >= 2.
 * - agent_id is never modified (provenance preserved).
 */
export function promoteMemory(db: Database, input: PromoteInput): MemoryRow {
  const { memoryId, requestingAgentId, newScope } = input;

  const memory = loadMemory(db, memoryId);

  if (memory.agent_id !== requestingAgentId) {
    throw new ScopeViolationError(
      `Agent '${requestingAgentId}' is not the author of memory '${memoryId}' ` +
        `(author: '${memory.agent_id}')`
    );
  }

  const currentRank = scopeRank(memory.scope);
  const newRank = scopeRank(newScope);

  if (newRank <= currentRank) {
    throw new ScopeViolationError(
      `Cannot promote from '${memory.scope}' to '${newScope}': ` +
        `'${newScope}' is not a wider scope`
    );
  }

  if (newScope === "project") {
    const projectId = input.projectId;
    if (!projectId) {
      throw new ScopeViolationError(
        `projectId is required when promoting to 'project' scope`
      );
    }
    if (!isAgentMember(db, projectId, requestingAgentId)) {
      throw new ScopeViolationError(
        `Agent '${requestingAgentId}' is not a member of project '${projectId}'`
      );
    }
    return applyScope(db, memoryId, "project", projectId);
  }

  // newScope === "global"
  const trustTier = getAgentTrustTier(db, requestingAgentId);
  if (trustTier < 2) {
    throw new ScopeViolationError(
      `Agent '${requestingAgentId}' has trust_tier ${trustTier}; ` +
        `trust_tier >= 2 is required to promote to global scope`
    );
  }

  return applyScope(db, memoryId, "global", null);
}

// ---------------------------------------------------------------------------
// demoteMemory
// ---------------------------------------------------------------------------

export interface DemoteInput {
  memoryId: string;
  requestingAgentId: string;
  /** Target scope must be narrower than the current scope. */
  newScope: "project" | "agent";
  /** Required when newScope === 'project' (e.g. demoting global → project). */
  projectId?: string;
}

/**
 * Demote a memory to a narrower scope.
 *
 * Rules:
 * - Only the author (agent_id) can demote.
 * - global → project: projectId must be supplied.
 * - project → agent: project_id is cleared.
 * - Can't demote to a scope that is the same or wider (that would be a
 *   promotion or a no-op).
 */
export function demoteMemory(db: Database, input: DemoteInput): MemoryRow {
  const { memoryId, requestingAgentId, newScope } = input;

  const memory = loadMemory(db, memoryId);

  if (memory.agent_id !== requestingAgentId) {
    throw new ScopeViolationError(
      `Agent '${requestingAgentId}' is not the author of memory '${memoryId}' ` +
        `(author: '${memory.agent_id}')`
    );
  }

  const currentRank = scopeRank(memory.scope);
  const newRank = scopeRank(newScope);

  if (newRank >= currentRank) {
    throw new ScopeViolationError(
      `Cannot demote from '${memory.scope}' to '${newScope}': ` +
        `'${newScope}' is not a narrower scope`
    );
  }

  if (newScope === "project") {
    const projectId = input.projectId;
    if (!projectId) {
      throw new ScopeViolationError(
        `projectId is required when demoting to 'project' scope`
      );
    }
    return applyScope(db, memoryId, "project", projectId);
  }

  // newScope === "agent": clear project_id
  return applyScope(db, memoryId, "agent", null);
}
