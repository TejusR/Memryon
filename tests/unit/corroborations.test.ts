import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { insertMemory } from "../../src/db/queries/memories.js";
import {
  corroborate,
  getCorroborationCount,
  getStaleMemories,
} from "../../src/db/queries/corroborations.js";

const DB = ":memory:";
const USER = "user-1";
const AGENT = "agent-corr";
const AGENT_2 = "agent-corr-2";

let db: ReturnType<typeof getDb>;

function seedAgent(id = AGENT, tier: 1 | 2 | 3 = 2) {
  registerAgent(db, { agentId: id, displayName: id, trustTier: tier, capabilities: [] });
}

function seedMemory(content = "test content") {
  return insertMemory(db, {
    user_id: USER,
    scope: "global",
    agent_id: AGENT,
    content,
  });
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
// corroborate
// ---------------------------------------------------------------------------

describe("corroborate", () => {
  it("creates a corroboration row", () => {
    const mem = seedMemory();
    const row = corroborate(db, mem.id, AGENT_2);
    expect(row.memory_id).toBe(mem.id);
    expect(row.agent_id).toBe(AGENT_2);
    expect(row.corroborated_at).toBeTruthy();
  });

  it("is idempotent — second call does not throw", () => {
    const mem = seedMemory();
    corroborate(db, mem.id, AGENT_2);
    expect(() => corroborate(db, mem.id, AGENT_2)).not.toThrow();
  });

  it("updates corroborated_at on the second call", () => {
    const mem = seedMemory();

    // Insert a corroboration with a timestamp anchored in the past.
    db.prepare(
      `INSERT INTO corroborations (memory_id, agent_id, corroborated_at)
       VALUES (?, ?, ?)`
    ).run(mem.id, AGENT_2, "2000-01-01T00:00:00.000Z");

    const before = db
      .prepare<[string, string], { corroborated_at: string }>(
        `SELECT corroborated_at FROM corroborations WHERE memory_id = ? AND agent_id = ?`
      )
      .get(mem.id, AGENT_2)!.corroborated_at;

    const row = corroborate(db, mem.id, AGENT_2);

    expect(row.corroborated_at).not.toBe(before);
    expect(row.corroborated_at > before).toBe(true);
  });

  it("allows multiple different agents to corroborate the same memory", () => {
    const mem = seedMemory();
    corroborate(db, mem.id, AGENT);
    corroborate(db, mem.id, AGENT_2);
    expect(getCorroborationCount(db, mem.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getCorroborationCount
// ---------------------------------------------------------------------------

describe("getCorroborationCount", () => {
  it("returns 0 for a memory with no corroborations", () => {
    const mem = seedMemory();
    expect(getCorroborationCount(db, mem.id)).toBe(0);
  });

  it("counts correctly after corroborations", () => {
    const mem = seedMemory();
    corroborate(db, mem.id, AGENT);
    corroborate(db, mem.id, AGENT_2);
    expect(getCorroborationCount(db, mem.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getStaleMemories
// ---------------------------------------------------------------------------

describe("getStaleMemories", () => {
  /**
   * Insert a memory with an explicit recorded_at in the past, bypassing
   * insertMemory so we can control the timestamp precisely.
   */
  function insertOldMemory(
    daysAgo: number,
    content = "old memory"
  ): { id: string } {
    const id = `old-mem-${daysAgo}-${Math.random()}`;
    const recordedAt = new Date(
      Date.now() - daysAgo * 24 * 60 * 60 * 1000
    ).toISOString();
    db.prepare(
      `INSERT INTO memories
         (id, user_id, scope, agent_id, content, content_type, tags,
          valid_from, recorded_at, confidence, importance, source_type)
       VALUES (?, ?, 'global', ?, ?, 'text/plain', '[]', ?, ?, 1.0, 0.5, 'manual')`
    ).run(id, USER, AGENT, content, recordedAt, recordedAt);
    return { id };
  }

  it("identifies a memory that is old and never corroborated", () => {
    const { id } = insertOldMemory(40);
    const stale = getStaleMemories(db, USER, 30, 7);
    expect(stale.map((r) => r.id)).toContain(id);
  });

  it("does not include a recently inserted memory", () => {
    const mem = seedMemory("brand new");
    const stale = getStaleMemories(db, USER, 30, 7);
    expect(stale.map((r) => r.id)).not.toContain(mem.id);
  });

  it("does not include an old memory with a recent corroboration", () => {
    const { id } = insertOldMemory(40, "old but corroborated");
    // Corroborate right now so it falls within the 7-day window.
    db.prepare(
      `INSERT INTO corroborations (memory_id, agent_id, corroborated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    ).run(id, AGENT_2);

    const stale = getStaleMemories(db, USER, 30, 7);
    expect(stale.map((r) => r.id)).not.toContain(id);
  });

  it("does not include an invalidated memory", () => {
    const { id } = insertOldMemory(40, "invalidated old");
    db.prepare(
      `UPDATE memories SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    ).run(id);

    const stale = getStaleMemories(db, USER, 30, 7);
    expect(stale.map((r) => r.id)).not.toContain(id);
  });

  it("only includes memories for the queried user", () => {
    insertOldMemory(40, "other user's memory");
    // That memory belongs to USER; query for 'other-user' — should be empty.
    const stale = getStaleMemories(db, "other-user", 30, 7);
    expect(stale).toHaveLength(0);
  });

  it("returns results ordered by recorded_at ascending (oldest first)", () => {
    const { id: older } = insertOldMemory(60, "older");
    const { id: newer } = insertOldMemory(35, "newer");
    const stale = getStaleMemories(db, USER, 30, 7);
    const ids = stale.map((r) => r.id);
    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
  });
});
