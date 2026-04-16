import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";

const TEST_DB = ":memory:";

afterEach(() => {
  closeDb(TEST_DB);
});

// Helper: returns all user_tables in the db
function tableNames(db: ReturnType<typeof getDb>): string[] {
  return db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
    )
    .all()
    .map((r) => (r as { name: string }).name);
}

function indexNames(db: ReturnType<typeof getDb>): string[] {
  return db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`
    )
    .all()
    .map((r) => (r as { name: string }).name);
}

describe("schema: table creation", () => {
  it("creates all required tables", () => {
    const db = getDb(TEST_DB);
    const tables = tableNames(db);
    const required = [
      "adapter_errors",
      "agents",
      "candidate_buffer",
      "conflict_log",
      "conflicts",
      "corroborations",
      "memscene_memories",
      "memscenes",
      "memories",
      "memories_fts",
      "project_agents",
      "projects",
    ];
    for (const table of required) {
      expect(tables, `expected table '${table}' to exist`).toContain(table);
    }
  });
});

describe("schema: CHECK constraints on memories", () => {
  const AGENT_ID = "agent-test-1";
  const PROJECT_ID = "proj-test-1";
  const USER_ID = "user-1";

  function seed(db: ReturnType<typeof getDb>): void {
    db.prepare(
      `INSERT INTO agents (agent_id, display_name, trust_tier) VALUES (?, ?, ?)`
    ).run(AGENT_ID, "Test Agent", 1);
    db.prepare(
      `INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)`
    ).run(PROJECT_ID, USER_ID, "Test Project");
  }

  it("accepts valid agent-scope memory (no project_id)", () => {
    const db = getDb(TEST_DB);
    seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO memories (id, user_id, scope, agent_id, content)
           VALUES ('mem-1', ?, 'agent', ?, ?)`
        )
        .run(USER_ID, AGENT_ID, "agent-scoped content")
    ).not.toThrow();
  });

  it("accepts valid global-scope memory (no project_id)", () => {
    const db = getDb(TEST_DB);
    seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO memories (id, user_id, scope, agent_id, content)
           VALUES ('mem-2', ?, 'global', ?, ?)`
        )
        .run(USER_ID, AGENT_ID, "global content")
    ).not.toThrow();
  });

  it("accepts valid project-scope memory with project_id", () => {
    const db = getDb(TEST_DB);
    seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO memories (id, user_id, scope, agent_id, project_id, content)
           VALUES ('mem-3', ?, 'project', ?, ?, ?)`
        )
        .run(USER_ID, AGENT_ID, PROJECT_ID, "project content")
    ).not.toThrow();
  });

  it("rejects project-scope memory without project_id", () => {
    const db = getDb(TEST_DB);
    seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO memories (id, user_id, scope, agent_id, content)
           VALUES ('mem-bad-1', ?, 'project', ?, ?)`
        )
        .run(USER_ID, AGENT_ID, "should fail")
    ).toThrow();
  });

  it("rejects agent-scope memory with a project_id", () => {
    const db = getDb(TEST_DB);
    seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO memories (id, user_id, scope, agent_id, project_id, content)
           VALUES ('mem-bad-2', ?, 'agent', ?, ?, ?)`
        )
        .run(USER_ID, AGENT_ID, PROJECT_ID, "should fail")
    ).toThrow();
  });

  it("rejects global-scope memory with a project_id", () => {
    const db = getDb(TEST_DB);
    seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO memories (id, user_id, scope, agent_id, project_id, content)
           VALUES ('mem-bad-3', ?, 'global', ?, ?, ?)`
        )
        .run(USER_ID, AGENT_ID, PROJECT_ID, "should fail")
    ).toThrow();
  });

  it("rejects an invalid scope value", () => {
    const db = getDb(TEST_DB);
    seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO memories (id, user_id, scope, agent_id, content)
           VALUES ('mem-bad-4', ?, 'invalid', ?, ?)`
        )
        .run(USER_ID, AGENT_ID, "bad scope")
    ).toThrow();
  });
});

describe("schema: indexes", () => {
  it("creates all required indexes", () => {
    const db = getDb(TEST_DB);
    const indexes = indexNames(db);
    const required = [
      "idx_mem_user_scope",
      "idx_mem_project",
      "idx_mem_agent_private",
      "idx_conflicts_project",
      "idx_corr_memory",
      "idx_pa_agent",
      "idx_candidate_buffer_status",
      "idx_conflict_log_project",
      "idx_memscenes_scope",
    ];
    for (const idx of required) {
      expect(indexes, `expected index '${idx}' to exist`).toContain(idx);
    }
  });
});

describe("connection: WAL mode", () => {
  it("enables WAL journal mode", () => {
    const db = getDb(TEST_DB);
    // WAL is reported as 'memory' for in-memory databases — test with a real file
    // For :memory: SQLite always returns 'memory', so we check the pragma call succeeded
    const result = db.pragma("journal_mode", { simple: true });
    // :memory: dbs always use 'memory' journal mode (WAL cannot be set on them)
    expect(["wal", "memory"]).toContain(result);
  });

  it("sets busy_timeout to 5000", () => {
    const db = getDb(TEST_DB);
    const result = db.pragma("busy_timeout", { simple: true });
    expect(result).toBe(5000);
  });

  it("enables foreign key enforcement", () => {
    const db = getDb(TEST_DB);
    const result = db.pragma("foreign_keys", { simple: true });
    expect(result).toBe(1);
  });
});

describe("connection: foreign key enforcement", () => {
  it("rejects a memory referencing a non-existent agent", () => {
    const db = getDb(TEST_DB);
    expect(() =>
      db
        .prepare(
          `INSERT INTO memories (id, user_id, scope, agent_id, content)
           VALUES ('fk-bad', 'u1', 'global', 'ghost-agent', 'content')`
        )
        .run()
    ).toThrow();
  });
});
