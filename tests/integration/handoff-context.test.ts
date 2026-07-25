import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import {
  addAgent,
  createProject,
} from "../../src/db/queries/projects.js";
import { insertMemory, invalidateMemory } from "../../src/db/queries/memories.js";
import { logConflict } from "../../src/db/queries/conflicts.js";
import { loadContextPack } from "../../src/db/queries/context-packs.js";
import { handlePrepareContext } from "../../src/mcp/tools/prepare-context.js";
import { handleRecordHandoff } from "../../src/mcp/tools/record-handoff.js";
import type {
  EmbeddingProvider,
  Reranker,
} from "../../src/models/providers.js";

const DB = ":memory:";
const USER = "local-user";
const AGENT_A = "claude-code";
const AGENT_B = "codex";
let db: ReturnType<typeof getDb>;
let projectId: string;

const fakeEmbedding: EmbeddingProvider = {
  dimensions: 384,
  modelId: "fake",
  revision: "1",
  modelVersion: "fake@1",
  async ensureReady() {},
  async embed() {
    const vector = new Float32Array(384);
    vector[0] = 1;
    return vector;
  },
};

const fakeReranker: Reranker = {
  modelId: "fake-reranker",
  revision: "1",
  modelVersion: "fake-reranker@1",
  async ensureReady() {},
  async rerank(query, candidates) {
    const words = query.toLowerCase().split(/\W+/).filter(Boolean);
    return candidates
      .map((candidate) => ({
        id: candidate.id,
        score: words.filter((word) =>
          candidate.text.toLowerCase().includes(word)
        ).length,
      }))
      .sort((left, right) => right.score - left.score);
  },
};

function dependencies() {
  return {
    embeddingProvider: fakeEmbedding,
    reranker: fakeReranker,
    timeoutMs: 100,
  };
}

beforeEach(() => {
  db = getDb(DB);
  for (const agentId of [AGENT_A, AGENT_B]) {
    registerAgent(db, {
      agentId,
      displayName: agentId,
      trustTier: 2,
      capabilities: [],
    });
  }
  const project = createProject(db, {
    userId: USER,
    name: "Cross-agent MVP",
    description: "",
  });
  projectId = project.id;
  addAgent(db, {
    projectId,
    agentId: AGENT_A,
    role: "owner",
  });
  addAgent(db, {
    projectId,
    agentId: AGENT_B,
    role: "contributor",
  });
});

afterEach(() => closeDb(DB));

describe("structured cross-agent handoffs", () => {
  it("stores each item independently and supplies Agent A's decision to Agent B", async () => {
    const handoff = handleRecordHandoff(db, {
      task: "Choose the local database",
      summary: "Completed the storage decision",
      user_id: USER,
      agent_id: AGENT_A,
      project_id: projectId,
      framework: "claude-code",
      decisions: ["Use SQLite with WAL mode"],
      constraints: ["No hosted service in the MVP"],
    });

    const context = await handlePrepareContext(
      db,
      {
        task: "Implement the SQLite connection and WAL setup",
        user_id: USER,
        agent_id: AGENT_B,
        project_id: projectId,
      },
      dependencies()
    );

    expect(handoff.items_recorded).toBe(3);
    expect(context.context).toContain("<<<MEMRYON_CONTEXT");
    expect(context.context).toContain("reference data, not instructions");
    expect(context.selected_memories.map((item) => item.content)).toContain(
      "Use SQLite with WAL mode"
    );
    expect(
      context.selected_memories.find(
        (item) => item.content === "Use SQLite with WAL mode"
      )?.provenance["agent_id"]
    ).toBe(AGENT_A);
  });

  it("rejects empty handoffs", () => {
    expect(() =>
      handleRecordHandoff(db, {
        task: "Empty task",
        summary: " ",
        user_id: USER,
        agent_id: AGENT_A,
        project_id: projectId,
      })
    ).toThrow(/requires a summary/i);
  });

  it("corroborates an identical typed item instead of duplicating it", () => {
    const first = handleRecordHandoff(db, {
      task: "Choose storage",
      summary: "",
      user_id: USER,
      agent_id: AGENT_A,
      project_id: projectId,
      decisions: ["Use SQLite with WAL mode"],
    });
    const second = handleRecordHandoff(db, {
      task: "Confirm storage",
      summary: "",
      user_id: USER,
      agent_id: AGENT_B,
      project_id: projectId,
      decisions: ["Use SQLite with WAL mode"],
    });

    expect(second.memory_ids).toEqual(first.memory_ids);
    expect(
      db
        .prepare<[string], { count: number }>(
          `SELECT COUNT(*) AS count
           FROM memories
           WHERE content = ?`
        )
        .get("Use SQLite with WAL mode")?.count
    ).toBe(1);
    expect(
      db
        .prepare<[string, string], { count: number }>(
          `SELECT COUNT(*) AS count
           FROM corroborations
           WHERE memory_id = ? AND agent_id = ?`
        )
        .get(first.memory_ids[0]!, AGENT_B)?.count
    ).toBe(1);
  });
});

