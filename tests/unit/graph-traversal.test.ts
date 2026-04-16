import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { insertMemory } from "../../src/db/queries/memories.js";
import { traverseGraphs } from "../../src/retrieval/graph-traversal.js";

const DB = ":memory:";
const USER = "user-graph";
const AGENT = "agent-graph";

let db: ReturnType<typeof getDb>;

beforeEach(() => {
  db = getDb(DB);
  registerAgent(db, {
    agentId: AGENT,
    displayName: "Graph Agent",
    trustTier: 2,
    capabilities: [],
  });
});

afterEach(() => {
  closeDb(DB);
});

describe("traverseGraphs", () => {
  it("respects causal and temporal hop limits", () => {
    const root = insertMemory(db, {
      user_id: USER,
      scope: "global",
      agent_id: AGENT,
      content: "We were hitting write contention in Postgres",
      valid_from: "2026-04-10T08:00:00.000Z",
    });
    const firstHop = insertMemory(db, {
      user_id: USER,
      scope: "global",
      agent_id: AGENT,
      content: "That contention led us to evaluate SQLite",
      caused_by: root.id,
      valid_from: "2026-04-11T08:00:00.000Z",
    });
    const secondHop = insertMemory(db, {
      user_id: USER,
      scope: "global",
      agent_id: AGENT,
      content: "The SQLite evaluation turned into a migration plan",
      caused_by: firstHop.id,
      valid_from: "2026-04-12T08:00:00.000Z",
    });
    const thirdHop = insertMemory(db, {
      user_id: USER,
      scope: "global",
      agent_id: AGENT,
      content: "The migration plan shipped the next day",
      caused_by: secondHop.id,
      valid_from: "2026-04-13T08:00:00.000Z",
    });

    const causalResults = traverseGraphs(
      db,
      root.id,
      { causal: 1, temporal: 0, entity: 0, semantic: 0 },
      5
    );
    const causalIds = causalResults.map((row) => row.id);

    expect(causalIds).toContain(firstHop.id);
    expect(causalIds).toContain(secondHop.id);
    expect(causalIds).not.toContain(thirdHop.id);

    const temporalResults = traverseGraphs(
      db,
      firstHop.id,
      { causal: 0, temporal: 1, entity: 0, semantic: 0 },
      5
    );
    const temporalIds = temporalResults.map((row) => row.id);

    expect(temporalIds).toContain(root.id);
    expect(temporalIds).toContain(secondHop.id);
    expect(temporalIds).not.toContain(thirdHop.id);
  });

  it("terminates when the candidate set reaches the 50-node cap", () => {
    const seed = insertMemory(db, {
      user_id: USER,
      scope: "global",
      agent_id: AGENT,
      content: "SQLite migration vector seed",
    });

    for (let i = 0; i < 60; i++) {
      insertMemory(db, {
        user_id: USER,
        scope: "global",
        agent_id: AGENT,
        content: `SQLite migration vector seed related ${i}`,
      });
    }

    const results = traverseGraphs(
      db,
      seed.id,
      { causal: 0, temporal: 0, entity: 0, semantic: 1 },
      2
    );

    expect(results).toHaveLength(50);
  });
});
