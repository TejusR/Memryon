import Database from "better-sqlite3";
import { initSchema } from "./schema.js";
import { withDbError } from "../utils/errors.js";

export type { Database } from "better-sqlite3";

const connections = new Map<string, Database.Database>();

/**
 * Opens or reuses a SQLite connection for the supplied path and ensures the schema exists.
 */
export function getDb(dbPath: string): Database.Database {
  const existing = connections.get(dbPath);
  if (existing !== undefined) {
    return existing;
  }

  return withDbError(`opening database '${dbPath}'`, () => {
    const db = new Database(dbPath);

    // WAL mode: concurrent reads with serialized writes
    db.pragma("journal_mode = WAL");

    // Don't wait forever on a locked database
    db.pragma("busy_timeout = 5000");

    // Enforce referential integrity
    db.pragma("foreign_keys = ON");

    // Safer writes without a full sync on every transaction
    db.pragma("synchronous = NORMAL");

    // Initialize schema on first open
    initSchema(db);

    connections.set(dbPath, db);
    return db;
  });
}

/**
 * Closes and removes a cached SQLite connection if one exists for the supplied path.
 */
export function closeDb(dbPath: string): void {
  const db = connections.get(dbPath);
  if (db !== undefined) {
    withDbError(`closing database '${dbPath}'`, () => {
      db.close();
      connections.delete(dbPath);
    });
  }
}
