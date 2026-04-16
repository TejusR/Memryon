import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { createProject } from "../../src/db/queries/projects.js";
import {
  fanOutQuery,
  findByFTS,
  getValidMemories,
  insertMemory,
  invalidateMemory,
} from "../../src/db/queries/memories.js";

const DB = ":memory:";

// Shared fixtures
const USER = "user-1";
const AGENT = "agent-1";
const AGENT_2 = "agent-2";
let PROJECT_ID: string;

function seed(db: ReturnType<typeof getDb>) {
  registerAgent(db, {
    agentId: AGENT,
    displayName: "Agent One",
    trustTier: 2,
    capabilities: [],
  });
  registerAgent(db, {
    agentId: AGENT_2,
    displayName: "Agent Two",
    trustTier: 1,
    capabilities: [],
  });
  const proj = createProject(db, {
    userId: USER,
    name: "Test Project",
    description: "",
  });
  PROJECT_ID = proj.id;
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
// insertMemory
// ---------------------------------------------------------------------------

describe("insertMemory", () => {
  it("inserts an agent-scoped memory and returns the row", () => {
    const row = insertMemory(db, {
      user_id: USER,
      scope: "agent",
      agent_id: AGENT,
      content: "agent memory",
    });
    expect(row.id).toBeTruthy();
    expect(row.scope).toBe("agent");
    expect(row.project_id).toBeNull();
    expect(row.content).toBe("agent memory");
  });

  it("inserts a project-scoped memory with project_id", () => {
    const row = insertMemory(db, {
      user_id: USER,
      scope: "project",
      agent_id: AGENT,
      project_id: PROJECT_ID,
      content: "project memory",
    });
    expect(row.scope).toBe("project");
    expect(row.project_id).toBe(PROJECT_ID);
  });

  it("inserts a global-scoped memory", () => {
    const row = insertMemory(db, {
      user_id: USER,
      scope: "global",
      agent_id: AGENT,
      content: "global memory",
    });
    expect(row.scope).toBe("global");
    expect(row.project_id).toBeNull();
  });

  it("rejects scope='project' without project_id (Zod)", () => {
    expect(() =>
      insertMemory(db, {
        user_id: USER,
        // @ts-expect-error intentional bad input
        scope: "project",
        agent_id: AGENT,
        content: "missing project_id",
      })
    ).toThrow();
  });

  it("rejects an invalid scope value (Zod)", () => {
    expect(() =>
      insertMemory(db, {
        user_id: USER,
        // @ts-expect-error intentional bad input
        scope: "cosmos",
        agent_id: AGENT,
        content: "bad scope",
      })
    ).toThrow();
  });

  it("serialises tags as JSON", () => {
    const row = insertMemory(db, {
      user_id: USER,
      scope: "global",
      agent_id: AGENT,
      content: "tagged",
      tags: ["foo", "bar"],
    });
    expect(JSON.parse(row.tags)).toEqual(["foo", "bar"]);
  });

  it("generates a unique ULID per call", () => {
    const a = insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "a" });
    const b = insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "b" });
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// getValidMemories
// ---------------------------------------------------------------------------

describe("getValidMemories", () => {
  it("returns only non-invalidated memories for the user", () => {
    const m = insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "valid" });
    insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "will invalidate" });
    invalidateMemory(db, m.id, AGENT);

    const rows = getValidMemories(db, { user_id: USER });
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(m.id);
  });

  it("filters by scope", () => {
    insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "g" });
    insertMemory(db, { user_id: USER, scope: "agent", agent_id: AGENT, content: "a" });

    const globals = getValidMemories(db, { user_id: USER, scope: "global" });
    expect(globals.every((r) => r.scope === "global")).toBe(true);
  });

  it("filters by agent_id", () => {
    insertMemory(db, { user_id: USER, scope: "agent", agent_id: AGENT, content: "agent1" });
    insertMemory(db, { user_id: USER, scope: "agent", agent_id: AGENT_2, content: "agent2" });

    const rows = getValidMemories(db, { user_id: USER, agent_id: AGENT });
    expect(rows.every((r) => r.agent_id === AGENT)).toBe(true);
  });

  it("respects limit and offset", () => {
    for (let i = 0; i < 5; i++) {
      insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: `mem ${i}` });
    }
    const page1 = getValidMemories(db, { user_id: USER }, 2, 0);
    const page2 = getValidMemories(db, { user_id: USER }, 2, 2);
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page1[0]!.id).not.toBe(page2[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// invalidateMemory
// ---------------------------------------------------------------------------

describe("invalidateMemory", () => {
  it("sets invalidated_at and invalidated_by", () => {
    const m = insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "bye" });
    const changed = invalidateMemory(db, m.id, AGENT_2);
    expect(changed).toBe(true);

    const rows = getValidMemories(db, { user_id: USER });
    expect(rows.find((r) => r.id === m.id)).toBeUndefined();
  });

  it("is idempotent: second call returns false (already invalidated)", () => {
    const m = insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "once" });
    invalidateMemory(db, m.id, AGENT);
    const second = invalidateMemory(db, m.id, AGENT);
    expect(second).toBe(false);
  });

  it("returns false for a non-existent memory id", () => {
    expect(invalidateMemory(db, "does-not-exist", AGENT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fanOutQuery — scope priority ordering
// ---------------------------------------------------------------------------

describe("fanOutQuery", () => {
  it("returns project > agent > global ordering", () => {
    const global = insertMemory(db, {
      user_id: USER, scope: "global", agent_id: AGENT, content: "global mem",
    });
    const agentMem = insertMemory(db, {
      user_id: USER, scope: "agent", agent_id: AGENT, content: "agent mem",
    });
    const project = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT,
      project_id: PROJECT_ID, content: "project mem",
    });

    const results = fanOutQuery(db, USER, AGENT, PROJECT_ID, 10);
    const scopes = results.map((r) => r.scope);

    // project must come before agent, agent before global
    const projIdx = scopes.indexOf("project");
    const agentIdx = scopes.indexOf("agent");
    const globalIdx = scopes.indexOf("global");
    expect(projIdx).toBeLessThan(agentIdx);
    expect(agentIdx).toBeLessThan(globalIdx);

    const ids = results.map((r) => r.id);
    expect(ids).toContain(project.id);
    expect(ids).toContain(agentMem.id);
    expect(ids).toContain(global.id);
  });

  it("omits project tier when projectId is not given", () => {
    insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT,
      project_id: PROJECT_ID, content: "project only",
    });
    insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "global" });

    const results = fanOutQuery(db, USER, AGENT, undefined, 10);
    expect(results.every((r) => r.scope !== "project")).toBe(true);
  });

  it("does not return invalidated memories", () => {
    const m = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: AGENT,
      project_id: PROJECT_ID, content: "stale project",
    });
    invalidateMemory(db, m.id, AGENT);

    const results = fanOutQuery(db, USER, AGENT, PROJECT_ID, 10);
    expect(results.find((r) => r.id === m.id)).toBeUndefined();
  });

  it("does not return memories belonging to a different user", () => {
    insertMemory(db, { user_id: "other-user", scope: "global", agent_id: AGENT, content: "private" });

    const results = fanOutQuery(db, USER, AGENT, undefined, 10);
    expect(results.every((r) => r.user_id === USER)).toBe(true);
  });

  it("respects the limit across all tiers", () => {
    for (let i = 0; i < 3; i++) {
      insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: `g${i}` });
      insertMemory(db, { user_id: USER, scope: "agent", agent_id: AGENT, content: `a${i}` });
      insertMemory(db, {
        user_id: USER, scope: "project", agent_id: AGENT,
        project_id: PROJECT_ID, content: `p${i}`,
      });
    }
    const results = fanOutQuery(db, USER, AGENT, PROJECT_ID, 5);
    expect(results).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// findByFTS
// ---------------------------------------------------------------------------

describe("findByFTS", () => {
  it("returns memories whose content matches the query", () => {
    insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "the cat sat on the mat" });
    insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "completely unrelated" });

    const rows = findByFTS(db, "cat", { user_id: USER }, 10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.content.includes("cat"))).toBe(true);
  });

  it("does not return invalidated memories", () => {
    const m = insertMemory(db, { user_id: USER, scope: "global", agent_id: AGENT, content: "uniquetermxyz" });
    invalidateMemory(db, m.id, AGENT);

    const rows = findByFTS(db, "uniquetermxyz", { user_id: USER }, 10);
    expect(rows.find((r) => r.id === m.id)).toBeUndefined();
  });
});
