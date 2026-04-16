import { ulid } from "ulid";
import type { Database } from "better-sqlite3";

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

export function logAdapterError(
  db: Database,
  input: LogAdapterErrorInput
): AdapterErrorRow {
  const id = ulid();

  db.prepare(
    `INSERT INTO adapter_errors (id, adapter, error)
     VALUES (?, ?, ?)`
  ).run(id, input.adapter, input.error);

  return db
    .prepare<[string], AdapterErrorRow>(
      `SELECT * FROM adapter_errors WHERE id = ?`
    )
    .get(id) as AdapterErrorRow;
}

export function listAdapterErrors(
  db: Database,
  adapter?: string
): AdapterErrorRow[] {
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
}
