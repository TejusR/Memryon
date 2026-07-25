import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { insertMemory } from "../../src/db/queries/memories.js";
import { addAgent, createProject } from "../../src/db/queries/projects.js";
import { handlePrepareContext } from "../../src/mcp/tools/prepare-context.js";
import type {
  EmbeddingProvider,
  Reranker,
} from "../../src/models/providers.js";

const DB = ":memory:";
const USER = "local-user";
const WRITER = "benchmark-writer";
const READER = "benchmark-reader";
let db: ReturnType<typeof getDb>;
let projectId: string;

const embedding: EmbeddingProvider = {
  dimensions: 384,
  modelId: "benchmark-embedding",
  revision: "fixture",
  modelVersion: "benchmark-embedding@fixture",
  async ensureReady() {},
  async embed() {
    const vector = new Float32Array(384);
    vector[0] = 1;
    return vector;
  },
};

const reranker: Reranker = {
  modelId: "benchmark-reranker",
  revision: "fixture",
  modelVersion: "benchmark-reranker@fixture",
  async ensureReady() {},
  async rerank(_query, candidates) {
    return candidates.map((candidate, index) => ({
      id: candidate.id,
      score: candidates.length - index,
    }));
  },
};

beforeEach(() => {
  db = getDb(DB);
  for (const agentId of [WRITER, READER]) {
    registerAgent(db, {
      agentId,
      displayName: agentId,
      trustTier: 2,
      capabilities: [],
    });
  }
  projectId = createProject(db, {
    userId: USER,
    name: "Context benchmark",
    description: "",
  }).id;
  for (const agentId of [WRITER, READER]) {
    addAgent(db, {
      projectId,
      agentId,
      role: "contributor",
    });
  }
});

afterEach(() => closeDb(DB));

describe("warm context performance", () => {
  it(
    "keeps warm task p95 below 1.5 seconds with 1,000 memories",
    async () => {
      for (let index = 0; index < 1_000; index += 1) {
        insertMemory(db, {
          user_id: USER,
          agent_id: WRITER,
          scope: "project",
          project_id: projectId,
          content: `Database decision ${index}: use prepared statement ${index}.`,
          memory_kind: index % 2 === 0 ? "decision" : "constraint",
        });
      }

      const baseInput = {
        task: "Find the database prepared statement decisions",
        user_id: USER,
        agent_id: READER,
        project_id: projectId,
      };
      await handlePrepareContext(db, baseInput, {
        embeddingProvider: embedding,
        reranker,
      });

      const durations: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const started = performance.now();
        const result = await handlePrepareContext(
          db,
          {
            ...baseInput,
            task: `${baseInput.task} variant ${index}`,
          },
          {
            embeddingProvider: embedding,
            reranker,
          }
        );
        durations.push(performance.now() - started);
        expect(result.cached).toBe(false);
      }
      durations.sort((left, right) => left - right);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;

      expect(p95).toBeLessThan(1_500);
    },
    15_000
  );
});
