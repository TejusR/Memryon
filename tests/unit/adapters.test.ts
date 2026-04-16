import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryToolClient,
  ToolCallRequest,
  ToolCallResponse,
} from "../../src/adapters/base.js";
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  HermesAdapter,
  OpenClawAdapter,
} from "../../src/adapters/index.js";
import { closeDb, getDb } from "../../src/db/connection.js";
import { listAdapterErrors } from "../../src/db/queries/adapter-errors.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { createProject } from "../../src/db/queries/projects.js";
import type { ProjectContextResult } from "../../src/mcp/tools/project-context.js";
import type { RecallResult } from "../../src/mcp/tools/recall.js";
import type { RememberResult } from "../../src/mcp/tools/remember.js";

const DB = ":memory:";
const USER = "user-adapters";
const AGENT = "agent-adapters";
let PROJECT_ID = "";

interface MockClientCallLog {
  remember: Array<Record<string, unknown>>;
  recall: Array<Record<string, unknown>>;
  forget: Array<Record<string, unknown>>;
  projectContext: Array<Record<string, unknown>>;
}

function createMockClient(overrides?: Partial<MemoryToolClient>): {
  client: MemoryToolClient;
  calls: MockClientCallLog;
} {
  const calls: MockClientCallLog = {
    remember: [],
    recall: [],
    forget: [],
    projectContext: [],
  };

  const projectContext: ProjectContextResult = {
    project: {
      id: PROJECT_ID,
      user_id: USER,
      name: "Adapters Project",
      description: "",
      created_at: new Date().toISOString(),
      archived_at: null,
    },
    agents: [],
    memory_count: 2,
    recent_activity: [
      {
        id: "activity-1",
        content: "Recent project activity",
        agent_id: AGENT,
        recorded_at: new Date().toISOString(),
      },
    ],
  };

  const client: MemoryToolClient = {
    remember: async (args) => {
      calls.remember.push(args as unknown as Record<string, unknown>);
      return {
        memcell_id: "mem-1",
        status: "stored",
      } satisfies RememberResult;
    },
    recall: async (args) => {
      calls.recall.push(args as unknown as Record<string, unknown>);
      return {
        results: [],
        scope_breakdown: { project: 0, agent: 0, global: 0 },
      } satisfies RecallResult;
    },
    forget: async (args) => {
      calls.forget.push(args as unknown as Record<string, unknown>);
      return {
        status: "forgotten",
        memcell_id: String(args.memcell_id),
      };
    },
    projectContext: async (args) => {
      calls.projectContext.push(args as unknown as Record<string, unknown>);
      return projectContext;
    },
    ...overrides,
  };

  return { client, calls };
}

function seed(db: ReturnType<typeof getDb>): void {
  registerAgent(db, {
    agentId: AGENT,
    displayName: "Adapters Agent",
    trustTier: 2,
    capabilities: [],
  });

  const project = createProject(db, {
    userId: USER,
    name: "Adapters Project",
    description: "",
  });

  PROJECT_ID = project.id;
}

let db: ReturnType<typeof getDb>;

beforeEach(() => {
  db = getDb(DB);
  seed(db);
});

afterEach(() => {
  closeDb(DB);
  vi.restoreAllMocks();
});

