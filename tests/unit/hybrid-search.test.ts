import { describe, expect, it } from "vitest";
import {
  reciprocalRankFuse,
  type HybridSearchResult,
} from "../../src/retrieval/hybrid-search.js";
import type { ScoredMemoryRow } from "../../src/scope/fan-out.js";

function makeRow(
  id: string,
  scope: "agent" | "project" | "global",
  scopePriority: 1 | 2 | 3
): ScoredMemoryRow {
  return {
    id,
    user_id: "user-hybrid",
    scope,
    agent_id: "agent-hybrid",
    project_id: scope === "project" ? "project-hybrid" : null,
    content: `memory ${id}`,
    content_type: "text/plain",
    tags: "[]",
    valid_from: "2026-04-16T10:00:00.000Z",
    valid_until: null,
    recorded_at: `2026-04-16T10:00:0${scopePriority}.000Z`,
    invalidated_at: null,
    invalidated_by: null,
    embedding: null,
    embedding_model_version: null,
    confidence: 1,
    importance: 0.5,
    caused_by: null,
    supersedes: null,
    framework: null,
    session_id: null,
    source_type: "manual",
    scopePriority,
  };
}

describe("reciprocalRankFuse", () => {
  it("merges BM25, vector, and graph rankings with weighted RRF", () => {
    const rowA = makeRow("a", "project", 1);
    const rowB = makeRow("b", "agent", 2);
    const rowC = makeRow("c", "global", 3);

    const results = reciprocalRankFuse(
      new Map([
        [rowA.id, rowA],
        [rowB.id, rowB],
        [rowC.id, rowC],
      ]),
      {
        bm25: [rowA, rowB],
        vector: [rowB, rowA],
        graph: [rowC, rowA],
      }
    );

    expect(results.map((row) => row.id)).toEqual(["a", "b", "c"]);

    const byId = new Map(results.map((row) => [row.id, row] satisfies [string, HybridSearchResult]));
    const resultA = byId.get("a");
    const resultB = byId.get("b");
    const resultC = byId.get("c");

    expect(resultA?.source_breakdown.bm25).toBeGreaterThan(0);
    expect(resultA?.source_breakdown.vector).toBeGreaterThan(0);
    expect(resultA?.source_breakdown.graph).toBeGreaterThan(0);
    expect(resultB?.source_breakdown.bm25).toBeGreaterThan(0);
    expect(resultB?.source_breakdown.vector).toBeGreaterThan(0);
    expect(resultB?.source_breakdown.graph).toBe(0);
    expect(resultC?.source_breakdown.graph).toBeGreaterThan(0);
    expect(resultC?.source_breakdown.bm25).toBe(0);
    expect(resultA?.score).toBeGreaterThan(resultB?.score ?? 0);
    expect(resultB?.score).toBeGreaterThan(resultC?.score ?? 0);
  });
});
