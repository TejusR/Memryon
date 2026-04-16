import { ulid } from "ulid";
import type { Database } from "better-sqlite3";
import {
  InsertMemoryInputSchema,
  MemoryFiltersSchema,
  type InsertMemoryInput,
  type MemoryFilters,
} from "../../mcp/schemas.js";

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export interface MemoryRow {
  id: string;
  user_id: string;
  scope: "agent" | "project" | "global";
  agent_id: string;
  project_id: string | null;
  content: string;
  content_type: string;
  /** JSON-serialised string[]. Parse with JSON.parse(). */
  tags: string;
  valid_from: string;
  valid_until: string | null;
  recorded_at: string;
  invalidated_at: string | null;
  invalidated_by: string | null;
  embedding: Buffer | null;
  embedding_model_version: string | null;
  confidence: number;
  importance: number;
  caused_by: string | null;
  supersedes: string | null;
  framework: string | null;
  session_id: string | null;
  source_type: string;
}

// ---------------------------------------------------------------------------
// insertMemory
// ---------------------------------------------------------------------------

export function insertMemory(
  db: Database,
  input: InsertMemoryInput
): MemoryRow {
  // Re-parse at runtime so callers that bypass TypeScript still get validation.
  const parsed = InsertMemoryInputSchema.parse(input);

  const id = ulid();
  const now = new Date().toISOString();
  const projectId = "project_id" in parsed ? parsed.project_id : null;
  const tags = JSON.stringify(parsed.tags);

  db.prepare(
    `INSERT INTO memories (
       id, user_id, scope, agent_id, project_id,
       content, content_type, tags,
       valid_from, valid_until, recorded_at,
       confidence, importance,
       caused_by, supersedes,
       framework, session_id, source_type,
       embedding, embedding_model_version
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, ?,
       ?, ?,
       ?, ?, ?,
       ?, ?
     )`
  ).run(
    id,
    parsed.user_id,
    parsed.scope,
    parsed.agent_id,
    projectId,
    parsed.content,
    parsed.content_type,
    tags,
    parsed.valid_from ?? now,
    parsed.valid_until ?? null,
    now,
    parsed.confidence,
    parsed.importance,
    parsed.caused_by ?? null,
    parsed.supersedes ?? null,
    parsed.framework ?? null,
    parsed.session_id ?? null,
    parsed.source_type,
    parsed.embedding ?? null,
    parsed.embedding_model_version ?? null
  );

  return db
    .prepare<[string], MemoryRow>(`SELECT * FROM memories WHERE id = ?`)
    .get(id) as MemoryRow;
}

// ---------------------------------------------------------------------------
// getValidMemories
// ---------------------------------------------------------------------------

