import type { Database } from "better-sqlite3";
import { getValidMemories, type MemoryRow } from "../db/queries/memories.js";
import {
  resolveConflict,
  type ConflictRow,
} from "../db/queries/conflicts.js";
import { getAgentTrustTier } from "../db/queries/agents.js";

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

  if (fa.length === 0 || fa.length !== fb.length) return 0;

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

  if (normA === 0 || normB === 0) return 0;
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
  // Without an embedding we can't compute similarity — skip detection.
  if (!newMemory.embedding) return [];

  const scored: { id: string; similarity: number }[] = [];

  for (const candidate of pool) {
    // Skip self-comparison and candidates without embeddings.
    if (candidate.id === newMemory.id || !candidate.embedding) continue;

    const sim = cosineSimilarity(newMemory.embedding, candidate.embedding);
    if (sim > threshold) {
      scored.push({ id: candidate.id, similarity: sim });
    }
  }

  // Return top-N by descending similarity.
  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, TOP_N).map((s) => ({
    existingMemoryId: s.id,
    similarity: s.similarity,
    conflictType,
  }));
}

// ---------------------------------------------------------------------------
// checkIntraProjectConflicts
// ---------------------------------------------------------------------------

/**
 * Find project-scoped memories in the same project whose embeddings are
 * suspiciously close to newMemory (cosine > 0.85).
 *
 * Only runs when newMemory.scope === 'project'. Returns candidate conflicts;
 * the actual polarity/contradiction check is deferred to the consolidation
 * worker.
 */
export function checkIntraProjectConflicts(
  db: Database,
  newMemory: MemoryRow
): CandidateConflict[] {
  if (newMemory.scope !== "project" || newMemory.project_id === null) return [];

  const projectId = newMemory.project_id;

  const pool = getValidMemories(
    db,
    { user_id: newMemory.user_id, scope: "project", project_id: projectId },
    50
  ).filter((m) => m.content_type === newMemory.content_type);

  return findSimilarCandidates(newMemory, pool, INTRA_PROJECT_THRESHOLD, "intra_project");
}

// ---------------------------------------------------------------------------
// checkCrossScopeConflicts
// ---------------------------------------------------------------------------

/**
 * Compare a project-scoped write against global memories for the same user.
 * Returns candidate conflicts whose embedding similarity exceeds 0.85.
 */
export function checkCrossScopeConflicts(
  db: Database,
  newMemory: MemoryRow
): CandidateConflict[] {
  if (newMemory.scope !== "project") return [];

  const pool = getValidMemories(
    db,
    { user_id: newMemory.user_id, scope: "global" },
    50
  ).filter((m) => m.content_type === newMemory.content_type);

  return findSimilarCandidates(newMemory, pool, CROSS_SCOPE_THRESHOLD, "cross_scope");
}

// ---------------------------------------------------------------------------
// resolveByTrustTier
// ---------------------------------------------------------------------------

/**
 * Auto-resolve a conflict using agent trust tiers.
 *
 * - If the two agents have different trust_tiers, the higher tier wins and
 *   the conflict is marked resolved immediately.
 * - If they share the same trust_tier, the conflict is left unresolved so it
 *   can be surfaced via the `conflicts()` MCP tool.
 *
 * Returns the (possibly updated) ConflictRow.
 */
export function resolveByTrustTier(
  db: Database,
  conflictId: string
): ConflictRow {
  const conflict = db
    .prepare<[string], ConflictRow>(`SELECT * FROM conflicts WHERE id = ?`)
    .get(conflictId);

  if (conflict === undefined) {
    throw new Error(`Conflict '${conflictId}' not found`);
  }
  if (conflict.resolved_at !== null) {
    throw new Error(`Conflict '${conflictId}' is already resolved`);
  }

  const memA = db
    .prepare<[string], MemoryRow>(`SELECT * FROM memories WHERE id = ?`)
    .get(conflict.memory_a);
  const memB = db
    .prepare<[string], MemoryRow>(`SELECT * FROM memories WHERE id = ?`)
    .get(conflict.memory_b);

  if (memA === undefined) {
    throw new Error(`Memory '${conflict.memory_a}' (memory_a) not found`);
  }
  if (memB === undefined) {
    throw new Error(`Memory '${conflict.memory_b}' (memory_b) not found`);
  }

  const tierA = getAgentTrustTier(db, memA.agent_id);
  const tierB = getAgentTrustTier(db, memB.agent_id);

  if (tierA === tierB) {
    // Same trust tier — leave unresolved, caller surfaces via conflicts() tool.
    return conflict;
  }

  // Higher tier wins.
  const winnerMemoryId = tierA > tierB ? conflict.memory_a : conflict.memory_b;
  const winnerAgentId = tierA > tierB ? memA.agent_id : memB.agent_id;
  const resolution = `trust_tier_auto:${winnerMemoryId}`;

  resolveConflict(db, conflictId, resolution, winnerAgentId);

  return db
    .prepare<[string], ConflictRow>(`SELECT * FROM conflicts WHERE id = ?`)
    .get(conflictId) as ConflictRow;
}
