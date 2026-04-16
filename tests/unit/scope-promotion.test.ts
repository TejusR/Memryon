import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { addAgent, createProject } from "../../src/db/queries/projects.js";
import { insertMemory } from "../../src/db/queries/memories.js";
import { promoteMemory, demoteMemory } from "../../src/scope/promotion.js";
import { ScopeViolationError } from "../../src/utils/errors.js";

const DB = ":memory:";
const USER = "user-prom";
/** trust_tier=1 — not allowed to promote to global */
const LOW_AGENT = "agent-prom-low";
/** trust_tier=2 — allowed to promote to global */
const HIGH_AGENT = "agent-prom-high";
/** Completely different agent (not the author) */
const OTHER_AGENT = "agent-prom-other";
let PROJECT_ID: string;
let PROJECT_B_ID: string;

function seed(db: ReturnType<typeof getDb>) {
  registerAgent(db, { agentId: LOW_AGENT, displayName: "Low Trust", trustTier: 1, capabilities: [] });
  registerAgent(db, { agentId: HIGH_AGENT, displayName: "High Trust", trustTier: 2, capabilities: [] });
  registerAgent(db, { agentId: OTHER_AGENT, displayName: "Other", trustTier: 2, capabilities: [] });

  const proj = createProject(db, { userId: USER, name: "Promo Project", description: "" });
  PROJECT_ID = proj.id;
  // HIGH_AGENT and LOW_AGENT are members; OTHER_AGENT is NOT.
  addAgent(db, { projectId: PROJECT_ID, agentId: HIGH_AGENT, role: "owner" });
  addAgent(db, { projectId: PROJECT_ID, agentId: LOW_AGENT, role: "contributor" });

  const projB = createProject(db, { userId: USER, name: "Project B", description: "" });
  PROJECT_B_ID = projB.id;
  addAgent(db, { projectId: PROJECT_B_ID, agentId: HIGH_AGENT, role: "owner" });
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
// promoteMemory — happy paths
// ---------------------------------------------------------------------------

describe("promoteMemory — agent → project", () => {
  it("succeeds when the author is a project member", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "agent", agent_id: HIGH_AGENT, content: "promote me" });
    const updated = promoteMemory(db, {
      memoryId: mem.id,
      requestingAgentId: HIGH_AGENT,
      newScope: "project",
      projectId: PROJECT_ID,
    });
    expect(updated.scope).toBe("project");
    expect(updated.project_id).toBe(PROJECT_ID);
  });

  it("preserves agent_id (provenance) after promotion", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "agent", agent_id: HIGH_AGENT, content: "provenance" });
    const updated = promoteMemory(db, {
      memoryId: mem.id,
      requestingAgentId: HIGH_AGENT,
      newScope: "project",
      projectId: PROJECT_ID,
    });
    expect(updated.agent_id).toBe(HIGH_AGENT);
  });
});

describe("promoteMemory — agent → global", () => {
  it("succeeds when trust_tier >= 2", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "agent", agent_id: HIGH_AGENT, content: "going global" });
    const updated = promoteMemory(db, {
      memoryId: mem.id,
      requestingAgentId: HIGH_AGENT,
      newScope: "global",
    });
    expect(updated.scope).toBe("global");
    expect(updated.project_id).toBeNull();
    expect(updated.agent_id).toBe(HIGH_AGENT);
  });
});

describe("promoteMemory — project → global", () => {
  it("succeeds when trust_tier >= 2", () => {
    const mem = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: HIGH_AGENT,
      project_id: PROJECT_ID, content: "project to global",
    });
    const updated = promoteMemory(db, {
      memoryId: mem.id,
      requestingAgentId: HIGH_AGENT,
      newScope: "global",
    });
    expect(updated.scope).toBe("global");
    expect(updated.project_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// promoteMemory — error cases
// ---------------------------------------------------------------------------

describe("promoteMemory — non-author is rejected", () => {
  it("throws ScopeViolationError when requester is not the author", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "agent", agent_id: HIGH_AGENT, content: "mine" });
    expect(() =>
      promoteMemory(db, {
        memoryId: mem.id,
        requestingAgentId: OTHER_AGENT,
        newScope: "global",
      })
    ).toThrowError(ScopeViolationError);
  });
});

describe("promoteMemory — agent → project without project membership", () => {
  it("throws ScopeViolationError when agent is not a project member", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "agent", agent_id: OTHER_AGENT, content: "not a member" });
    expect(() =>
      promoteMemory(db, {
        memoryId: mem.id,
        requestingAgentId: OTHER_AGENT,
        newScope: "project",
        projectId: PROJECT_ID,
      })
    ).toThrowError(ScopeViolationError);
  });
});

