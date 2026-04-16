import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { addAgent, createProject } from "../../src/db/queries/projects.js";
import { insertMemory, invalidateMemory } from "../../src/db/queries/memories.js";
import { scopedRecall } from "../../src/scope/fan-out.js";

const DB = ":memory:";
const USER = "user-fo";
const AGENT_A = "agent-fo-a";
const AGENT_B = "agent-fo-b";
let PROJECT_ID: string;

function seed(db: ReturnType<typeof getDb>) {
  registerAgent(db, { agentId: AGENT_A, displayName: "FO Agent A", trustTier: 2, capabilities: [] });
  registerAgent(db, { agentId: AGENT_B, displayName: "FO Agent B", trustTier: 1, capabilities: [] });
  const proj = createProject(db, { userId: USER, name: "Fan-out Project", description: "" });
  PROJECT_ID = proj.id;
  addAgent(db, { projectId: PROJECT_ID, agentId: AGENT_A, role: "owner" });
  addAgent(db, { projectId: PROJECT_ID, agentId: AGENT_B, role: "contributor" });
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
// Scope priority ordering
// ---------------------------------------------------------------------------

describe("scopedRecall — scope priority ordering", () => {
  it("returns project > agent > global ordering when all three tiers present", () => {
    const globalMem = insertMemory(db, {
      user_id: USER, scope: "global", agent_id: AGENT_A, content: "global fact",
    });
    const agentMem = insertMemory(db, {
      user_id: USER, scope: "agent", agent_id: AGENT_A, content: "agent fact",
    });
    const projectMem = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_A,
      project_id: PROJECT_ID, content: "project fact",
    });

    const results = scopedRecall(db, {
      userId: USER, agentId: AGENT_A, projectId: PROJECT_ID, limit: 10,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(projectMem.id);
    expect(ids).toContain(agentMem.id);
    expect(ids).toContain(globalMem.id);

    const projIdx = ids.indexOf(projectMem.id);
    const agentIdx = ids.indexOf(agentMem.id);
    const globalIdx = ids.indexOf(globalMem.id);
    expect(projIdx).toBeLessThan(agentIdx);
    expect(agentIdx).toBeLessThan(globalIdx);
  });

  it("annotates rows with correct scopePriority values", () => {
    insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT_A, content: "g" });
    insertMemory(db, { user_id: USER, scope: "agent", agent_id: AGENT_A, content: "a" });
    insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_A,
      project_id: PROJECT_ID, content: "p",
    });

    const results = scopedRecall(db, {
      userId: USER, agentId: AGENT_A, projectId: PROJECT_ID, limit: 10,
    });

    for (const r of results) {
      if (r.scope === "project") expect(r.scopePriority).toBe(1);
      if (r.scope === "agent") expect(r.scopePriority).toBe(2);
      if (r.scope === "global") expect(r.scopePriority).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Project tier is omitted when no projectId is given
// ---------------------------------------------------------------------------

describe("scopedRecall — no projectId", () => {
  it("omits project-scoped memories when projectId is not provided", () => {
    insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_A,
      project_id: PROJECT_ID, content: "should not appear",
    });
    insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT_A, content: "global" });

    const results = scopedRecall(db, { userId: USER, agentId: AGENT_A, limit: 10 });
    expect(results.every((r) => r.scope !== "project")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("scopedRecall — deduplication", () => {
  it("does not return the same memory id twice", () => {
    // Insert several memories across tiers.
    for (let i = 0; i < 3; i++) {
      insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT_A, content: `g${i}` });
      insertMemory(db, { user_id: USER, scope: "agent", agent_id: AGENT_A, content: `a${i}` });
    }

    const results = scopedRecall(db, {
      userId: USER, agentId: AGENT_A, projectId: PROJECT_ID, limit: 20,
    });

    const ids = results.map((r) => r.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

// ---------------------------------------------------------------------------
// Limit
// ---------------------------------------------------------------------------

describe("scopedRecall — limit", () => {
  it("respects the limit across all tiers", () => {
    for (let i = 0; i < 4; i++) {
      insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT_A, content: `g${i}` });
      insertMemory(db, { user_id: USER, scope: "agent", agent_id: AGENT_A, content: `a${i}` });
      insertMemory(db, {
        user_id: USER, scope: "project", agent_id: AGENT_A,
        project_id: PROJECT_ID, content: `p${i}`,
      });
    }
    const results = scopedRecall(db, {
      userId: USER, agentId: AGENT_A, projectId: PROJECT_ID, limit: 5,
    });
    expect(results).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Invalidated memories are excluded
// ---------------------------------------------------------------------------

describe("scopedRecall — invalidated memories", () => {
  it("does not include invalidated memories", () => {
    const m = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT_A,
      project_id: PROJECT_ID, content: "stale",
    });
    invalidateMemory(db, m.id, AGENT_A);

    const results = scopedRecall(db, {
      userId: USER, agentId: AGENT_A, projectId: PROJECT_ID, limit: 10,
    });
    expect(results.find((r) => r.id === m.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// User isolation
// ---------------------------------------------------------------------------

describe("scopedRecall — user isolation", () => {
  it("never returns memories from a different user", () => {
    insertMemory(db, { user_id: "other-user", scope: "global", agent_id: AGENT_A, content: "private" });

    const results = scopedRecall(db, { userId: USER, agentId: AGENT_A, limit: 10 });
    expect(results.every((r) => r.user_id === USER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent-private isolation
// ---------------------------------------------------------------------------

describe("scopedRecall — agent-private isolation", () => {
  it("returns only the requesting agent's private memories, not another agent's", () => {
    insertMemory(db, { user_id: USER, scope: "agent", agent_id: AGENT_A, content: "mine" });
    insertMemory(db, { user_id: USER, scope: "agent", agent_id: AGENT_B, content: "not mine" });

    const results = scopedRecall(db, { userId: USER, agentId: AGENT_A, limit: 10 });
    const agentScoped = results.filter((r) => r.scope === "agent");
    expect(agentScoped.every((r) => r.agent_id === AGENT_A)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FTS query filtering
// ---------------------------------------------------------------------------

describe("scopedRecall — FTS query", () => {
  it("returns only memories matching the query term", () => {
    insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT_A, content: "the cat sat on the mat" });
    insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT_A, content: "completely unrelated" });

    const results = scopedRecall(db, { userId: USER, agentId: AGENT_A, query: "cat", limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.content.includes("cat"))).toBe(true);
  });
});
