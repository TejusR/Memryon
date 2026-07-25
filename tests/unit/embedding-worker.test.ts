import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { getEmbeddingJob } from "../../src/db/queries/embedding-jobs.js";
import { insertMemory } from "../../src/db/queries/memories.js";
import { addAgent, createProject } from "../../src/db/queries/projects.js";
import { processEmbeddingJobs } from "../../src/ingestion/embedding-worker.js";
import type { EmbeddingProvider } from "../../src/models/providers.js";
import { searchMemoryVectors } from "../../src/retrieval/vector-index.js";
import { collectVisibleMemories } from "../../src/scope/fan-out.js";

const DB = ":memory:";
let db: ReturnType<typeof getDb>;

const fakeProvider: EmbeddingProvider = {
  dimensions: 384,
  modelId: "fake-embedding",
  revision: "test",
  modelVersion: "fake-embedding@test",
  async ensureReady() {},
  async embed(text) {
    const vector = new Float32Array(384);
    vector[0] = text.length;
    vector[1] = 1;
    return vector;
  },
};

beforeEach(() => {
  db = getDb(DB);
  registerAgent(db, {
    agentId: "worker-agent",
    displayName: "Worker",
    trustTier: 2,
    capabilities: [],
  });
});

afterEach(() => closeDb(DB));

describe("embedding worker", () => {
  it("claims, embeds, indexes, and completes durable write jobs", async () => {
    const memory = insertMemory(db, {
      user_id: "local-user",
      agent_id: "worker-agent",
      scope: "global",
      content: "Index this decision",
    });

    const result = await processEmbeddingJobs(db, fakeProvider);

    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(getEmbeddingJob(db, memory.id)?.status).toBe("COMPLETED");
    expect(
      db
        .prepare<[string], { embedding_model_version: string }>(
          `SELECT embedding_model_version FROM memories WHERE id = ?`
        )
        .get(memory.id)?.embedding_model_version
    ).toBe(fakeProvider.modelVersion);
    expect(
      db
        .prepare<[], { count: number }>(
          `SELECT COUNT(*) AS count FROM memory_vectors`
        )
        .get()?.count
    ).toBe(1);
  });

  it("records provider failures without aborting the worker", async () => {
    const memory = insertMemory(db, {
      user_id: "local-user",
      agent_id: "worker-agent",
      scope: "global",
      content: "This model call fails",
    });
    const failing: EmbeddingProvider = {
      ...fakeProvider,
      async embed() {
        throw new Error("offline");
      },
    };

    const result = await processEmbeddingJobs(db, failing);

    expect(result.failed).toBe(1);
    expect(getEmbeddingJob(db, memory.id)?.status).toBe("FAILED");
    expect(getEmbeddingJob(db, memory.id)?.last_error).toContain("offline");
  });

  it("filters vector candidates to the requesting agent's visible rows", async () => {
    registerAgent(db, {
      agentId: "requesting-agent",
      displayName: "Requester",
      trustTier: 2,
      capabilities: [],
    });
    const project = createProject(db, {
      userId: "local-user",
      name: "Vector visibility",
      description: "",
    });
    addAgent(db, {
      projectId: project.id,
      agentId: "worker-agent",
      role: "owner",
    });
    addAgent(db, {
      projectId: project.id,
      agentId: "requesting-agent",
      role: "contributor",
    });
    const shared = insertMemory(db, {
      user_id: "local-user",
      agent_id: "worker-agent",
      scope: "project",
      project_id: project.id,
      content: "Shared indexed context",
    });
    const privateMemory = insertMemory(db, {
      user_id: "local-user",
      agent_id: "worker-agent",
      scope: "agent",
      content: "Private indexed context is much closer",
    });
    await processEmbeddingJobs(db, fakeProvider);

    const visible = collectVisibleMemories(db, {
      userId: "local-user",
      agentId: "requesting-agent",
      projectId: project.id,
    });
    const matches = searchMemoryVectors(
      db,
      await fakeProvider.embed(privateMemory.content),
      visible,
      5
    );

    expect(matches.map((match) => match.row.id)).toEqual([shared.id]);
    expect(visible.map((memory) => memory.id)).not.toContain(privateMemory.id);
  });
});
