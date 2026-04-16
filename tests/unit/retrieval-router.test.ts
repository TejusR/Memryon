import { describe, expect, it } from "vitest";
import { classifyIntent } from "../../src/retrieval/router.js";

describe("classifyIntent", () => {
  it("makes causal intent dominant for why-questions", () => {
    const weights = classifyIntent("why did we switch to SQLite");

    expect(weights.causal).toBeGreaterThan(weights.temporal);
    expect(weights.causal).toBeGreaterThan(weights.entity);
    expect(weights.causal).toBeGreaterThan(weights.semantic);
    expect(
      weights.causal + weights.temporal + weights.entity + weights.semantic
    ).toBeCloseTo(1, 8);
  });

  it("makes temporal intent dominant for time-oriented questions", () => {
    const weights = classifyIntent("what happened last Tuesday");

    expect(weights.temporal).toBeGreaterThan(weights.causal);
    expect(weights.temporal).toBeGreaterThan(weights.entity);
    expect(weights.temporal).toBeGreaterThan(weights.semantic);
    expect(
      weights.causal + weights.temporal + weights.entity + weights.semantic
    ).toBeCloseTo(1, 8);
  });
});
