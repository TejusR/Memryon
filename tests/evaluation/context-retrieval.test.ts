import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import fixture from "../fixtures/handoff-evaluation.json";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { logConflict } from "../../src/db/queries/conflicts.js";
import {
  getMemoryById,
  insertMemory,
  invalidateMemory,
} from "../../src/db/queries/memories.js";
import { addAgent, createProject } from "../../src/db/queries/projects.js";
import { handlePrepareContext } from "../../src/mcp/tools/prepare-context.js";
import type { Reranker } from "../../src/models/providers.js";

const DB = ":memory:";
const USER = "local-user";
let db: ReturnType<typeof getDb>;
let projectId: string;

const lexicalReranker: Reranker = {
  modelId: "evaluation-reranker",
  revision: "fixture",
  modelVersion: "evaluation-reranker@fixture",
  async ensureReady() {},
  async rerank(query, candidates) {
    const terms = new Set(
      query
        .toLowerCase()
        .split(/\W+/)
        .filter((term) => term.length >= 4)
    );
    return candidates
      .map((candidate) => ({
        id: candidate.id,
        score: candidate.text
          .toLowerCase()
          .split(/\W+/)
          .filter((term) => terms.has(term)).length,
      }))
      .sort((left, right) => right.score - left.score);
  },
};

beforeEach(() => {
  db = getDb(DB);
  for (const agentId of [
    fixture.writing_agent,
    fixture.requesting_agent,
  ]) {
    registerAgent(db, {
      agentId,
      displayName: agentId,
      trustTier: 2,
      capabilities: [],
    });
  }
  projectId = createProject(db, {
    userId: USER,
    name: "Handoff evaluation",
    description: "",
  }).id;
  for (const agentId of [
    fixture.writing_agent,
    fixture.requesting_agent,
  ]) {
    addAgent(db, {
      projectId,
      agentId,
      role: "contributor",
    });
  }
});

afterEach(() => closeDb(DB));

describe("handoff retrieval evaluation", () => {
  it("tracks Recall@12, irrelevant-item rate, and stale/private leakage", async () => {
    const ids = new Map<string, string>();

    for (const entry of fixture.memories) {
      const supersededId =
        "superseded_by" in entry
          ? undefined
          : [...fixture.memories].find(
              (candidate) =>
                "superseded_by" in candidate &&
                candidate.superseded_by === entry.key
            );
      const supersedes =
        supersededId === undefined
          ? undefined
          : ids.get(supersededId.key);
      const memory = insertMemory(db, {
        user_id: USER,
        agent_id: fixture.writing_agent,
        scope: entry.scope,
        ...(entry.scope === "project" ? { project_id: projectId } : {}),
        content: entry.content,
        memory_kind: entry.kind,
        ...(supersedes !== undefined ? { supersedes } : {}),
      });
      ids.set(entry.key, memory.id);
      if ("invalidated" in entry && entry.invalidated) {
        invalidateMemory(db, memory.id, fixture.writing_agent);
      }
    }

    const conflictGroups = new Map<string, string[]>();
    for (const entry of fixture.memories) {
      if (!("conflict" in entry)) {
        continue;
      }
      const group = conflictGroups.get(entry.conflict) ?? [];
      group.push(ids.get(entry.key)!);
      conflictGroups.set(entry.conflict, group);
    }
    for (const memoryIds of conflictGroups.values()) {
      if (memoryIds.length === 2) {
        logConflict(db, {
          memoryA: memoryIds[0]!,
          memoryB: memoryIds[1]!,
          projectId,
          conflictType: "contradiction",
        });
      }
    }

    const result = await handlePrepareContext(
      db,
      {
        task: fixture.task,
        user_id: USER,
        agent_id: fixture.requesting_agent,
        project_id: projectId,
        top_k: 12,
      },
      { embeddingProvider: null, reranker: lexicalReranker }
    );

    const selectedIds = new Set(
      result.selected_memories.map((memory) => memory.memory_id)
    );
    const relevantIds = fixture.memories
      .filter((entry) => entry.relevant)
      .map((entry) => ids.get(entry.key)!);
    const irrelevantIds = fixture.memories
      .filter(
        (entry) =>
          !entry.relevant &&
          !("invalidated" in entry) &&
          !("private_writer" in entry) &&
          !("superseded_by" in entry)
      )
      .map((entry) => ids.get(entry.key)!);
    const recallAt12 =
      relevantIds.filter((id) => selectedIds.has(id)).length /
      relevantIds.length;
    const irrelevantRate =
      result.selected_memories.filter((memory) =>
        irrelevantIds.includes(memory.memory_id)
      ).length / Math.max(1, result.selected_memories.length);
    const staleId = ids.get("stale-retry")!;
    const privateId = ids.get("private-secret")!;
    const supersededId = ids.get("old-port")!;
    const leakage = [staleId, privateId, supersededId].filter((id) =>
      selectedIds.has(id)
    );

    expect(recallAt12).toBe(1);
    expect(irrelevantRate).toBeLessThanOrEqual(0.5);
    expect(leakage).toEqual([]);
    expect(result.relevant_conflicts).toHaveLength(1);
    expect(getMemoryById(db, privateId)?.scope).toBe("agent");
  });
});
