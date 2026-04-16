import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { insertMemory } from "../../src/db/queries/memories.js";
import { createProject } from "../../src/db/queries/projects.js";
import {
  getUnresolvedConflicts,
  logConflict,
  resolveConflict,
} from "../../src/db/queries/conflicts.js";

const DB = ":memory:";
const USER = "user-1";
const AGENT = "agent-conflicts";

let db: ReturnType<typeof getDb>;
let memA: string;
let memB: string;
let projectId: string;

beforeEach(() => {
  db = getDb(DB);
  registerAgent(db, { agentId: AGENT, displayName: "Conflict Agent", trustTier: 2, capabilities: [] });

  const proj = createProject(db, { userId: USER, name: "Conflict Project", description: "" });
  projectId = proj.id;

  const mA = insertMemory(db, {
    user_id: USER,
    scope: "project",
    agent_id: AGENT,
    project_id: projectId,
    content: "The sky is blue",
    framework: "claude-code",
  });
  const mB = insertMemory(db, {
    user_id: USER,
    scope: "project",
    agent_id: AGENT,
    project_id: projectId,
    content: "The sky is green",
    framework: "hermes",
  });
  memA = mA.id;
  memB = mB.id;
});

afterEach(() => {
  closeDb(DB);
});

// ---------------------------------------------------------------------------
// logConflict
// ---------------------------------------------------------------------------

describe("logConflict", () => {
  it("creates a conflict row with a ULID id", () => {
    const c = logConflict(db, {
      memoryA: memA,
      memoryB: memB,
      projectId,
      conflictType: "semantic_polarity",
    });
    expect(c.id).toBeTruthy();
    expect(c.memory_a).toBe(memA);
    expect(c.memory_b).toBe(memB);
    expect(c.project_id).toBe(projectId);
    expect(c.conflict_type).toBe("semantic_polarity");
    expect(c.resolved_at).toBeNull();
  });

  it("allows a conflict without a projectId", () => {
    const globalA = insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "X" });
    const globalB = insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "not X" });
    const c = logConflict(db, { memoryA: globalA.id, memoryB: globalB.id, conflictType: "polarity" });
    expect(c.project_id).toBeNull();
  });

  it("rejects missing required fields (Zod)", () => {
    expect(() =>
      logConflict(db, {
        // @ts-expect-error intentional bad input
        memoryA: "",
        memoryB: memB,
        conflictType: "semantic_polarity",
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveConflict
// ---------------------------------------------------------------------------

describe("resolveConflict", () => {
  it("sets resolved_at, resolution, and resolved_by", () => {
    const c = logConflict(db, { memoryA: memA, memoryB: memB, conflictType: "polarity" });
    const ok = resolveConflict(db, c.id, "trust_tier_wins", AGENT);
    expect(ok).toBe(true);

    const unresolved = getUnresolvedConflicts(db, {});
    expect(unresolved.find((r) => r.id === c.id)).toBeUndefined();
  });

  it("is idempotent: second resolve returns false", () => {
    const c = logConflict(db, { memoryA: memA, memoryB: memB, conflictType: "polarity" });
    resolveConflict(db, c.id, "auto", AGENT);
    expect(resolveConflict(db, c.id, "auto", AGENT)).toBe(false);
  });

  it("returns false for an unknown conflict id", () => {
    expect(resolveConflict(db, "ghost-id", "whatever", AGENT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getUnresolvedConflicts
// ---------------------------------------------------------------------------

describe("getUnresolvedConflicts", () => {
  it("returns all unresolved conflicts when no filters given", () => {
    logConflict(db, { memoryA: memA, memoryB: memB, projectId, conflictType: "type-a" });
    logConflict(db, { memoryA: memA, memoryB: memB, projectId, conflictType: "type-b" });

    const rows = getUnresolvedConflicts(db, {});
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by projectId", () => {
    const otherProj = createProject(db, { userId: USER, name: "Other", description: "" });
    const mC = insertMemory(db, { user_id: USER, scope: "project", agent_id: AGENT, project_id: otherProj.id, content: "c" });
    const mD = insertMemory(db, { user_id: USER, scope: "project", agent_id: AGENT, project_id: otherProj.id, content: "d" });

    logConflict(db, { memoryA: memA, memoryB: memB, projectId, conflictType: "type-a" });
    logConflict(db, { memoryA: mC.id, memoryB: mD.id, projectId: otherProj.id, conflictType: "type-a" });

    const rows = getUnresolvedConflicts(db, { projectId });
    expect(rows.every((r) => r.project_id === projectId)).toBe(true);
  });

  it("filters by since (detected_at >= since)", () => {
    const c = logConflict(db, { memoryA: memA, memoryB: memB, conflictType: "recent" });
    const futureCutoff = new Date(Date.now() + 60_000).toISOString();

    const rows = getUnresolvedConflicts(db, { since: futureCutoff });
    expect(rows.find((r) => r.id === c.id)).toBeUndefined();

    const pastCutoff = new Date(Date.now() - 60_000).toISOString();
    const rows2 = getUnresolvedConflicts(db, { since: pastCutoff });
    expect(rows2.find((r) => r.id === c.id)).toBeDefined();
  });

  it("filters by framework — matches if either side has the framework", () => {
    // memA has framework='claude-code', memB has framework='hermes' (set in beforeEach)
    const c = logConflict(db, { memoryA: memA, memoryB: memB, projectId, conflictType: "fw-test" });

    const byClaudeCode = getUnresolvedConflicts(db, { framework: "claude-code" });
    expect(byClaudeCode.find((r) => r.id === c.id)).toBeDefined();

    const byHermes = getUnresolvedConflicts(db, { framework: "hermes" });
    expect(byHermes.find((r) => r.id === c.id)).toBeDefined();

    const byOther = getUnresolvedConflicts(db, { framework: "codex" });
    expect(byOther.find((r) => r.id === c.id)).toBeUndefined();
  });

  it("filters by scope — matches if either side has the scope", () => {
    const c = logConflict(db, { memoryA: memA, memoryB: memB, projectId, conflictType: "scope-test" });

    const byProject = getUnresolvedConflicts(db, { scope: "project" });
    expect(byProject.find((r) => r.id === c.id)).toBeDefined();

    const byAgent = getUnresolvedConflicts(db, { scope: "agent" });
    expect(byAgent.find((r) => r.id === c.id)).toBeUndefined();
  });

  it("excludes resolved conflicts", () => {
    const c = logConflict(db, { memoryA: memA, memoryB: memB, conflictType: "resolved-test" });
    resolveConflict(db, c.id, "auto", AGENT);

    const rows = getUnresolvedConflicts(db, {});
    expect(rows.find((r) => r.id === c.id)).toBeUndefined();
  });
});
