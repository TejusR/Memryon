import type { Database } from "better-sqlite3";
import type { MemoryRow } from "./memories.js";
import {
  requireNonEmptyString,
  requireRecord,
  ValidationError,
  withDbError,
} from "../../utils/errors.js";

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

/**
 * Inserts or refreshes a corroboration from an agent for the given memory.
 */
export function corroborate(
  db: Database,
  memoryId: string,
  agentId: string
): CorroborationRow {
  const resolvedMemoryId = requireNonEmptyString(memoryId, "memoryId");
  const resolvedAgentId = requireNonEmptyString(agentId, "agentId");

  return withDbError(
    `corroborating memory '${resolvedMemoryId}' for agent '${resolvedAgentId}'`,
    () => {
      db.prepare(
        `INSERT INTO corroborations (memory_id, agent_id, corroborated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (memory_id, agent_id)
         DO UPDATE SET corroborated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run(resolvedMemoryId, resolvedAgentId);

      return requireRecord(
        db
          .prepare<[string, string], CorroborationRow>(
            `SELECT * FROM corroborations WHERE memory_id = ? AND agent_id = ?`
          )
          .get(resolvedMemoryId, resolvedAgentId),
        `Corroboration for memory '${resolvedMemoryId}' and agent '${resolvedAgentId}' was not found after upsert`
      );
    }
  );
}

// ---------------------------------------------------------------------------
// getCorroborationCount
// ---------------------------------------------------------------------------

/**
 * Counts how many agents have corroborated a memory.
 */
export function getCorroborationCount(
  db: Database,
  memoryId: string
): number {
  const resolvedMemoryId = requireNonEmptyString(memoryId, "memoryId");

  return withDbError(
    `counting corroborations for memory '${resolvedMemoryId}'`,
    () => {
      const row = db
        .prepare<[string], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM corroborations WHERE memory_id = ?`
        )
        .get(resolvedMemoryId);

      return row?.cnt ?? 0;
    }
  );
}

// ---------------------------------------------------------------------------
// getStaleMemories
//
// Returns active memories (not invalidated, valid_until IS NULL) that:
//   1. Were recorded more than `staleDays` ago, AND
//   2. Have NOT been corroborated within the last `corroborationWindowDays`.
// ---------------------------------------------------------------------------
/**
 * Returns currently valid memories that have aged past the stale threshold without recent corroboration.
 */
export function getStaleMemories(
  db: Database,
  userId: string,
  staleDays = 30,
  corroborationWindowDays = 7
): MemoryRow[] {
  const resolvedUserId = requireNonEmptyString(userId, "userId");
  if (staleDays <= 0) {
    throw new ValidationError("staleDays must be positive");
  }
  if (corroborationWindowDays <= 0) {
    throw new ValidationError("corroborationWindowDays must be positive");
  }

  // Build the SQLite modifier strings from safe integer values.
  const staleModifier = `-${staleDays} days`;
  const corrModifier = `-${corroborationWindowDays} days`;

  return withDbError(`loading stale memories for user '${resolvedUserId}'`, () =>
    db
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
      .all(resolvedUserId, staleModifier, corrModifier)
  );
}