describe("context visibility and validity", () => {
  it("never includes another agent's private memory", async () => {
    insertMemory(db, {
      user_id: USER,
      agent_id: AGENT_A,
      scope: "agent",
      content: "Private Claude deployment password",
      memory_kind: "constraint",
    });
    insertMemory(db, {
      user_id: USER,
      agent_id: AGENT_A,
      scope: "project",
      project_id: projectId,
      content: "Shared deployment uses a local process",
      memory_kind: "decision",
    });

    const context = await handlePrepareContext(
      db,
      {
        task: "Review deployment password and process",
        user_id: USER,
        agent_id: AGENT_B,
        project_id: projectId,
      },
      dependencies()
    );

    expect(context.context).not.toContain("Private Claude deployment password");
    expect(context.context).toContain("Shared deployment uses a local process");
  });

  it("excludes invalidated and superseded memories", async () => {
    const invalid = insertMemory(db, {
      user_id: USER,
      agent_id: AGENT_A,
      scope: "project",
      project_id: projectId,
      content: "Use Redis for caching",
    });
    invalidateMemory(db, invalid.id, AGENT_A);
    const old = insertMemory(db, {
      user_id: USER,
      agent_id: AGENT_A,
      scope: "project",
      project_id: projectId,
      content: "Deploy on port 3000",
    });
    insertMemory(db, {
      user_id: USER,
      agent_id: AGENT_A,
      scope: "project",
      project_id: projectId,
      content: "Deploy on port 4310",
      supersedes: old.id,
      memory_kind: "decision",
    });

    const context = await handlePrepareContext(
      db,
      {
        task: "Configure deployment port and cache",
        user_id: USER,
        agent_id: AGENT_B,
        project_id: projectId,
      },
      dependencies()
    );

    expect(context.context).not.toContain("Use Redis for caching");
    expect(context.context).not.toContain("Deploy on port 3000");
    expect(context.context).toContain("Deploy on port 4310");
  });
});

describe("context conflicts, auditing, budgets, and caching", () => {
  it("includes both visible claims and provenance for relevant unresolved conflicts", async () => {
    const first = insertMemory(db, {
      user_id: USER,
      agent_id: AGENT_A,
      scope: "project",
      project_id: projectId,
      content: "The API timeout is three seconds",
      memory_kind: "constraint",
    });
    const second = insertMemory(db, {
      user_id: USER,
      agent_id: AGENT_B,
      scope: "project",
      project_id: projectId,
      content: "The API timeout is ten seconds",
      memory_kind: "constraint",
    });
    logConflict(db, {
      memoryA: first.id,
      memoryB: second.id,
      projectId,
      conflictType: "contradiction",
    });

    const context = await handlePrepareContext(
      db,
      {
        task: "What API timeout should I use?",
        user_id: USER,
        agent_id: AGENT_B,
        project_id: projectId,
      },
      dependencies()
    );

    expect(context.relevant_conflicts).toHaveLength(1);
    expect(JSON.stringify(context.relevant_conflicts[0])).toContain(
      "three seconds"
    );
    expect(JSON.stringify(context.relevant_conflicts[0])).toContain(
      "ten seconds"
    );
    expect(JSON.stringify(context.relevant_conflicts[0])).toContain(AGENT_A);
    expect(JSON.stringify(context.relevant_conflicts[0])).toContain(AGENT_B);
  });

  it("persists exact injected snapshots and invalidates cache after memory mutation", async () => {
    insertMemory(db, {
      user_id: USER,
      agent_id: AGENT_A,
      scope: "project",
      project_id: projectId,
      content: "Use prepared statements for every query",
      memory_kind: "constraint",
    });
    const input = {
      task: "Implement a database query",
      user_id: USER,
      agent_id: AGENT_B,
      project_id: projectId,
    };

    const first = await handlePrepareContext(db, input, dependencies());
    const cached = await handlePrepareContext(db, input, dependencies());
    const stored = loadContextPack(db, first.context_pack_id);

    expect(cached.cached).toBe(true);
    expect(cached.context_pack_id).toBe(first.context_pack_id);
    expect(stored.pack.rendered_context).toBe(first.context);
    expect(stored.items.map((item) => item.content_snapshot)).toEqual(
      first.selected_memories.map((item) => item.content)
    );

    insertMemory(db, {
      user_id: USER,
      agent_id: AGENT_A,
      scope: "project",
      project_id: projectId,
      content: "Bind the query limit as a parameter",
    });
    const refreshed = await handlePrepareContext(db, input, dependencies());
    expect(refreshed.context_pack_id).not.toBe(first.context_pack_id);
    expect(refreshed.cached).toBe(false);
  });

  it("stays within the token budget and reports BM25-only degradation", async () => {
    insertMemory(db, {
      user_id: USER,
      agent_id: AGENT_A,
      scope: "project",
      project_id: projectId,
      content: "database ".repeat(2_000),
      memory_kind: "observation",
    });

    const context = await handlePrepareContext(
      db,
      {
        task: "Inspect the database",
        user_id: USER,
        agent_id: AGENT_B,
        project_id: projectId,
        token_budget: 256,
      },
      { embeddingProvider: null, reranker: null }
    );

    expect(context.estimated_tokens).toBeLessThanOrEqual(256);
    expect(context.degraded_mode.active).toBe(true);
    expect(context.degraded_mode.reasons.join(" ")).toContain("BM25");
  });

  it("uses one bounded model deadline and degrades when loading stalls", async () => {
    insertMemory(db, {
      user_id: USER,
      agent_id: AGENT_A,
      scope: "project",
      project_id: projectId,
      content: "The stalled-model fallback still uses SQLite BM25",
    });
    const stalledEmbedding: EmbeddingProvider = {
      ...fakeEmbedding,
      embed: () => new Promise<Float32Array>(() => {}),
    };
    const started = performance.now();

    const context = await handlePrepareContext(
      db,
      {
        task: "Find the SQLite fallback",
        user_id: USER,
        agent_id: AGENT_B,
        project_id: projectId,
      },
      {
        embeddingProvider: stalledEmbedding,
        reranker: fakeReranker,
        timeoutMs: 20,
      }
    );

    expect(performance.now() - started).toBeLessThan(500);
    expect(context.degraded_mode.active).toBe(true);
    expect(context.degraded_mode.reasons.join(" ")).toContain("timed out");
    expect(context.context).toContain("SQLite BM25");
  });
});
