import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { runStalenessSweep } from "../../src/utils/staleness.js";

const DB = ":memory:";
const USER = "user-stale";
const AGENT = "agent-stale";
const AGENT_2 = "agent-stale-2";

let db: ReturnType<typeof getDb>;

function seedAgent(id = AGENT, tier: 1 | 2 | 3 = 2) {
  registerAgent(db, { agentId: id, displayName: id, trustTier: tier, capabilities: [] });
}

/**
 * Bypass insertMemory so we can control valid_from and recorded_at precisely.
 */
function insertMemoryWithAge(
  opts: {
    id?: string;
    daysAgo: number;
    content?: string;
    causedBy?: string;
  }
): string {
  const id = opts.id ?? `mem-${Math.random().toString(36).slice(2)}`;
  const ts = new Date(Date.now() - opts.daysAgo * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO memories
       (id, user_id, scope, agent_id, content, content_type, tags,
        valid_from, recorded_at, confidence, importance, source_type, caused_by)
     VALUES (?, ?, 'global', ?, ?, 'text/plain', '[]', ?, ?, 1.0, 0.5, 'manual', ?)`
  ).run(id, USER, AGENT, opts.content ?? "old memory", ts, ts, opts.causedBy ?? null);

  return id;
}

function addCorroboration(memoryId: string, daysAgo = 0) {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO corroborations (memory_id, agent_id, corroborated_at) VALUES (?, ?, ?)`
  ).run(memoryId, AGENT_2, ts);
}

function getTags(id: string): string[] {
  const row = db.prepare<[string], { tags: string }>(`SELECT tags FROM memories WHERE id = ?`).get(id);
  return JSON.parse(row?.tags ?? "[]");
}

beforeEach(() => {
  db = getDb(DB);
  seedAgent(AGENT);
  seedAgent(AGENT_2, 1);
});

afterEach(() => {
  closeDb(DB);
});

// ---------------------------------------------------------------------------
// Core staleness criteria
// ---------------------------------------------------------------------------

describe("runStalenessSweep", () => {
  it("flags a memory older than staleDays with no corroboration", () => {
    const id = insertMemoryWithAge({ daysAgo: 40 });
    const result = runStalenessSweep(db, { staleDays: 30, corroborationWindowDays: 7 });

    expect(result.stale_count).toBe(1);
    expect(result.memories).toContain(id);
    expect(getTags(id)).toContain("stale");
  });

  it("does NOT flag a memory older than staleDays that has a recent corroboration", () => {
    const id = insertMemoryWithAge({ daysAgo: 40 });
    addCorroboration(id, 0); // corroborated today

    const result = runStalenessSweep(db, { staleDays: 30, corroborationWindowDays: 7 });

    expect(result.memories).not.toContain(id);
    expect(getTags(id)).not.toContain("stale");
  });

  it("flags a memory with only an old corroboration (outside window)", () => {
    const id = insertMemoryWithAge({ daysAgo: 40 });
    addCorroboration(id, 10); // corroborated 10 days ago, outside 7-day window

    const result = runStalenessSweep(db, { staleDays: 30, corroborationWindowDays: 7 });

    expect(result.memories).toContain(id);
    expect(getTags(id)).toContain("stale");
  });

  it("does NOT flag a recently created memory regardless of corroboration", () => {
    const id = insertMemoryWithAge({ daysAgo: 5 }); // well within staleDays=30

    const result = runStalenessSweep(db, { staleDays: 30, corroborationWindowDays: 7 });

    expect(result.memories).not.toContain(id);
    expect(getTags(id)).not.toContain("stale");
  });

  it("does NOT flag a memory whose caused_by was recorded recently", () => {
    const causingId = insertMemoryWithAge({ daysAgo: 2, content: "recent cause" });
    const id = insertMemoryWithAge({ daysAgo: 40, content: "effect", causedBy: causingId });

    const result = runStalenessSweep(db, { staleDays: 30, corroborationWindowDays: 7 });

    expect(result.memories).not.toContain(id);
  });

  it("flags a memory whose caused_by was recorded outside the corroboration window", () => {
    const causingId = insertMemoryWithAge({ daysAgo: 15, content: "old cause" });
    const id = insertMemoryWithAge({ daysAgo: 40, content: "effect", causedBy: causingId });

    const result = runStalenessSweep(db, { staleDays: 30, corroborationWindowDays: 7 });

    expect(result.memories).toContain(id);
  });

  it("does not flag invalidated memories", () => {
    const id = insertMemoryWithAge({ daysAgo: 40 });
    db.prepare(`UPDATE memories SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(id);

    const result = runStalenessSweep(db, { staleDays: 30, corroborationWindowDays: 7 });

    expect(result.memories).not.toContain(id);
  });

  it("does not flag memories with valid_until set", () => {
    const id = insertMemoryWithAge({ daysAgo: 40 });
    db.prepare(`UPDATE memories SET valid_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(id);

    const result = runStalenessSweep(db, { staleDays: 30, corroborationWindowDays: 7 });

    expect(result.memories).not.toContain(id);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("staleness idempotency", () => {
  it("running the sweep twice does not duplicate the stale tag", () => {
    const id = insertMemoryWithAge({ daysAgo: 40 });

    runStalenessSweep(db, { staleDays: 30 });
    runStalenessSweep(db, { staleDays: 30 });

    const tags = getTags(id);
    const staleCount = tags.filter((t) => t === "stale").length;
    expect(staleCount).toBe(1);
  });

  it("returns 0 stale when no memories qualify", () => {
    insertMemoryWithAge({ daysAgo: 5 });
    const result = runStalenessSweep(db, { staleDays: 30 });
    expect(result.stale_count).toBe(0);
    expect(result.memories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-memory scenarios
// ---------------------------------------------------------------------------

describe("staleness multi-memory", () => {
  it("flags multiple stale memories and returns all their ids", () => {
    const id1 = insertMemoryWithAge({ daysAgo: 35, content: "stale one" });
    const id2 = insertMemoryWithAge({ daysAgo: 50, content: "stale two" });
    const id3 = insertMemoryWithAge({ daysAgo: 5, content: "fresh" });

    const result = runStalenessSweep(db, { staleDays: 30 });

    expect(result.stale_count).toBe(2);
    expect(result.memories).toContain(id1);
    expect(result.memories).toContain(id2);
    expect(result.memories).not.toContain(id3);
  });
});
