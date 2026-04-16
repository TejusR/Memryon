import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { addAgent, createProject } from "../../src/db/queries/projects.js";
import { insertMemory } from "../../src/db/queries/memories.js";
import { logConflict, getUnresolvedConflicts } from "../../src/db/queries/conflicts.js";
import {
  checkIntraProjectConflicts,
  checkCrossScopeConflicts,
  resolveByTrustTier,
} from "../../src/scope/conflict-detection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Buffer containing Float32 values, suitable for use as an embedding
 * in test memories.
 */
function makeEmbedding(values: number[]): Buffer {
  const f32 = new Float32Array(values);
  // Copy into a fresh Buffer so byteOffset is always 0.
  return Buffer.from(f32.buffer.slice(0));
}

// Two nearly-identical unit vectors → cosine similarity ≈ 0.9998 (> 0.85).
const EMB_NEAR_A = makeEmbedding([1, 0.01, 0]);
const EMB_NEAR_B = makeEmbedding([1, 0.02, 0]);

// Orthogonal vectors → cosine similarity = 0 (< 0.85).
const EMB_ORTHO = makeEmbedding([0, 1, 0]);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DB = ":memory:";
const USER = "user-cd";
const AGENT_HI = "agent-cd-hi"; // trust_tier=3
const AGENT_MED = "agent-cd-med"; // trust_tier=2
const AGENT_LO = "agent-cd-lo"; // trust_tier=1
let PROJECT_ID: string;

function seed(db: ReturnType<typeof getDb>) {
  registerAgent(db, { agentId: AGENT_HI, displayName: "High", trustTier: 3, capabilities: [] });
  registerAgent(db, { agentId: AGENT_MED, displayName: "Med", trustTier: 2, capabilities: [] });
  registerAgent(db, { agentId: AGENT_LO, displayName: "Low", trustTier: 1, capabilities: [] });

  const proj = createProject(db, { userId: USER, name: "CD Project", description: "" });
  PROJECT_ID = proj.id;
  addAgent(db, { projectId: PROJECT_ID, agentId: AGENT_HI, role: "owner" });
  addAgent(db, { projectId: PROJECT_ID, agentId: AGENT_MED, role: "contributor" });
  addAgent(db, { projectId: PROJECT_ID, agentId: AGENT_LO, role: "contributor" });
}

let db: ReturnType<typeof getDb>;

beforeEach(() => {
  db = getDb(DB);
  seed(db);
});

afterEach(() => {
  closeDb(DB);
});

// ---------------------------------------------------------------------------
// checkIntraProjectConflicts
// ---------------------------------------------------------------------------

