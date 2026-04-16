import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import {
  getAgent,
  getAgentTrustTier,
  registerAgent,
} from "../../src/db/queries/agents.js";

const DB = ":memory:";
let db: ReturnType<typeof getDb>;

beforeEach(() => {
  db = getDb(DB);
});

afterEach(() => {
  closeDb(DB);
});

// ---------------------------------------------------------------------------
// registerAgent
// ---------------------------------------------------------------------------

describe("registerAgent", () => {
  it("creates a new agent row", () => {
    const agent = registerAgent(db, {
      agentId: "claude-1",
      displayName: "Claude Code",
      trustTier: 2,
      capabilities: ["remember", "recall"],
    });
    expect(agent.agent_id).toBe("claude-1");
    expect(agent.display_name).toBe("Claude Code");
    expect(agent.trust_tier).toBe(2);
    expect(JSON.parse(agent.capabilities)).toEqual(["remember", "recall"]);
  });

  it("upserts on duplicate agentId, updating fields", () => {
    registerAgent(db, { agentId: "a1", displayName: "Old Name", trustTier: 1, capabilities: [] });
    const updated = registerAgent(db, {
      agentId: "a1",
      displayName: "New Name",
      trustTier: 3,
      capabilities: ["search"],
    });
    expect(updated.display_name).toBe("New Name");
    expect(updated.trust_tier).toBe(3);
    expect(JSON.parse(updated.capabilities)).toEqual(["search"]);
  });

  it("rejects an invalid trust_tier via Zod", () => {
    expect(() =>
      registerAgent(db, {
        agentId: "bad",
        displayName: "Bad",
        // @ts-expect-error intentional bad input
        trustTier: 5,
        capabilities: [],
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getAgent
// ---------------------------------------------------------------------------

describe("getAgent", () => {
  it("returns the agent row", () => {
    registerAgent(db, { agentId: "a1", displayName: "A", trustTier: 1, capabilities: [] });
    const agent = getAgent(db, "a1");
    expect(agent?.agent_id).toBe("a1");
  });

  it("returns undefined for unknown agentId", () => {
    expect(getAgent(db, "ghost")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getAgentTrustTier
// ---------------------------------------------------------------------------

describe("getAgentTrustTier", () => {
  it("returns the trust tier", () => {
    registerAgent(db, { agentId: "a1", displayName: "A", trustTier: 3, capabilities: [] });
    expect(getAgentTrustTier(db, "a1")).toBe(3);
  });

  it("throws for an unknown agentId", () => {
    expect(() => getAgentTrustTier(db, "ghost")).toThrow(/not found/);
  });
});
