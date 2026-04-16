import type { Database } from "better-sqlite3";
import { getValidMemories, type MemoryRow } from "../db/queries/memories.js";
import {
  resolveConflict,
  type ConflictRow,
} from "../db/queries/conflicts.js";
import { getAgentTrustTier } from "../db/queries/agents.js";
import {
  ConflictError,
  requireRecord,
  withDbError,
} from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTRA_PROJECT_THRESHOLD = 0.85;
const CROSS_SCOPE_THRESHOLD = 0.85;
/** Maximum candidate conflicts returned per call. */
const TOP_N = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CandidateConflict {
  existingMemoryId: string;
  similarity: number;
  conflictType: "intra_project" | "cross_scope";
}

// ---------------------------------------------------------------------------
// Embedding math
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two embeddings stored as raw Float32 buffers.
 * Returns 0 when either buffer is empty or lengths differ.
 */
function cosineSimilarity(a: Buffer, b: Buffer): number {
  const fa = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const fb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

  if (fa.length === 0 || fa.length !== fb.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < fa.length; i++) {
    const ai = fa[i] ?? 0;
    const bi = fb[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Shared similarity scan
// ---------------------------------------------------------------------------

function findSimilarCandidates(
  newMemory: MemoryRow,
  pool: MemoryRow[],
  threshold: number,
  conflictType: CandidateConflict["conflictType"]
): CandidateConflict[] {
  if (!newMemory.embedding) {
    return [];
  }

  const scored: { id: string; similarity: number }[] = [];

  for (const candidate of pool) {
    if (candidate.id === newMemory.id || !candidate.embedding) {
      continue;
    }

    const similarity = cosineSimilarity(newMemory.embedding, candidate.embedding);
    if (similarity > threshold) {
      scored.push({ id: candidate.id, similarity });
    }
  }

  scored.sort((left, right) => right.similarity - left.similarity);

  return scored.slice(0, TOP_N).map((candidate) => ({
    existingMemoryId: candidate.id,
    similarity: candidate.similarity,
    conflictType,
  }));
}

// ---------------------------------------------------------------------------
// checkIntraProjectConflicts
// ---------------------------------------------------------------------------

/**
 * Finds likely project-local conflicts for a newly written project-scoped memory.
 */
export function checkIntraProjectConflicts(
  db: Database,
  newMemory: MemoryRow
): CandidateConflict[] {
  if (newMemory.scope !== "project" || newMemory.project_id === null) {
    return [];
  }

  const pool = getValidMemories(
    db,
    {
      user_id: newMemory.user_id,
      scope: "project",
      project_id: newMemory.project_id,
    },
    50
  ).filter((memory) => memory.content_type === newMemory.content_type);

  return findSimilarCandidates(
    newMemory,
    pool,
    INTRA_PROJECT_THRESHOLD,
    "intra_project"
  );
}

// ---------------------------------------------------------------------------
// checkCrossScopeConflicts
// ---------------------------------------------------------------------------

/**
 * Compares a project-scoped write against the user's global memories for likely conflicts.
 */
export function checkCrossScopeConflicts(
  db: Database,
  newMemory: MemoryRow
): CandidateConflict[] {
  if (newMemory.scope !== "project") {
    return [];
  }

  const pool = getValidMemories(
    db,
    { user_id: newMemory.user_id, scope: "global" },
    50
  ).filter((memory) => memory.content_type === newMemory.content_type);

  return findSimilarCandidates(
    newMemory,
    pool,
    CROSS_SCOPE_THRESHOLD,
    "cross_scope"
  );
}

// ---------------------------------------------------------------------------
// resolveByTrustTier
// ---------------------------------------------------------------------------

/**
 * Resolves a conflict automatically when one side belongs to a higher-trust agent.
 */
export function resolveByTrustTier(
  db: Database,
  conflictId: string
): ConflictRow {
  return withDbError(`resolving conflict '${conflictId}' by trust tier`, () => {
    const conflict = requireRecord(
      db
        .prepare<[string], ConflictRow>(`SELECT * FROM conflicts WHERE id = ?`)
        .get(conflictId),
      `Conflict '${conflictId}' not found`
    );

    if (conflict.resolved_at !== null) {
      throw new ConflictError(`Conflict '${conflictId}' is already resolved`);
    }

    const memoryA = requireRecord(
      db
        .prepare<[string], MemoryRow>(`SELECT * FROM memories WHERE id = ?`)
        .get(conflict.memory_a),
      `Memory '${conflict.memory_a}' (memory_a) not found`
    );
    const memoryB = requireRecord(
      db
        .prepare<[string], MemoryRow>(`SELECT * FROM memories WHERE id = ?`)
        .get(conflict.memory_b),
      `Memory '${conflict.memory_b}' (memory_b) not found`
    );

    const tierA = getAgentTrustTier(db, memoryA.agent_id);
    const tierB = getAgentTrustTier(db, memoryB.agent_id);

    if (tierA === tierB) {
      return conflict;
    }

    const winnerMemoryId = tierA > tierB ? conflict.memory_a : conflict.memory_b;
    const winnerAgentId = tierA > tierB ? memoryA.agent_id : memoryB.agent_id;
    const resolution = `trust_tier_auto:${winnerMemoryId}`;

    resolveConflict(db, conflictId, resolution, winnerAgentId);

    return requireRecord(
      db
        .prepare<[string], ConflictRow>(`SELECT * FROM conflicts WHERE id = ?`)
        .get(conflictId),
      `Conflict '${conflictId}' was not found after resolution`
    );
  });
}
