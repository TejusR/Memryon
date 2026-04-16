import type { Database } from "better-sqlite3";

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export interface CorroborationRow {
  memory_id: string;
  agent_id: string;
  corroborated_at: string;
}

// ---------------------------------------------------------------------------
// corroborate — upsert: insert or refresh the timestamp on conflict
// ---------------------------------------------------------------------------

export function corroborate(
  db: Database,
  memoryId: string,
  agentId: string
): CorroborationRow {
  if (!memoryId) throw new Error("memoryId is required");
  if (!agentId) throw new Error("agentId is required");

  db.prepare(
    `INSERT INTO corroborations (memory_id, agent_id, corroborated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (memory_id, agent_id)
     DO UPDATE SET corroborated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  ).run(memoryId, agentId);

  return db
    .prepare<[string, string], CorroborationRow>(
      `SELECT * FROM corroborations WHERE memory_id = ? AND agent_id = ?`
    )
    .get(memoryId, agentId) as CorroborationRow;
}

// ---------------------------------------------------------------------------
// getCorroborationCount
// ---------------------------------------------------------------------------

export function getCorroborationCount(
  db: Database,
  memoryId: string
): number {
  if (!memoryId) throw new Error("memoryId is required");

  const row = db
    .prepare<[string], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM corroborations WHERE memory_id = ?`
    )
    .get(memoryId);

  return row?.cnt ?? 0;
}

// ---------------------------------------------------------------------------
// getStaleMemories
//
// Returns active memories (not invalidated, valid_until IS NULL) that:
//   1. Were recorded more than `staleDays` ago, AND
//   2. Have NOT been corroborated within the last `corroborationWindowDays`.
// ---------------------------------------------------------------------------

import type { MemoryRow } from "./memories.js";

export function getStaleMemories(
  db: Database,
  userId: string,
  staleDays = 30,
  corroborationWindowDays = 7
): MemoryRow[] {
  if (!userId) throw new Error("userId is required");
  if (staleDays <= 0) throw new Error("staleDays must be positive");
  if (corroborationWindowDays <= 0)
    throw new Error("corroborationWindowDays must be positive");

  // Build the SQLite modifier strings from safe integer values.
  const staleModifier = `-${staleDays} days`;
  const corrModifier = `-${corroborationWindowDays} days`;

  return db
    .prepare<[string, string, string], MemoryRow>(
      `SELECT m.* FROM memories m
       WHERE m.user_id = ?
         AND m.invalidated_at IS NULL
         AND m.valid_until IS NULL
         AND m.recorded_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
         AND NOT EXISTS (
           SELECT 1 FROM corroborations c
           WHERE c.memory_id = m.id
             AND c.corroborated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
         )
       ORDER BY m.recorded_at ASC`
    )
    .all(userId, staleModifier, corrModifier);
}