describe("checkIntraProjectConflicts", () => {
  it("returns empty array for non-project-scoped memories", () => {
    const mem = insertMemory(db, {
      user_id: USER, scope: "global", agent_id: AGENT_HI,
      content: "global fact", embedding: EMB_NEAR_A,
    });
    expect(checkIntraProjectConflicts(db, mem)).toEqual([]);
  });

  it("returns empty array when the new memory has no embedding", () => {
    // Existing memory with embedding.
    insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_HI,
      project_id: PROJECT_ID, content: "existing", embedding: EMB_NEAR_B,
    });
    // New memory without embedding.
    const newMem = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_MED,
      project_id: PROJECT_ID, content: "new — no embedding",
    });
    expect(checkIntraProjectConflicts(db, newMem)).toEqual([]);
  });

  it("finds a high-similarity candidate within the same project", () => {
    // Pre-existing memory.
    const existing = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_HI,
      project_id: PROJECT_ID, content: "existing fact", embedding: EMB_NEAR_A,
    });
    // New memory with a very similar embedding.
    const newMem = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_MED,
      project_id: PROJECT_ID, content: "contradicting fact", embedding: EMB_NEAR_B,
    });

    const candidates = checkIntraProjectConflicts(db, newMem);
    expect(candidates.length).toBeGreaterThan(0);

    const match = candidates.find((c) => c.existingMemoryId === existing.id);
    expect(match).toBeDefined();
    expect(match?.similarity).toBeGreaterThan(0.85);
    expect(match?.conflictType).toBe("intra_project");
  });

  it("does not flag low-similarity memories as conflicts", () => {
    insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_HI,
      project_id: PROJECT_ID, content: "orthogonal topic", embedding: EMB_ORTHO,
    });
    const newMem = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_MED,
      project_id: PROJECT_ID, content: "different topic", embedding: EMB_NEAR_A,
    });

    const candidates = checkIntraProjectConflicts(db, newMem);
    expect(candidates).toHaveLength(0);
  });

  it("does not include self in candidates", () => {
    const mem = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_HI,
      project_id: PROJECT_ID, content: "sole memory", embedding: EMB_NEAR_A,
    });
    const candidates = checkIntraProjectConflicts(db, mem);
    expect(candidates.find((c) => c.existingMemoryId === mem.id)).toBeUndefined();
  });

  it("only compares memories with the same content_type", () => {
    // Existing memory with a different content_type.
    insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_HI,
      project_id: PROJECT_ID, content: "image metadata",
      content_type: "image/jpeg", embedding: EMB_NEAR_A,
    });
    const newMem = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_MED,
      project_id: PROJECT_ID, content: "text fact",
      content_type: "text/plain", embedding: EMB_NEAR_B,
    });
    // Different content_type → should not flag.
    expect(checkIntraProjectConflicts(db, newMem)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkCrossScopeConflicts
// ---------------------------------------------------------------------------

describe("checkCrossScopeConflicts", () => {
  it("returns empty array for non-project-scoped memories", () => {
    const mem = insertMemory(db, {
      user_id: USER, scope: "agent", agent_id: AGENT_HI,
      content: "private", embedding: EMB_NEAR_A,
    });
    expect(checkCrossScopeConflicts(db, mem)).toEqual([]);
  });

  it("catches a project memory that conflicts with a global memory", () => {
    // Global memory with similar embedding.
    const global = insertMemory(db, {
      user_id: USER, scope: "global", agent_id: AGENT_HI,
      content: "global established fact", embedding: EMB_NEAR_A,
    });
    // New project-scoped memory with nearly identical embedding.
    const projectMem = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_MED,
      project_id: PROJECT_ID, content: "project contradicting fact", embedding: EMB_NEAR_B,
    });

    const candidates = checkCrossScopeConflicts(db, projectMem);
    expect(candidates.length).toBeGreaterThan(0);

    const match = candidates.find((c) => c.existingMemoryId === global.id);
    expect(match).toBeDefined();
    expect(match?.conflictType).toBe("cross_scope");
    expect(match?.similarity).toBeGreaterThan(0.85);
  });

  it("does not flag orthogonal project/global memories", () => {
    insertMemory(db, {
      user_id: USER, scope: "global", agent_id: AGENT_HI,
      content: "global topic A", embedding: EMB_ORTHO,
    });
    const projectMem = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_MED,
      project_id: PROJECT_ID, content: "project topic B", embedding: EMB_NEAR_A,
    });

    expect(checkCrossScopeConflicts(db, projectMem)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveByTrustTier
// ---------------------------------------------------------------------------

describe("resolveByTrustTier", () => {
  it("auto-resolves when memory_a agent has higher trust_tier", () => {
    const memHi = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_HI,
      project_id: PROJECT_ID, content: "high-trust claim",
    });
    const memLo = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_LO,
      project_id: PROJECT_ID, content: "low-trust claim",
    });

    const conflict = logConflict(db, {
      memoryA: memHi.id,
      memoryB: memLo.id,
      projectId: PROJECT_ID,
      conflictType: "intra_project",
    });

    const resolved = resolveByTrustTier(db, conflict.id);
    expect(resolved.resolved_at).not.toBeNull();
    expect(resolved.resolution).toContain(memHi.id);
    expect(resolved.resolved_by).toBe(AGENT_HI);
  });

  it("auto-resolves when memory_b agent has higher trust_tier", () => {
    const memLo = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_LO,
      project_id: PROJECT_ID, content: "low-trust claim",
    });
    const memHi = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_HI,
      project_id: PROJECT_ID, content: "high-trust claim",
    });

    const conflict = logConflict(db, {
      memoryA: memLo.id,
      memoryB: memHi.id,
      projectId: PROJECT_ID,
      conflictType: "intra_project",
    });

    const resolved = resolveByTrustTier(db, conflict.id);
    expect(resolved.resolved_at).not.toBeNull();
    expect(resolved.resolution).toContain(memHi.id);
    expect(resolved.resolved_by).toBe(AGENT_HI);
  });

  it("leaves conflict unresolved when both agents have the same trust_tier", () => {
    // AGENT_HI (tier=3) vs AGENT_MED (tier=2) — for same-tier test use two
    // agents with identical tiers.
    registerAgent(db, { agentId: "agent-same-1", displayName: "Same1", trustTier: 2, capabilities: [] });
    registerAgent(db, { agentId: "agent-same-2", displayName: "Same2", trustTier: 2, capabilities: [] });

    const memA = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: "agent-same-1",
      project_id: PROJECT_ID, content: "claim A",
    });
    const memB = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: "agent-same-2",
      project_id: PROJECT_ID, content: "claim B",
    });

    const conflict = logConflict(db, {
      memoryA: memA.id,
      memoryB: memB.id,
      projectId: PROJECT_ID,
      conflictType: "intra_project",
    });

    const result = resolveByTrustTier(db, conflict.id);
    // Must remain unresolved.
    expect(result.resolved_at).toBeNull();

    // Should still appear in unresolved conflicts.
    const unresolved = getUnresolvedConflicts(db, { projectId: PROJECT_ID });
    expect(unresolved.find((c) => c.id === conflict.id)).toBeDefined();
  });

  it("throws when conflictId does not exist", () => {
    expect(() => resolveByTrustTier(db, "no-such-conflict")).toThrow();
  });

  it("throws when the conflict is already resolved", () => {
    const memA = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_HI,
      project_id: PROJECT_ID, content: "a",
    });
    const memB = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_LO,
      project_id: PROJECT_ID, content: "b",
    });
    const conflict = logConflict(db, {
      memoryA: memA.id, memoryB: memB.id,
      projectId: PROJECT_ID, conflictType: "intra_project",
    });

    resolveByTrustTier(db, conflict.id); // first resolution
    expect(() => resolveByTrustTier(db, conflict.id)).toThrow(); // second call should throw
  });
});
