import type { Database } from "better-sqlite3";
import { type MemoryRow } from "../db/queries/memories.js";
import { isAgentMember } from "../db/queries/projects.js";
import { getAgentTrustTier } from "../db/queries/agents.js";
import {
  ScopeViolationError,
  requireRecord,
  withDbError,
} from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Scope hierarchy - higher rank = wider scope
// ---------------------------------------------------------------------------

function scopeRank(scope: string): number {
  if (scope === "agent") {
    return 1;
  }
  if (scope === "project") {
    return 2;
  }
  if (scope === "global") {
    return 3;
  }

  throw new ScopeViolationError(`Unknown scope: '${scope}'`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadMemory(db: Database, memoryId: string): MemoryRow {
  return withDbError(`loading memory '${memoryId}' for scope change`, () =>
    requireRecord(
      db
        .prepare<[string], MemoryRow>(`SELECT * FROM memories WHERE id = ?`)
        .get(memoryId),
      `Memory '${memoryId}' not found`
    )
  );
}

function applyScope(
  db: Database,
  memoryId: string,
  newScope: "agent" | "project" | "global",
  projectId: string | null
): MemoryRow {
  return withDbError(`updating memory '${memoryId}' to scope '${newScope}'`, () => {
    db.prepare(
      `UPDATE memories SET scope = ?, project_id = ? WHERE id = ?`
    ).run(newScope, projectId, memoryId);

    return requireRecord(
      db
        .prepare<[string], MemoryRow>(`SELECT * FROM memories WHERE id = ?`)
        .get(memoryId),
      `Memory '${memoryId}' not found after scope update`
    );
  });
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
 * Promotes a memory to a wider scope while preserving author provenance.
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
        "projectId is required when promoting to 'project' scope"
      );
    }
    if (!isAgentMember(db, projectId, requestingAgentId)) {
      throw new ScopeViolationError(
        `Agent '${requestingAgentId}' is not a member of project '${projectId}'`
      );
    }

    return applyScope(db, memoryId, "project", projectId);
  }

  const trustTier = getAgentTrustTier(db, requestingAgentId);
  if (trustTier < 2) {
    throw new ScopeViolationError(
      `Agent '${requestingAgentId}' has trust_tier ${trustTier}; ` +
        "trust_tier >= 2 is required to promote to global scope"
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
  /** Required when newScope === 'project' (for example demoting global to project). */
  projectId?: string;
}

/**
 * Demotes a memory to a narrower scope while preserving author provenance.
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
        "projectId is required when demoting to 'project' scope"
      );
    }

    return applyScope(db, memoryId, "project", projectId);
  }

  return applyScope(db, memoryId, "agent", null);
}