export function getValidMemories(
  db: Database,
  filters: MemoryFilters,
  limit = 50,
  offset = 0
): MemoryRow[] {
  const { user_id, scope, project_id, agent_id } =
    MemoryFiltersSchema.parse(filters);

  // Use (? IS NULL OR col = ?) so a single prepared statement covers optional filters.
  return db
    .prepare<unknown[], MemoryRow>(
      `SELECT * FROM memories
       WHERE user_id = ?
         AND invalidated_at IS NULL
         AND valid_until IS NULL
         AND (? IS NULL OR scope = ?)
         AND (? IS NULL OR project_id = ?)
         AND (? IS NULL OR agent_id = ?)
       ORDER BY recorded_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(
      user_id,
      scope ?? null, scope ?? null,
      project_id ?? null, project_id ?? null,
      agent_id ?? null, agent_id ?? null,
      limit,
      offset
    );
}

// ---------------------------------------------------------------------------
// fanOutQuery — three-tier fan-out: project > agent-private > global
// ---------------------------------------------------------------------------

const PROJECT_STMT = `
  SELECT * FROM memories
  WHERE scope = 'project'
    AND project_id = ?
    AND user_id = ?
    AND invalidated_at IS NULL
    AND valid_until IS NULL
  ORDER BY recorded_at DESC
  LIMIT ?`;

const AGENT_STMT = `
  SELECT * FROM memories
  WHERE scope = 'agent'
    AND agent_id = ?
    AND user_id = ?
    AND invalidated_at IS NULL
    AND valid_until IS NULL
  ORDER BY recorded_at DESC
  LIMIT ?`;

const GLOBAL_STMT = `
  SELECT * FROM memories
  WHERE scope = 'global'
    AND user_id = ?
    AND invalidated_at IS NULL
    AND valid_until IS NULL
  ORDER BY recorded_at DESC
  LIMIT ?`;

export function fanOutQuery(
  db: Database,
  userId: string,
  agentId: string,
  projectId?: string,
  limit = 20
): MemoryRow[] {
  if (!userId) throw new Error("userId is required");
  if (!agentId) throw new Error("agentId is required");

  const projectRows: MemoryRow[] = projectId
    ? db
        .prepare<unknown[], MemoryRow>(PROJECT_STMT)
        .all(projectId, userId, limit)
    : [];

  const agentRows: MemoryRow[] = db
    .prepare<unknown[], MemoryRow>(AGENT_STMT)
    .all(agentId, userId, limit);

  const globalRows: MemoryRow[] = db
    .prepare<unknown[], MemoryRow>(GLOBAL_STMT)
    .all(userId, limit);

  // Merge tiers in priority order, deduplicate by id, respect overall limit.
  const seen = new Set<string>();
  const results: MemoryRow[] = [];

  for (const row of [...projectRows, ...agentRows, ...globalRows]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      results.push(row);
      if (results.length === limit) break;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// findByFTS
// ---------------------------------------------------------------------------

export function findByFTS(
  db: Database,
  query: string,
  filters: MemoryFilters,
  limit = 20
): MemoryRow[] {
  const { user_id, scope, project_id, agent_id } =
    MemoryFiltersSchema.parse(filters);

  return db
    .prepare<unknown[], MemoryRow>(
      `SELECT m.* FROM memories m
       WHERE m.rowid IN (
         SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?
       )
         AND m.user_id = ?
         AND m.invalidated_at IS NULL
         AND m.valid_until IS NULL
         AND (? IS NULL OR m.scope = ?)
         AND (? IS NULL OR m.project_id = ?)
         AND (? IS NULL OR m.agent_id = ?)
       ORDER BY m.recorded_at DESC
       LIMIT ?`
    )
    .all(
      query,
      user_id,
      scope ?? null, scope ?? null,
      project_id ?? null, project_id ?? null,
      agent_id ?? null, agent_id ?? null,
      limit
    );
}

// ---------------------------------------------------------------------------
// findBySemanticSimilarity — placeholder until sqlite-vec is wired up
// ---------------------------------------------------------------------------

export function findBySemanticSimilarity(
  db: Database,
  _embedding: Buffer,
  filters: MemoryFilters,
  limit = 20
): MemoryRow[] {
  // TODO: replace with sqlite-vec KNN once the extension is loaded:
  //   SELECT m.*, vec_distance_cosine(m.embedding, ?) AS dist
  //   FROM memories m
  //   WHERE m.embedding IS NOT NULL
  //   ORDER BY dist ASC
  //   LIMIT ?
  // For now, fall back to recency ordering so callers get usable results.
  return getValidMemories(db, filters, limit);
}

// ---------------------------------------------------------------------------
// invalidateMemory
// ---------------------------------------------------------------------------

export function invalidateMemory(
  db: Database,
  memoryId: string,
  invalidatedBy: string
): boolean {
  if (!memoryId) throw new Error("memoryId is required");
  if (!invalidatedBy) throw new Error("invalidatedBy is required");

  const result = db
    .prepare(
      `UPDATE memories
       SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           invalidated_by = ?,
           valid_until    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
         AND invalidated_at IS NULL`
    )
    .run(invalidatedBy, memoryId);

  return result.changes > 0;
}