describe("promoteMemory — global promotion blocked by trust_tier", () => {
  it("throws ScopeViolationError when trust_tier < 2", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "agent", agent_id: LOW_AGENT, content: "low trust" });
    expect(() =>
      promoteMemory(db, {
        memoryId: mem.id,
        requestingAgentId: LOW_AGENT,
        newScope: "global",
      })
    ).toThrowError(ScopeViolationError);
  });
});

describe("promoteMemory — direction validation", () => {
  it("throws when trying to 'promote' global → project (narrowing)", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "global", agent_id: HIGH_AGENT, content: "global" });
    expect(() =>
      promoteMemory(db, {
        memoryId: mem.id,
        requestingAgentId: HIGH_AGENT,
        newScope: "project",
        projectId: PROJECT_ID,
      })
    ).toThrowError(ScopeViolationError);
  });

  it("throws when projectId is missing for project-scope promotion", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "agent", agent_id: HIGH_AGENT, content: "needs project" });
    expect(() =>
      promoteMemory(db, {
        memoryId: mem.id,
        requestingAgentId: HIGH_AGENT,
        newScope: "project",
        // projectId intentionally omitted
      })
    ).toThrowError(ScopeViolationError);
  });
});

// ---------------------------------------------------------------------------
// demoteMemory — happy paths
// ---------------------------------------------------------------------------

describe("demoteMemory — global → project", () => {
  it("sets scope to project and sets project_id correctly", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "global", agent_id: HIGH_AGENT, content: "demote to proj" });
    const updated = demoteMemory(db, {
      memoryId: mem.id,
      requestingAgentId: HIGH_AGENT,
      newScope: "project",
      projectId: PROJECT_ID,
    });
    expect(updated.scope).toBe("project");
    expect(updated.project_id).toBe(PROJECT_ID);
    expect(updated.agent_id).toBe(HIGH_AGENT);
  });
});

describe("demoteMemory — global → agent", () => {
  it("sets scope to agent and clears project_id", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "global", agent_id: HIGH_AGENT, content: "back to agent" });
    const updated = demoteMemory(db, {
      memoryId: mem.id,
      requestingAgentId: HIGH_AGENT,
      newScope: "agent",
    });
    expect(updated.scope).toBe("agent");
    expect(updated.project_id).toBeNull();
  });
});

describe("demoteMemory — project → agent", () => {
  it("clears scope to agent and clears project_id", () => {
    const mem = insertMemory(db, {
      user_id: USER, scope: "project", agent_id: HIGH_AGENT,
      project_id: PROJECT_ID, content: "back to private",
    });
    const updated = demoteMemory(db, {
      memoryId: mem.id,
      requestingAgentId: HIGH_AGENT,
      newScope: "agent",
    });
    expect(updated.scope).toBe("agent");
    expect(updated.project_id).toBeNull();
    expect(updated.agent_id).toBe(HIGH_AGENT);
  });
});

// ---------------------------------------------------------------------------
// demoteMemory — error cases
// ---------------------------------------------------------------------------

describe("demoteMemory — non-author is rejected", () => {
  it("throws ScopeViolationError when requester is not the author", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "global", agent_id: HIGH_AGENT, content: "mine" });
    expect(() =>
      demoteMemory(db, {
        memoryId: mem.id,
        requestingAgentId: OTHER_AGENT,
        newScope: "agent",
      })
    ).toThrowError(ScopeViolationError);
  });
});

describe("demoteMemory — direction validation", () => {
  it("throws when 'demoting' agent → project (that is a promotion)", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "agent", agent_id: HIGH_AGENT, content: "narrow" });
    expect(() =>
      demoteMemory(db, {
        memoryId: mem.id,
        requestingAgentId: HIGH_AGENT,
        newScope: "project",
        projectId: PROJECT_ID,
      })
    ).toThrowError(ScopeViolationError);
  });

  it("throws when 'demoting' agent → agent (same scope)", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "agent", agent_id: HIGH_AGENT, content: "same" });
    expect(() =>
      demoteMemory(db, {
        memoryId: mem.id,
        requestingAgentId: HIGH_AGENT,
        // agent → agent is same rank, should be rejected
        newScope: "agent",
      })
    ).toThrowError(ScopeViolationError);
  });

  it("throws when projectId is missing for project-scope demotion", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "global", agent_id: HIGH_AGENT, content: "needs project id" });
    expect(() =>
      demoteMemory(db, {
        memoryId: mem.id,
        requestingAgentId: HIGH_AGENT,
        newScope: "project",
        // projectId intentionally omitted
      })
    ).toThrowError(ScopeViolationError);
  });
});

describe("demoteMemory — provenance preserved", () => {
  it("agent_id is unchanged after demotion", () => {
    const mem = insertMemory(db, { user_id: USER, scope: "global", agent_id: HIGH_AGENT, content: "prov" });
    const updated = demoteMemory(db, {
      memoryId: mem.id,
      requestingAgentId: HIGH_AGENT,
      newScope: "agent",
    });
    expect(updated.agent_id).toBe(HIGH_AGENT);
  });
});
