import type { Database } from "better-sqlite3";
import { initSchema } from "./schema.js";
import { withDbError } from "../utils/errors.js";

interface Migration {
  version: number;
  name: string;
  apply(db: Database): void;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all();
  return rows.some((row) => row.name === column);
}

function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  definition: string
): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "baseline",
    apply(db) {
      initSchema(db);
    },
  },
  {
    version: 2,
    name: "handoffs-context-and-vector-index",
    apply(db) {
      addColumnIfMissing(
        db,
        "memories",
        "memory_kind",
        "TEXT NOT NULL DEFAULT 'observation'"
      );
      addColumnIfMissing(db, "memories", "task_id", "TEXT");
      addColumnIfMissing(
        db,
        "memories",
        "metadata_json",
        "TEXT NOT NULL DEFAULT '{}'"
      );
      addColumnIfMissing(
        db,
        "memories",
        "evidence_refs_json",
        "TEXT NOT NULL DEFAULT '[]'"
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS handoffs (
          id                 TEXT PRIMARY KEY,
          user_id            TEXT NOT NULL,
          project_id         TEXT REFERENCES projects(id),
          agent_id           TEXT NOT NULL REFERENCES agents(agent_id),
          framework          TEXT,
          session_id         TEXT,
          task               TEXT NOT NULL,
          summary            TEXT NOT NULL DEFAULT '',
          evidence_refs_json TEXT NOT NULL DEFAULT '[]',
          created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS handoff_memories (
          handoff_id  TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
          memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          ordinal     INTEGER NOT NULL,
          memory_kind TEXT NOT NULL,
          PRIMARY KEY (handoff_id, memory_id)
        );

        CREATE TABLE IF NOT EXISTS context_packs (
          id                 TEXT PRIMARY KEY,
          user_id            TEXT NOT NULL,
          agent_id           TEXT NOT NULL REFERENCES agents(agent_id),
          project_id         TEXT REFERENCES projects(id),
          session_id         TEXT,
          task               TEXT NOT NULL,
          token_budget       INTEGER NOT NULL,
          estimated_tokens   INTEGER NOT NULL,
          rendered_context   TEXT NOT NULL,
          memory_generation  INTEGER NOT NULL,
          retrieval_ms       INTEGER NOT NULL,
          degraded           INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1)),
          degraded_reasons_json TEXT NOT NULL DEFAULT '[]',
          conflicts_json     TEXT NOT NULL DEFAULT '[]',
          cache_key          TEXT NOT NULL,
          created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS context_pack_items (
          context_pack_id  TEXT NOT NULL REFERENCES context_packs(id) ON DELETE CASCADE,
          memory_id        TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          rank             INTEGER NOT NULL,
          score            REAL NOT NULL,
          reason           TEXT NOT NULL,
          estimated_tokens INTEGER NOT NULL,
          content_snapshot TEXT NOT NULL,
          provenance_json  TEXT NOT NULL,
          PRIMARY KEY (context_pack_id, memory_id)
        );

        CREATE TABLE IF NOT EXISTS embedding_jobs (
          memory_id  TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          status     TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
          attempts   INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS memryon_state (
          state_key     TEXT PRIMARY KEY,
          integer_value INTEGER NOT NULL
        );

        INSERT OR IGNORE INTO memryon_state (state_key, integer_value)
        VALUES ('memory_generation', 0);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
          embedding float[384] distance_metric=cosine
        );

        CREATE INDEX IF NOT EXISTS idx_handoffs_project
          ON handoffs(project_id, created_at DESC)
          WHERE project_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_context_packs_cache
          ON context_packs(cache_key, memory_generation, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_embedding_jobs_status
          ON embedding_jobs(status, updated_at ASC);

        CREATE TRIGGER IF NOT EXISTS memories_enqueue_embedding
        AFTER INSERT ON memories
        WHEN new.embedding IS NULL AND new.content_type LIKE 'text/%'
        BEGIN
          INSERT OR IGNORE INTO embedding_jobs (memory_id) VALUES (new.id);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_generation_insert
        AFTER INSERT ON memories
        BEGIN
          UPDATE memryon_state
          SET integer_value = integer_value + 1
          WHERE state_key = 'memory_generation';
        END;

        CREATE TRIGGER IF NOT EXISTS memories_generation_delete
        AFTER DELETE ON memories
        BEGIN
          UPDATE memryon_state
          SET integer_value = integer_value + 1
          WHERE state_key = 'memory_generation';
        END;

        CREATE TRIGGER IF NOT EXISTS memories_generation_update
        AFTER UPDATE OF
          content, scope, project_id, valid_until, invalidated_at, supersedes,
          importance, confidence, tags, memory_kind, task_id, metadata_json,
          evidence_refs_json
        ON memories
        BEGIN
          UPDATE memryon_state
          SET integer_value = integer_value + 1
          WHERE state_key = 'memory_generation';
        END;
      `);

      db.prepare(
        `INSERT OR IGNORE INTO embedding_jobs (memory_id)
         SELECT id
         FROM memories
         WHERE embedding IS NULL
           AND content_type LIKE 'text/%'
           AND invalidated_at IS NULL
           AND valid_until IS NULL`
      ).run();
    },
  },
  {
    version: 3,
    name: "context-pack-item-snapshots",
    apply(db) {
      addColumnIfMissing(
        db,
        "context_pack_items",
        "content_snapshot",
        "TEXT NOT NULL DEFAULT ''"
      );
      addColumnIfMissing(
        db,
        "context_pack_items",
        "provenance_json",
        "TEXT NOT NULL DEFAULT '{}'"
      );
    },
  },
  {
    version: 4,
    name: "context-pack-status-snapshots",
    apply(db) {
      addColumnIfMissing(
        db,
        "context_packs",
        "degraded_reasons_json",
        "TEXT NOT NULL DEFAULT '[]'"
      );
      addColumnIfMissing(
        db,
        "context_packs",
        "conflicts_json",
        "TEXT NOT NULL DEFAULT '[]'"
      );
    },
  },
  {
    version: 5,
    name: "hook-reminder-guards",
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS hook_reminders (
          session_id  TEXT NOT NULL,
          agent_id    TEXT NOT NULL,
          reminded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (session_id, agent_id)
        )
      `);
    },
  },
  {
    version: 6,
    name: "cosine-vector-index",
    apply(db) {
      const vectorTable = db
        .prepare<[], { sql: string }>(
          `SELECT sql
           FROM sqlite_master
           WHERE type = 'table' AND name = 'memory_vectors'`
        )
        .get();
      if (vectorTable?.sql.includes("distance_metric=cosine")) {
        return;
      }

      // The vector index is a derived cache. Rebuild it in place and queue
      // active text memories for an idempotent backfill.
      db.exec(`
        DROP TABLE IF EXISTS memory_vectors;
        CREATE VIRTUAL TABLE memory_vectors USING vec0(
          embedding float[384] distance_metric=cosine
        );

        INSERT OR IGNORE INTO embedding_jobs (memory_id)
        SELECT id
        FROM memories
        WHERE content_type LIKE 'text/%'
          AND invalidated_at IS NULL
          AND valid_until IS NULL;

        UPDATE embedding_jobs
        SET status = 'PENDING',
            attempts = 0,
            last_error = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE memory_id IN (
          SELECT id
          FROM memories
          WHERE content_type LIKE 'text/%'
            AND invalidated_at IS NULL
            AND valid_until IS NULL
        );
      `);
    },
  },
];

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
}

/**
 * Applies pending schema migrations in ascending order.
 */
export function runMigrations(db: Database): void {
  withDbError("running database migrations", () => {
    ensureMigrationTable(db);
    const applied = new Set(
      db
        .prepare<[], { version: number }>(
          `SELECT version FROM schema_migrations ORDER BY version`
        )
        .all()
        .map((row) => row.version)
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }

      db.transaction(() => {
        migration.apply(db);
        db.prepare(
          `INSERT INTO schema_migrations (version, name) VALUES (?, ?)`
        ).run(migration.version, migration.name);
      })();
    }
  });
}

export function getSchemaVersion(db: Database): number {
  ensureMigrationTable(db);
  return (
    db
      .prepare<[], { version: number }>(
        `SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`
      )
      .get()?.version ?? 0
  );
}
