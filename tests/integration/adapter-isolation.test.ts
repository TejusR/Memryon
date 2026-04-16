import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryToolClient } from "../../src/adapters/base.js";
import { HermesAdapter, OpenClawAdapter } from "../../src/adapters/index.js";
import { closeDb, getDb } from "../../src/db/connection.js";
import { listAdapterErrors } from "../../src/db/queries/adapter-errors.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { addAgent, createProject } from "../../src/db/queries/projects.js";

const DB = ":memory:";
const USER = "user-adapter-integration";
const OPENCLAW = "openclaw-agent";
const HERMES = "hermes-agent";

let db: ReturnType<typeof getDb>;
let projectId: string;

beforeEach(() => {
  db = getDb(DB);

  registerAgent(db, {
    agentId: OPENCLAW,
    displayName: "OpenClaw",
    trustTier: 2,
    capabilities: [],
  });
  registerAgent(db, {
    agentId: HERMES,
    displayName: "Hermes",
    trustTier: 2,
    capabilities: [],
  });

  const project = createProject(db, {
    userId: USER,
    name: "memryon",
    description: "Adapter integration test project",
  });
  projectId = project.id;

  addAgent(db, {
    projectId,
    agentId: OPENCLAW,
    role: "owner",
  });
  addAgent(db, {
    projectId,
    agentId: HERMES,
    role: "contributor",
  });
});

afterEach(() => {
  closeDb(DB);
});

describe("adapter isolation", () => {
  it("logs a failing adapter error while healthy adapters continue storing and recalling memories", async () => {
    const failingClient: MemoryToolClient = {
      remember: async () => {
        throw new Error("simulated remember failure");
      },
      recall: async () => ({
        results: [],
        scope_breakdown: { project: 0, agent: 0, global: 0 },
      }),
      forget: async () => ({
        status: "forgotten",
        memcell_id: "unused",
      }),
    };

    const openClaw = new OpenClawAdapter(db, failingClient);
    const hermes = new HermesAdapter(db, {
      defaultAgentId: HERMES,
      defaultUserId: USER,
    });

    await openClaw.onEvent({
      framework: "openclaw",
      type: "session.started",
      sessionId: "faulty-openclaw-session",
      agentId: OPENCLAW,
      userId: USER,
      projectId,
    });

    const failed = await openClaw.onEvent({
      framework: "openclaw",
      type: "PostToolUse",
      sessionId: "faulty-openclaw-session",
      toolName: "sync_project_context",
      input: { project_id: projectId },
      output: { status: "failed" },
    });

    const stored = await hermes.store({
      content: "Architecture uses SQLite with FTS5",
      project_id: projectId,
      session_id: "healthy-hermes-session",
    });
    const recalled = await hermes.retrieve({
      query: "SQLite FTS5",
      project_id: projectId,
      top_k: 10,
    });

    const persistedCount = db
      .prepare<[string, string], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM memories
         WHERE agent_id = ? AND framework = ? AND invalidated_at IS NULL`
      )
      .get(HERMES, "hermes");
    const errors = listAdapterErrors(db, "openclaw");

    expect(failed).toBeNull();
    expect(stored?.status).toBe("stored");
    expect(
      recalled.results.some((row) =>
        row.content.includes("Architecture uses SQLite with FTS5")
      )
    ).toBe(true);
    expect(persistedCount?.count).toBeGreaterThan(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("simulated remember failure");
  });
});
