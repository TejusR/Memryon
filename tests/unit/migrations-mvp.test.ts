import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";
import { runMigrations, getSchemaVersion } from "../../src/db/migrations.js";
import { initSchema } from "../../src/db/schema.js";

describe("MVP schema migrations", () => {
  it("upgrades a baseline database in place and backfills existing memories", () => {
    const db = new Database(":memory:");
    sqliteVec.load(db);
    db.pragma("foreign_keys = ON");
    initSchema(db);
    db.prepare(
      `INSERT INTO agents (agent_id, display_name, trust_tier, capabilities)
       VALUES ('legacy-agent', 'Legacy Agent', 2, '[]')`
    ).run();
    db.prepare(
      `INSERT INTO memories (
         id, user_id, scope, agent_id, content, content_type, tags,
         valid_from, recorded_at, confidence, importance, source_type
       ) VALUES (
         'legacy-memory', 'local-user', 'agent', 'legacy-agent',
         'Keep this row', 'text/plain', '[]',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
         1, 0.5, 'manual'
       )`
    ).run();

    runMigrations(db);
    runMigrations(db);

    expect(getSchemaVersion(db)).toBe(6);
    expect(
      db
        .prepare<
          [string],
          { content: string; memory_kind: string; metadata_json: string }
        >(
          `SELECT content, memory_kind, metadata_json
           FROM memories WHERE id = ?`
        )
        .get("legacy-memory")
    ).toEqual({
      content: "Keep this row",
      memory_kind: "observation",
      metadata_json: "{}",
    });
    expect(
      db
        .prepare<[string], { status: string }>(
          `SELECT status FROM embedding_jobs WHERE memory_id = ?`
        )
        .get("legacy-memory")?.status
    ).toBe("PENDING");
    expect(
      db
        .prepare<[], { count: number }>(
          `SELECT COUNT(*) AS count FROM schema_migrations`
        )
      .get()?.count
    ).toBe(6);

    expect(
      db
        .prepare<[], { sql: string }>(
          `SELECT sql FROM sqlite_master WHERE name = 'memory_vectors'`
        )
        .get()?.sql
    ).toContain("distance_metric=cosine");
    db.close();
  });
});
