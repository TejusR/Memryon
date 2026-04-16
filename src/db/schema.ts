import type { Database } from "better-sqlite3";

export const SCHEMA_SQL = `
-- Agents registry
CREATE TABLE IF NOT EXISTS agents (
  agent_id       TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL,
  trust_tier     INTEGER NOT NULL CHECK (trust_tier IN (1, 2, 3)),
  capabilities   TEXT NOT NULL DEFAULT '[]',  -- JSON array
  registered_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Projects (named collaboration boundaries)
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at  TEXT
);

-- Project membership
CREATE TABLE IF NOT EXISTS project_agents (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'contributor' CHECK (role IN ('owner', 'contributor', 'readonly')),
  joined_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, agent_id)
);

-- Core memory cells
CREATE TABLE IF NOT EXISTS memories (
  id                     TEXT PRIMARY KEY,  -- ULID
  user_id                TEXT NOT NULL,
  scope                  TEXT NOT NULL CHECK (scope IN ('agent', 'project', 'global')),
  agent_id               TEXT NOT NULL REFERENCES agents(agent_id),
  project_id             TEXT REFERENCES projects(id),

  content                TEXT NOT NULL,
  content_type           TEXT NOT NULL DEFAULT 'text/plain',
  tags                   TEXT NOT NULL DEFAULT '[]',  -- JSON array

  -- Bi-temporal columns
  valid_from             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  valid_until            TEXT,       -- NULL = currently valid
  recorded_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- Soft-delete provenance
  invalidated_at         TEXT,
  invalidated_by         TEXT,       -- agent_id that invalidated

  -- Embedding
  embedding              BLOB,
  embedding_model_version TEXT,

  -- Quality / confidence
  confidence             REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  importance             REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0.0 AND importance <= 1.0),

  -- Causal / provenance links
  caused_by              TEXT REFERENCES memories(id),
  supersedes             TEXT REFERENCES memories(id),

  -- Adapter metadata
  framework              TEXT,
  session_id             TEXT,
  source_type            TEXT NOT NULL DEFAULT 'manual',

  -- Scope constraints
  CHECK (scope != 'project' OR project_id IS NOT NULL),
  CHECK (scope = 'project' OR project_id IS NULL)
);

-- Corroborations (agents vouching for existing memories)
CREATE TABLE IF NOT EXISTS corroborations (
  memory_id       TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  corroborated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (memory_id, agent_id)
);

-- Conflict log
CREATE TABLE IF NOT EXISTS conflicts (
  id            TEXT PRIMARY KEY,  -- ULID
  memory_a      TEXT NOT NULL REFERENCES memories(id),
  memory_b      TEXT NOT NULL REFERENCES memories(id),
  project_id    TEXT REFERENCES projects(id),
  conflict_type TEXT NOT NULL,
  detected_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at   TEXT,
  resolution    TEXT,
  resolved_by   TEXT              -- agent_id
);

-- Fast-path ingestion staging
CREATE TABLE IF NOT EXISTS candidate_buffer (
  id                  TEXT PRIMARY KEY,  -- ULID
  user_id             TEXT,
  content             TEXT NOT NULL,
  source_turn         TEXT NOT NULL,
  candidate_type      TEXT NOT NULL DEFAULT 'fact'
                        CHECK (candidate_type IN ('entity', 'fact', 'decision', 'preference')),
  agent_id            TEXT NOT NULL,
  framework           TEXT,
  session_id          TEXT,
  scope               TEXT NOT NULL CHECK (scope IN ('agent', 'project', 'global')),
  project_id          TEXT REFERENCES projects(id),
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
  review_required     INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1)),
  decision_action     TEXT,
  decision_reason     TEXT,
  decision_confidence REAL,
  processed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (scope != 'project' OR project_id IS NOT NULL),
  CHECK (scope = 'project' OR project_id IS NULL)
);

-- Per-framework failure logging
CREATE TABLE IF NOT EXISTS adapter_errors (
  id         TEXT PRIMARY KEY,  -- ULID
  adapter    TEXT NOT NULL,
  error      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Detailed contradiction audit trail used by the consolidation worker
CREATE TABLE IF NOT EXISTS conflict_log (
  id                    TEXT PRIMARY KEY,  -- ULID
  conflict_id           TEXT REFERENCES conflicts(id),
  existing_memory_id    TEXT NOT NULL REFERENCES memories(id),
  candidate_memory_id   TEXT NOT NULL REFERENCES memories(id),
  existing_agent_id     TEXT NOT NULL REFERENCES agents(agent_id),
  candidate_agent_id    TEXT NOT NULL REFERENCES agents(agent_id),
  existing_framework    TEXT,
  candidate_framework   TEXT,
  project_id            TEXT REFERENCES projects(id),
  conflict_type         TEXT NOT NULL,
  resolution_status     TEXT NOT NULL DEFAULT 'pending'
                          CHECK (resolution_status IN ('pending', 'resolved', 'flagged')),
  resolution_reason     TEXT,
  resolved_by           TEXT REFERENCES agents(agent_id),
  detected_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- MemScene clustering metadata
CREATE TABLE IF NOT EXISTS memscenes (
  id             TEXT PRIMARY KEY,  -- ULID
  scene_key      TEXT NOT NULL UNIQUE,
  user_id        TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('agent', 'project', 'global')),
  project_id     TEXT REFERENCES projects(id),
  summary        TEXT NOT NULL,
  memory_count   INTEGER NOT NULL,
  session_count  INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS memscene_memories (
  scene_id   TEXT NOT NULL REFERENCES memscenes(id) ON DELETE CASCADE,
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (scene_id, memory_id)
);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content_type,
  agent_id,
  project_id,
  scope,
  content='memories',
  content_rowid='rowid'
);

-- FTS5 triggers to keep memories_fts in sync
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, content_type, agent_id, project_id, scope)
  VALUES (new.rowid, new.content, new.content_type, new.agent_id, new.project_id, new.scope);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, content_type, agent_id, project_id, scope)
  VALUES ('delete', old.rowid, old.content, old.content_type, old.agent_id, old.project_id, old.scope);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, content_type, agent_id, project_id, scope)
  VALUES ('delete', old.rowid, old.content, old.content_type, old.agent_id, old.project_id, old.scope);
  INSERT INTO memories_fts(rowid, content, content_type, agent_id, project_id, scope)
  VALUES (new.rowid, new.content, new.content_type, new.agent_id, new.project_id, new.scope);
END;
`;