describe("OpenClawAdapter", () => {
  it("maps PostToolUse events to remember calls and project scope when project context is active", async () => {
    const { client, calls } = createMockClient();
    const adapter = new OpenClawAdapter(db, client);

    await adapter.onEvent({
      framework: "openclaw",
      type: "session.started",
      sessionId: "open-session",
      agentId: AGENT,
      userId: USER,
      projectId: PROJECT_ID,
    });

    await adapter.onEvent({
      framework: "openclaw",
      type: "PostToolUse",
      sessionId: "open-session",
      toolName: "search_code",
      input: { query: "remember" },
      output: { files: ["src/mcp/tools/remember.ts"] },
    });

    expect(calls.remember).toHaveLength(1);
    expect(calls.remember[0]?.framework).toBe("openclaw");
    expect(calls.remember[0]?.agent_id).toBe(AGENT);
    expect(calls.remember[0]?.scope).toBe("project");
    expect(calls.remember[0]?.project_id).toBe(PROJECT_ID);

    const buffered = db
      .prepare<[string, string], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM candidate_buffer
         WHERE framework = 'openclaw' AND agent_id = ? AND project_id = ?`
      )
      .get(AGENT, PROJECT_ID);

    expect(buffered?.count).toBeGreaterThan(0);
  });
});

describe("HermesAdapter", () => {
  it("maps store, retrieve, and delete to remember, recall, and forget with stamped provenance", async () => {
    const { client, calls } = createMockClient();
    const adapter = new HermesAdapter(
      db,
      { defaultAgentId: AGENT, defaultUserId: USER },
      client
    );

    const stored = await adapter.store({
      content: "Hermes stored memory",
      session_id: "hermes-session",
      project_id: PROJECT_ID,
    });

    const retrieved = await adapter.retrieve({
      query: "Hermes",
      project_id: PROJECT_ID,
    });

    const deleted = await adapter.delete("mem-123");

    expect(stored?.status).toBe("stored");
    expect(retrieved.scope_breakdown.project).toBe(0);
    expect(deleted?.status).toBe("forgotten");
    expect(calls.remember[0]?.framework).toBe("hermes");
    expect(calls.remember[0]?.agent_id).toBe(AGENT);
    expect(calls.remember[0]?.scope).toBe("project");
    expect(calls.recall[0]?.agent_id).toBe(AGENT);
    expect(calls.forget[0]?.agent_id).toBe(AGENT);
  });
});

describe("ClaudeCodeAdapter", () => {
  it("injects CLAUDE.md and project_context at session start, then captures tool results", async () => {
    const { client, calls } = createMockClient();
    const adapter = new ClaudeCodeAdapter(db, {}, client);

    const started = (await adapter.onEvent({
      framework: "claude-code",
      type: "session.started",
      sessionId: "claude-session",
      agentId: AGENT,
      userId: USER,
      projectId: PROJECT_ID,
    })) as Record<string, string>;

    await adapter.onEvent({
      framework: "claude-code",
      type: "PostToolUse",
      sessionId: "claude-session",
      toolName: "run_tests",
      input: { suite: "unit" },
      output: { passed: 12 },
    });

    expect(started.injected_context).toContain("CLAUDE.md");
    expect(started.injected_context).toContain("Project Context");
    expect(calls.projectContext).toHaveLength(1);
    expect(calls.remember[0]?.framework).toBe("claude-code");
    expect(calls.remember[0]?.scope).toBe("project");
  });
});

describe("CodexAdapter", () => {
  it("uses MCP tool calls for remember and recall", async () => {
    const callTool = vi.fn<[ToolCallRequest], Promise<ToolCallResponse>>(
      async (request) => {
        if (request.name === "remember") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  memcell_id: "codex-memory",
                  status: "stored",
                }),
              },
            ],
          };
        }

        if (request.name === "recall") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  results: [],
                  scope_breakdown: { project: 1, agent: 0, global: 0 },
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "forgotten",
                memcell_id: "codex-memory",
              }),
            },
          ],
        };
      }
    );

    const adapter = new CodexAdapter(db, { callTool });

    const remembered = await adapter.remember({
      framework: "codex",
      type: "remember",
      content: "Codex CLI can use MCP natively.",
      sessionId: "codex-session",
      agentId: AGENT,
      userId: USER,
      projectId: PROJECT_ID,
    });

    const recalled = await adapter.recall({
      framework: "codex",
      type: "recall",
      sessionId: "codex-session",
      agentId: AGENT,
      userId: USER,
      query: "Codex",
      projectId: PROJECT_ID,
    });

    expect(remembered?.memcell_id).toBe("codex-memory");
    expect(recalled.scope_breakdown.project).toBe(1);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool.mock.calls[0]?.[0].name).toBe("remember");
    expect(callTool.mock.calls[1]?.[0].name).toBe("recall");
  });
});

describe("adapter fault isolation", () => {
  it("logs one adapter failure without blocking another adapter", async () => {
    const failingClient = createMockClient({
      remember: async () => {
        throw new Error("remember failed");
      },
    }).client;

    const openClaw = new OpenClawAdapter(db, failingClient);
    const hermes = new HermesAdapter(
      db,
      { defaultAgentId: AGENT, defaultUserId: USER },
      createMockClient().client
    );

    await openClaw.onEvent({
      framework: "openclaw",
      type: "session.started",
      sessionId: "faulty-session",
      agentId: AGENT,
      userId: USER,
    });

    const failed = await openClaw.onEvent({
      framework: "openclaw",
      type: "PostToolUse",
      sessionId: "faulty-session",
      toolName: "explode",
      input: {},
      output: {},
    });

    const stored = await hermes.store({
      content: "Healthy adapter still stores memories.",
      session_id: "healthy-session",
    });

    const errors = listAdapterErrors(db, "openclaw");

    expect(failed).toBeNull();
    expect(stored?.status).toBe("stored");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("remember failed");
  });
});
