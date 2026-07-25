import type { Database } from "better-sqlite3";
import { requireRecord, withDbError } from "../../utils/errors.js";

const MEMORY_GENERATION_KEY = "memory_generation";

/**
 * Returns the generation used to invalidate context-pack cache entries.
 */
export function getMemoryGeneration(db: Database): number {
  return withDbError("loading memory generation", () =>
    requireRecord(
      db
        .prepare<[string], { integer_value: number }>(
          `SELECT integer_value
           FROM memryon_state
           WHERE state_key = ?`
        )
        .get(MEMORY_GENERATION_KEY),
      "Memory generation state is missing"
    ).integer_value
  );
}
