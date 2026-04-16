import Database from "better-sqlite3";
import { initSchema } from "./schema.js";

export type { Database } from "better-sqlite3";

const connections = new Map<string, Database.Database>();

export function getDb(dbPath: string): Database.Database {
  const existing = connections.get(dbPath);
  if (existing !== undefined) {
    return existing;
  }

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
}

export function closeDb(dbPath: string): void {
  const db = connections.get(dbPath);
  if (db !== undefined) {
    db.close();
    connections.delete(dbPath);
  }
}