export const INDEXES_SQL = `
-- Primary query path: user + scope filter with recency ordering
CREATE INDEX IF NOT EXISTS idx_mem_user_scope
  ON memories(user_id, scope, invalidated_at, recorded_at DESC);

-- Project-scoped queries (partial index: only rows with a project_id)
CREATE INDEX IF NOT EXISTS idx_mem_project
  ON memories(project_id, scope, invalidated_at, recorded_at DESC)
  WHERE project_id IS NOT NULL;

-- Private agent memories (partial index: only agent-scoped rows)
CREATE INDEX IF NOT EXISTS idx_mem_agent_private
  ON memories(agent_id, user_id, invalidated_at)
  WHERE scope = 'agent';

-- Open conflicts per project
CREATE INDEX IF NOT EXISTS idx_conflicts_project
  ON conflicts(project_id, resolved_at)
  WHERE resolved_at IS NULL;

-- Corroboration lookup ordered by recency
CREATE INDEX IF NOT EXISTS idx_corr_memory
  ON corroborations(memory_id, corroborated_at DESC);

-- Project membership lookup by agent
CREATE INDEX IF NOT EXISTS idx_pa_agent
  ON project_agents(agent_id, project_id);

-- Consolidation worker pending queue
CREATE INDEX IF NOT EXISTS idx_candidate_buffer_status
  ON candidate_buffer(status, created_at ASC);

-- Conflict audit lookup by project
CREATE INDEX IF NOT EXISTS idx_conflict_log_project
  ON conflict_log(project_id, detected_at DESC)
  WHERE project_id IS NOT NULL;

-- MemScene lookup by scope and freshness
CREATE INDEX IF NOT EXISTS idx_memscenes_scope
  ON memscenes(user_id, scope, updated_at DESC);
`;

export function initSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  db.exec(INDEXES_SQL);
}
