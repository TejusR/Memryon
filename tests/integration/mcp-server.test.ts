/**
 * Integration tests for the Memryon MCP server.
 *
 * Each test spins up a McpServer wired to an in-memory SQLite DB and a
 * connected Client over InMemoryTransport, then exercises tool calls
 * end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { logConflict } from "../../src/db/queries/conflicts.js";
import { insertMemory } from "../../src/db/queries/memories.js";
import { createMcpServer } from "../../src/mcp/server.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB = ":memory:";
const USER = "user-integration";
const AGENT_HI = "agent-hi-trust"; // trust_tier = 2
const AGENT_LO = "agent-lo-trust"; // trust_tier = 1

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function parseText(result: CallResult): Record<string, unknown> {
  const block = result.content.find((c) => c.type === "text");
  if (!block || block.type !== "text") throw new Error("No text block in result");
  return JSON.parse(block.text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let client: Client;

async function setup() {
  const db = getDb(DB);

  registerAgent(db, {
    agentId: AGENT_HI,
    displayName: "High-trust agent",
    trustTier: 2,
    capabilities: [],
  });
  registerAgent(db, {
    agentId: AGENT_LO,
    displayName: "Low-trust agent",
    trustTier: 1,
    capabilities: [],
  });

  const server = createMcpServer(db);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
}

beforeEach(setup);

afterEach(async () => {
  await client.close();
  closeDb(DB);
});

// ---------------------------------------------------------------------------
// 1. remember + recall round-trip
// ---------------------------------------------------------------------------

describe("remember + recall round-trip", () => {
  it("stores an agent-scoped memory and retrieves it via recall", async () => {
    const remResult = await client.callTool({
      name: "remember",
      arguments: {
        content: "The capital of France is Paris",
        agent_id: AGENT_HI,
        user_id: USER,
        scope: "agent",
      },
    });

    expect(remResult.isError).toBeFalsy();
    const remembered = parseText(remResult);
    expect(remembered.status).toBe("stored");
    expect(typeof remembered.memcell_id).toBe("string");

    const recResult = await client.callTool({
      name: "recall",
      arguments: {
        user_id: USER,
        agent_id: AGENT_HI,
        query: "capital France",
      },
    });

    expect(recResult.isError).toBeFalsy();
    const recalled = parseText(recResult);
    const results = recalled.results as Array<{ content: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toBe("The capital of France is Paris");
  });

  it("scope_breakdown reflects the correct tier counts", async () => {
    // Store two agent-scoped memories
    for (let i = 0; i < 2; i++) {
      await client.callTool({
        name: "remember",
        arguments: {
          content: `Agent memory ${i}`,
          agent_id: AGENT_HI,
          user_id: USER,
          scope: "agent",
        },
      });
    }

    const recResult = await client.callTool({
      name: "recall",
      arguments: { user_id: USER, agent_id: AGENT_HI },
    });

    const recalled = parseText(recResult);
    const breakdown = recalled.scope_breakdown as { project: number; agent: number; global: number };
    expect(breakdown.agent).toBe(2);
    expect(breakdown.project).toBe(0);
    expect(breakdown.global).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. remember with scope='project' when agent is not a member → error
// ---------------------------------------------------------------------------

describe("remember to project scope without membership", () => {
  it("returns an error result when the agent is not a project member", async () => {
    // Create a project as AGENT_HI so AGENT_LO is NOT a member
    const createResult = await client.callTool({
      name: "project_create",
      arguments: {
        name: "Exclusive Project",
        user_id: USER,
        agent_id: AGENT_HI,
      },
    });
    const created = parseText(createResult);
    const projectId = created.project_id as string;

    // AGENT_LO tries to write to this project
    const remResult = await client.callTool({
      name: "remember",
      arguments: {
        content: "Unauthorized write attempt",
        agent_id: AGENT_LO,
        user_id: USER,
        scope: "project",
        project_id: projectId,
      },
    });

    expect(remResult.isError).toBe(true);
    const err = parseText(remResult);
    expect(typeof err.error).toBe("string");
    expect((err.error as string).toLowerCase()).toMatch(/not a member/);
  });
});

// ---------------------------------------------------------------------------
// 3. promote agent→global with trust_tier=1 → error
// ---------------------------------------------------------------------------

describe("promote to global with insufficient trust tier", () => {
  it("returns an error when trust_tier < 2 tries to promote to global", async () => {
    // First store an agent-scoped memory as AGENT_LO (trust_tier=1)
    const remResult = await client.callTool({
      name: "remember",
      arguments: {
        content: "Low-trust agent memory",
        agent_id: AGENT_LO,
        user_id: USER,
        scope: "agent",
      },
    });
    const remembered = parseText(remResult);
    const memcellId = remembered.memcell_id as string;

    // Attempt promotion to global
    const promResult = await client.callTool({
      name: "promote",
      arguments: {
        memory_id: memcellId,
        agent_id: AGENT_LO,
        new_scope: "global",
      },
    });

    expect(promResult.isError).toBe(true);
    const err = parseText(promResult);
    expect(typeof err.error).toBe("string");
    expect((err.error as string).toLowerCase()).toMatch(/trust_tier/);
  });

  it("succeeds when trust_tier >= 2 promotes to global", async () => {
    const remResult = await client.callTool({
      name: "remember",
      arguments: {
        content: "High-trust agent memory",
        agent_id: AGENT_HI,
        user_id: USER,
        scope: "agent",
      },
    });
    const remembered = parseText(remResult);
    const memcellId = remembered.memcell_id as string;

    const promResult = await client.callTool({
      name: "promote",
      arguments: {
        memory_id: memcellId,
        agent_id: AGENT_HI,
        new_scope: "global",
      },
    });

    expect(promResult.isError).toBeFalsy();
    const promoted = parseText(promResult);
    expect(promoted.status).toBe("promoted");
    expect(promoted.new_scope).toBe("global");
  });
});

// ---------------------------------------------------------------------------
// 4. conflicts() returns detected contradictions
// ---------------------------------------------------------------------------

describe("conflicts tool", () => {
  it("returns previously logged conflicts", async () => {
    const db = getDb(DB);

    // Insert two memories directly so we have valid IDs to conflict.
    const memA = insertMemory(db, {
      user_id: USER,
      scope: "global",
      agent_id: AGENT_HI,
      content: "The sky is blue",
    });
    const memB = insertMemory(db, {
      user_id: USER,
      scope: "global",
      agent_id: AGENT_LO,
      content: "The sky is green",
    });

    // Log a conflict between them.
    logConflict(db, {
      memoryA: memA.id,
      memoryB: memB.id,
      conflictType: "cross_scope",
    });

    const result = await client.callTool({
      name: "conflicts",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const data = parseText(result);
    expect(data.count).toBe(1);
    const log = data.conflict_log as Array<{ memory_a: string; memory_b: string }>;
    expect(log[0]?.memory_a).toBe(memA.id);
    expect(log[0]?.memory_b).toBe(memB.id);
  });

  it("returns empty when no conflicts exist", async () => {
    const result = await client.callTool({
      name: "conflicts",
      arguments: {},
    });
    const data = parseText(result);
    expect(data.count).toBe(0);
    expect(data.conflict_log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. project_create + project_join + remember(scope='project') + recall
// ---------------------------------------------------------------------------

describe("full project collaboration flow", () => {
  it("project memories are visible after join and remember", async () => {
    // Step 1 — AGENT_HI creates a project
    const createResult = await client.callTool({
      name: "project_create",
      arguments: {
        name: "Shared Knowledge Base",
        description: "A collaborative project",
        user_id: USER,
        agent_id: AGENT_HI,
      },
    });
    expect(createResult.isError).toBeFalsy();
    const { project_id } = parseText(createResult) as { project_id: string };
    expect(typeof project_id).toBe("string");

    // Step 2 — AGENT_LO joins the project
    const joinResult = await client.callTool({
      name: "project_join",
      arguments: {
        project_id,
        agent_id: AGENT_LO,
        role: "contributor",
      },
    });
    expect(joinResult.isError).toBeFalsy();
    const joined = parseText(joinResult);
    expect(joined.status).toBe("joined");
    expect(joined.role).toBe("contributor");

    // Step 3 — AGENT_LO writes a project-scoped memory
    const remResult = await client.callTool({
      name: "remember",
      arguments: {
        content: "Our shared discovery: quantum entanglement is real",
        agent_id: AGENT_LO,
        user_id: USER,
        scope: "project",
        project_id,
      },
    });
    expect(remResult.isError).toBeFalsy();
    const remembered = parseText(remResult);
    expect(remembered.status).toBe("stored");

    // Step 4 — AGENT_HI recalls and sees the project memory
    const recResult = await client.callTool({
      name: "recall",
      arguments: {
        user_id: USER,
        agent_id: AGENT_HI,
        project_id,
        scope: "project",
      },
    });
    expect(recResult.isError).toBeFalsy();
    const recalled = parseText(recResult);
    const results = recalled.results as Array<{ content: string; scope: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.scope).toBe("project");
    expect(results[0]?.content).toContain("quantum entanglement");
  });

  it("project_context returns project metadata and memory count", async () => {
    // Create project and write a memory
    const createResult = await client.callTool({
      name: "project_create",
      arguments: {
        name: "Context Test Project",
        user_id: USER,
        agent_id: AGENT_HI,
      },
    });
    const { project_id } = parseText(createResult) as { project_id: string };

    await client.callTool({
      name: "remember",
      arguments: {
        content: "Context memory",
        agent_id: AGENT_HI,
        user_id: USER,
        scope: "project",
        project_id,
      },
    });

    const ctxResult = await client.callTool({
      name: "project_context",
      arguments: { project_id, user_id: USER },
    });
    expect(ctxResult.isError).toBeFalsy();
    const ctx = parseText(ctxResult);

    expect((ctx.project as { name: string }).name).toBe("Context Test Project");
    expect(ctx.memory_count).toBe(1);
    const agents = ctx.agents as Array<{ agent_id: string; role: string }>;
    expect(agents.some((a) => a.agent_id === AGENT_HI && a.role === "owner")).toBe(true);
    const activity = ctx.recent_activity as Array<{ content: string }>;
    expect(activity[0]?.content).toContain("Context memory");
  });
});

// ---------------------------------------------------------------------------
// 6. Supplementary: forget, corroborate
// ---------------------------------------------------------------------------

describe("forget tool", () => {
  it("soft-deletes a memory so recall no longer returns it", async () => {
    const remResult = await client.callTool({
      name: "remember",
      arguments: {
        content: "Temporary knowledge",
        agent_id: AGENT_HI,
        user_id: USER,
        scope: "agent",
      },
    });
    const { memcell_id } = parseText(remResult) as { memcell_id: string };

    const forgetResult = await client.callTool({
      name: "forget",
      arguments: { memcell_id, agent_id: AGENT_HI },
    });
    expect(forgetResult.isError).toBeFalsy();
    expect(parseText(forgetResult).status).toBe("forgotten");

    const recResult = await client.callTool({
      name: "recall",
      arguments: { user_id: USER, agent_id: AGENT_HI },
    });
    const recalled = parseText(recResult);
    const ids = (recalled.results as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(memcell_id);
  });
});

describe("corroborate tool", () => {
  it("increments the corroboration count for a memory", async () => {
    const remResult = await client.callTool({
      name: "remember",
      arguments: {
        content: "Well-known fact",
        agent_id: AGENT_HI,
        user_id: USER,
        scope: "global",
      },
    });
    const { memcell_id } = parseText(remResult) as { memcell_id: string };

    const corrResult = await client.callTool({
      name: "corroborate",
      arguments: { memory_id: memcell_id, agent_id: AGENT_LO },
    });
    expect(corrResult.isError).toBeFalsy();
    const corr = parseText(corrResult);
    expect(corr.status).toBe("corroborated");
    expect(corr.corroboration_count).toBe(1);
  });
});
