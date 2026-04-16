import type { Database } from "better-sqlite3";

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
//
// Identifies active memories that have gone stale:
//   1. valid_from is older than staleDays
//   2. No corroboration exists within the last corroborationWindowDays
//   3. Not caused_by a memory that was recorded within corroborationWindowDays
//
// Flags stale memories by adding a "stale" tag (idempotent). Does NOT delete.
// ---------------------------------------------------------------------------

export function runStalenessSweep(
  db: Database,
  options: StalenessSweepOptions = {}
): StalenessSweepResult {
  const { staleDays = 30, corroborationWindowDays = 7 } = options;

  if (staleDays <= 0) throw new Error("staleDays must be positive");
  if (corroborationWindowDays <= 0) throw new Error("corroborationWindowDays must be positive");

  const staleModifier = `-${staleDays} days`;
  const corrModifier = `-${corroborationWindowDays} days`;

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

  // Add 'stale' tag if not already present — idempotent via CASE check.
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
    memories: staleRows.map((r) => r.id),
  };
}
