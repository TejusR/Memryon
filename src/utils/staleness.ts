import type { Database } from "better-sqlite3";
import { ValidationError, withDbError } from "./errors.js";

export interface StalenessSweepOptions {
  staleDays?: number;
  corroborationWindowDays?: number;
}

export interface StalenessSweepResult {
  stale_count: number;
  memories: string[];
}

// ---------------------------------------------------------------------------
// runStalenessSweep
// ---------------------------------------------------------------------------

/**
 * Flags stale memories by appending a `stale` tag when they are old and lack recent corroboration.
 */
export function runStalenessSweep(
  db: Database,
  options: StalenessSweepOptions = {}
): StalenessSweepResult {
  const { staleDays = 30, corroborationWindowDays = 7 } = options;

  if (staleDays <= 0) {
    throw new ValidationError("staleDays must be positive");
  }
  if (corroborationWindowDays <= 0) {
    throw new ValidationError("corroborationWindowDays must be positive");
  }

  const staleModifier = `-${staleDays} days`;
  const corrModifier = `-${corroborationWindowDays} days`;

  return withDbError("running staleness sweep", () => {
    const staleRows = db
      .prepare<[string, string, string], { id: string }>(
        `SELECT m.id FROM memories m
         WHERE m.invalidated_at IS NULL
           AND m.valid_until IS NULL
           AND m.valid_from < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
           AND NOT EXISTS (
             SELECT 1 FROM corroborations c
             WHERE c.memory_id = m.id
               AND c.corroborated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
           )
           AND (
             m.caused_by IS NULL
             OR m.caused_by NOT IN (
               SELECT id FROM memories
               WHERE recorded_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
             )
           )
         ORDER BY m.valid_from ASC`
      )
      .all(staleModifier, corrModifier, corrModifier);

    if (staleRows.length === 0) {
      return { stale_count: 0, memories: [] };
    }

    const flagStale = db.prepare(
      `UPDATE memories
       SET tags = CASE
         WHEN EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'stale') THEN tags
         ELSE json_insert(tags, '$[#]', 'stale')
       END
       WHERE id = ?`
    );

    const flagAll = db.transaction(() => {
      for (const row of staleRows) {
        flagStale.run(row.id);
      }
    });

    flagAll();

    return {
      stale_count: staleRows.length,
      memories: staleRows.map((row) => row.id),
    };
  });
}
