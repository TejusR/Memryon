import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import {
  addAgent,
  archiveProject,
  createProject,
  getProject,
  getProjectAgents,
  isAgentMember,
  removeAgent,
} from "../../src/db/queries/projects.js";

const DB = ":memory:";

let db: ReturnType<typeof getDb>;

beforeEach(() => {
  db = getDb(DB);
  registerAgent(db, { agentId: "agent-1", displayName: "A1", trustTier: 2, capabilities: [] });
  registerAgent(db, { agentId: "agent-2", displayName: "A2", trustTier: 1, capabilities: [] });
});

afterEach(() => {
  closeDb(DB);
});

// ---------------------------------------------------------------------------
// createProject
// ---------------------------------------------------------------------------

describe("createProject", () => {
  it("creates a project and returns the row", () => {
    const proj = createProject(db, { userId: "u1", name: "Memryon", description: "desc" });
    expect(proj.id).toBeTruthy();
    expect(proj.user_id).toBe("u1");
    expect(proj.name).toBe("Memryon");
    expect(proj.archived_at).toBeNull();
  });

  it("generates a unique ULID per call", () => {
    const a = createProject(db, { userId: "u1", name: "A", description: "" });
    const b = createProject(db, { userId: "u1", name: "B", description: "" });
    expect(a.id).not.toBe(b.id);
  });

  it("defaults description to empty string", () => {
    const proj = createProject(db, { userId: "u1", name: "no desc" } as never);
    // Zod default applied
    expect(proj.description).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getProject
// ---------------------------------------------------------------------------

describe("getProject", () => {
  it("returns the project row", () => {
    const proj = createProject(db, { userId: "u1", name: "P", description: "" });
    const fetched = getProject(db, proj.id);
    expect(fetched?.id).toBe(proj.id);
  });

  it("returns undefined for an unknown id", () => {
    expect(getProject(db, "ghost")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// archiveProject
// ---------------------------------------------------------------------------

describe("archiveProject", () => {
  it("sets archived_at", () => {
    const proj = createProject(db, { userId: "u1", name: "P", description: "" });
    const ok = archiveProject(db, proj.id);
    expect(ok).toBe(true);

    const fetched = getProject(db, proj.id);
    expect(fetched?.archived_at).not.toBeNull();
  });

  it("is idempotent: second call returns false", () => {
    const proj = createProject(db, { userId: "u1", name: "P", description: "" });
    archiveProject(db, proj.id);
    expect(archiveProject(db, proj.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addAgent / removeAgent / getProjectAgents / isAgentMember
// ---------------------------------------------------------------------------

describe("project membership", () => {
  it("addAgent adds an agent and isAgentMember returns true", () => {
    const proj = createProject(db, { userId: "u1", name: "P", description: "" });
    addAgent(db, { projectId: proj.id, agentId: "agent-1", role: "contributor" });
    expect(isAgentMember(db, proj.id, "agent-1")).toBe(true);
  });

  it("isAgentMember returns false when agent is not a member", () => {
    const proj = createProject(db, { userId: "u1", name: "P", description: "" });
    expect(isAgentMember(db, proj.id, "agent-1")).toBe(false);
  });

  it("addAgent upserts the role on duplicate", () => {
    const proj = createProject(db, { userId: "u1", name: "P", description: "" });
    addAgent(db, { projectId: proj.id, agentId: "agent-1", role: "contributor" });
    const updated = addAgent(db, { projectId: proj.id, agentId: "agent-1", role: "owner" });
    expect(updated.role).toBe("owner");
  });

  it("getProjectAgents lists all members", () => {
    const proj = createProject(db, { userId: "u1", name: "P", description: "" });
    addAgent(db, { projectId: proj.id, agentId: "agent-1", role: "owner" });
    addAgent(db, { projectId: proj.id, agentId: "agent-2", role: "readonly" });

    const members = getProjectAgents(db, proj.id);
    expect(members).toHaveLength(2);
    const ids = members.map((m) => m.agent_id);
    expect(ids).toContain("agent-1");
    expect(ids).toContain("agent-2");
  });

  it("removeAgent removes the member", () => {
    const proj = createProject(db, { userId: "u1", name: "P", description: "" });
    addAgent(db, { projectId: proj.id, agentId: "agent-1", role: "contributor" });
    const ok = removeAgent(db, proj.id, "agent-1");
    expect(ok).toBe(true);
    expect(isAgentMember(db, proj.id, "agent-1")).toBe(false);
  });

  it("removeAgent returns false when agent was not a member", () => {
    const proj = createProject(db, { userId: "u1", name: "P", description: "" });
    expect(removeAgent(db, proj.id, "agent-1")).toBe(false);
  });
});
