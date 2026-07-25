import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodexPrompt } from "../../src/cli.js";
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
import { registerAgent } from "../../src/db/queries/agents.js";
import { addAgent, createProject } from "../../src/db/queries/projects.js";
import type { PrepareContextResult } from "../../src/mcp/tools/prepare-context.js";

const DB = ":memory:";
const USER = "local-user";
const CONTEXT =
  '<<<MEMRYON_CONTEXT id="pack-contract">>>\n| Use SQLite.\n<<<END_MEMRYON_CONTEXT>>>';
let db: ReturnType<typeof getDb>;
let projectId: string;

function contextResult(): PrepareContextResult {
  return {
    context_pack_id: "pack-contract",
    context: CONTEXT,
    selected_memories: [],
    relevant_conflicts: [],
    estimated_tokens: 24,
    retrieval_latency_ms: 5,
    degraded_mode: { active: false, reasons: [] },
    cached: false,
  };
}

function client(): MemoryToolClient {
  return {
    remember: vi.fn(async () => ({ memcell_id: "memory-1", status: "stored" })),
    recall: vi.fn(async () => ({
      results: [],
      scope_breakdown: { project: 0, agent: 0, global: 0 },
    })),
    forget: vi.fn(async (args) => ({
      status: "forgotten",
      memcell_id: args.memcell_id,
    })),
    prepareContext: vi.fn(async () => contextResult()),
    recordHandoff: vi.fn(async () => ({
      handoff_id: "handoff-1",
      memory_ids: ["memory-1"],
      conflict_ids: [],
      items_recorded: 1,
      status: "recorded",
    })),
  };
}

beforeEach(() => {
  db = getDb(DB);
  for (const agentId of ["claude-code", "codex", "openclaw", "hermes"]) {
    registerAgent(db, {
      agentId,
      displayName: agentId,
      trustTier: 2,
      capabilities: [],
    });
  }
  projectId = createProject(db, {
    userId: USER,
    name: "Adapter contracts",
    description: "",
  }).id;
  for (const agentId of ["claude-code", "codex", "openclaw", "hermes"]) {
    addAgent(db, {
      projectId,
      agentId,
      role: "contributor",
    });
  }
});

afterEach(() => {
  closeDb(DB);
  vi.restoreAllMocks();
});

describe("Claude Code hook contract", () => {
  it("injects additionalContext, ignores raw tools by default, and blocks Stop once", async () => {
    const memoryClient = client();
    const adapter = new ClaudeCodeAdapter(db, {}, memoryClient);

    const promptResult = await adapter.onEvent({
      framework: "claude-code",
      type: "UserPromptSubmit",
      sessionId: "claude-contract",
      agentId: "claude-code",
      userId: USER,
      projectId,
      prompt: "Implement the database adapter",
    });
    const captured = await adapter.onEvent({
      framework: "claude-code",
      type: "PostToolUse",
      sessionId: "claude-contract",
      toolName: "read_file",
      input: { path: "src/db/connection.ts" },
      output: { bytes: 100 },
    });
    const firstStop = await adapter.onEvent({
      framework: "claude-code",
      type: "Stop",
      sessionId: "claude-contract",
    });
    const secondStop = await adapter.onEvent({
      framework: "claude-code",
      type: "Stop",
      sessionId: "claude-contract",
    });

    expect(promptResult).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: CONTEXT,
      },
    });
    expect(captured).toMatchObject({ status: "ignored" });
    expect(memoryClient.remember).not.toHaveBeenCalled();
    expect(firstStop).toMatchObject({ decision: "block" });
    expect(secondStop).toEqual({ status: "continue" });
  });
});

describe("OpenClaw lifecycle contract", () => {
  it("prepends task context and requests one bounded handoff revision", async () => {
    const memoryClient = client();
    const adapter = new OpenClawAdapter(db, memoryClient);

    const prepared = await adapter.onEvent({
      framework: "openclaw",
      type: "agent_turn_prepare",
      sessionId: "openclaw-contract",
      agentId: "openclaw",
      userId: USER,
      projectId,
      prompt: "Finish the shared SQLite implementation",
    });
    await adapter.onEvent({
      framework: "openclaw",
      type: "PostToolUse",
      sessionId: "openclaw-contract",
      toolName: "run_tests",
      input: {},
      output: { passed: true },
    });
    const firstFinalize = await adapter.onEvent({
      framework: "openclaw",
      type: "before_agent_finalize",
      sessionId: "openclaw-contract",
      response: "Completed the implementation.",
    });
    const secondFinalize = await adapter.onEvent({
      framework: "openclaw",
      type: "before_agent_finalize",
      sessionId: "openclaw-contract",
      response: "Completed the implementation.",
    });

    expect(prepared).toEqual({ prependContext: CONTEXT });
    expect(
      await adapter.onEvent({
        framework: "openclaw",
        type: "PostToolUse",
        sessionId: "openclaw-contract",
        toolName: "run_tests",
        input: {},
        output: { passed: true },
      })
    ).toMatchObject({ status: "ignored" });
    expect(memoryClient.remember).not.toHaveBeenCalled();
    expect(firstFinalize).toMatchObject({
      action: "revise",
      retry: { maxAttempts: 1 },
    });
    expect(secondFinalize).toEqual({ action: "finalize" });
  });
});

describe("Codex and Hermes compatibility contracts", () => {
  it("passes Codex context and handoffs through MCP and augments launcher tasks", async () => {
    const callTool = vi.fn<
      [ToolCallRequest],
      Promise<ToolCallResponse>
    >(async (request) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            request.name === "prepare_context"
              ? contextResult()
              : {
                  handoff_id: "handoff-1",
                  memory_ids: ["memory-1"],
                  conflict_ids: [],
                  items_recorded: 1,
                  status: "recorded",
                }
          ),
        },
      ],
    }));
    const adapter = new CodexAdapter(db, { callTool });

    await adapter.onEvent({
      framework: "codex",
      type: "prepare_context",
      task: "Implement the next step",
      sessionId: "codex-contract",
      agentId: "codex",
      userId: USER,
      projectId,
    });
    await adapter.onEvent({
      framework: "codex",
      type: "record_handoff",
      task: "Implement the next step",
      summary: "Finished",
      sessionId: "codex-contract",
      agentId: "codex",
      userId: USER,
      projectId,
      decisions: ["Use SQLite"],
    });

    expect(callTool.mock.calls.map(([request]) => request.name)).toEqual([
      "prepare_context",
      "record_handoff",
    ]);
    expect(buildCodexPrompt(CONTEXT, "Implement the next step")).toBe(
      `${CONTEXT}\n\nUSER_TASK:\nImplement the next step`
    );
  });

  it("exposes task-aware retrieval and structured handoffs through Hermes", async () => {
    const memoryClient = client();
    const adapter = new HermesAdapter(
      db,
      { defaultAgentId: "hermes", defaultUserId: USER },
      memoryClient
    );

    const context = await adapter.prepareContext({
      query: "Resume the database task",
      project_id: projectId,
      session_id: "hermes-contract",
    });
    const handoff = await adapter.recordHandoff({
      task: "Resume the database task",
      summary: "Done",
      user_id: USER,
      agent_id: "hermes",
      project_id: projectId,
      session_id: "hermes-contract",
    });

    expect(context?.context).toBe(CONTEXT);
    expect(handoff?.status).toBe("recorded");
    expect(memoryClient.prepareContext).toHaveBeenCalledOnce();
    expect(memoryClient.recordHandoff).toHaveBeenCalledOnce();
  });
});
