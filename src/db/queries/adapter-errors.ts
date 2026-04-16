import { ulid } from "ulid";
import type { Database } from "better-sqlite3";
import { requireRecord, withDbError } from "../../utils/errors.js";

export interface AdapterErrorRow {
  id: string;
  adapter: string;
  error: string;
  created_at: string;
}

export interface LogAdapterErrorInput {
  adapter: string;
  error: string;
}

/**
 * Persists an adapter failure record for later inspection.
 */
export function logAdapterError(
  db: Database,
  input: LogAdapterErrorInput
): AdapterErrorRow {
  const id = ulid();

  return withDbError(`logging adapter error for '${input.adapter}'`, () => {
    db.prepare(
      `INSERT INTO adapter_errors (id, adapter, error)
       VALUES (?, ?, ?)`
    ).run(id, input.adapter, input.error);

    return requireRecord(
      db
        .prepare<[string], AdapterErrorRow>(
          `SELECT * FROM adapter_errors WHERE id = ?`
        )
        .get(id),
      `Adapter error '${id}' was not found after insertion`
    );
  });
}

/**
 * Lists adapter error rows, optionally filtered to a single adapter name.
 */
export function listAdapterErrors(
  db: Database,
  adapter?: string
): AdapterErrorRow[] {
  return withDbError("listing adapter errors", () => {
    if (adapter === undefined) {
      return db
        .prepare<[], AdapterErrorRow>(
          `SELECT * FROM adapter_errors ORDER BY created_at ASC`
        )
        .all();
    }

    return db
      .prepare<[string], AdapterErrorRow>(
        `SELECT * FROM adapter_errors
         WHERE adapter = ?
         ORDER BY created_at ASC`
      )
      .all(adapter);
  });
}
