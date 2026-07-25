import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import {
  requireNonEmptyString,
  requireRecord,
  withDbError,
} from "../../utils/errors.js";
import type { JsonObject } from "../../utils/json.js";

export interface ContextPackRow {
  id: string;
  user_id: string;
  agent_id: string;
  project_id: string | null;
  session_id: string | null;
  task: string;
  token_budget: number;
  estimated_tokens: number;
  rendered_context: string;
  memory_generation: number;
  retrieval_ms: number;
  degraded: 0 | 1;
  degraded_reasons_json: string;
  conflicts_json: string;
  cache_key: string;
  created_at: string;
}

export interface ContextPackItemRow {
  context_pack_id: string;
  memory_id: string;
  rank: number;
  score: number;
  reason: string;
  estimated_tokens: number;
  content_snapshot: string;
  provenance_json: string;
}

export interface InsertContextPackItem {
  memoryId: string;
  rank: number;
  score: number;
  reason: string;
  estimatedTokens: number;
  contentSnapshot: string;
  provenance: JsonObject;
}

export interface InsertContextPackInput {
  id?: string;
  userId: string;
  agentId: string;
  projectId?: string;
  sessionId?: string;
  task: string;
  tokenBudget: number;
  estimatedTokens: number;
  renderedContext: string;
  memoryGeneration: number;
  retrievalMs: number;
  degradedReasons: string[];
  conflicts: JsonObject[];
  cacheKey: string;
  items: InsertContextPackItem[];
}

export interface StoredContextPack {
  pack: ContextPackRow;
  items: ContextPackItemRow[];
}

/**
 * Persists both the rendered pack and immutable item snapshots atomically.
 */
export function insertContextPack(
  db: Database,
  input: InsertContextPackInput
): StoredContextPack {
  const id = input.id ?? ulid();
  const userId = requireNonEmptyString(input.userId, "userId");
  const agentId = requireNonEmptyString(input.agentId, "agentId");
  const task = requireNonEmptyString(input.task, "task");
  const cacheKey = requireNonEmptyString(input.cacheKey, "cacheKey");

  return withDbError(`inserting context pack '${id}'`, () =>
    db.transaction(() => {
      db.prepare(
        `INSERT INTO context_packs (
           id, user_id, agent_id, project_id, session_id, task,
           token_budget, estimated_tokens, rendered_context,
           memory_generation, retrieval_ms, degraded,
           degraded_reasons_json, conflicts_json, cache_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        userId,
        agentId,
        input.projectId ?? null,
        input.sessionId ?? null,
        task,
        input.tokenBudget,
        input.estimatedTokens,
        input.renderedContext,
        input.memoryGeneration,
        input.retrievalMs,
        input.degradedReasons.length > 0 ? 1 : 0,
        JSON.stringify(input.degradedReasons),
        JSON.stringify(input.conflicts),
        cacheKey
      );

      const insertItem = db.prepare(
        `INSERT INTO context_pack_items (
           context_pack_id, memory_id, rank, score, reason,
           estimated_tokens, content_snapshot, provenance_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const item of input.items) {
        insertItem.run(
          id,
          item.memoryId,
          item.rank,
          item.score,
          item.reason,
          item.estimatedTokens,
          item.contentSnapshot,
          JSON.stringify(item.provenance)
        );
      }

      return loadContextPack(db, id);
    })()
  );
}

export function loadContextPack(
  db: Database,
  contextPackId: string
): StoredContextPack {
  const resolvedId = requireNonEmptyString(contextPackId, "contextPackId");

  return withDbError(`loading context pack '${resolvedId}'`, () => {
    const pack = requireRecord(
      db
        .prepare<[string], ContextPackRow>(
          `SELECT * FROM context_packs WHERE id = ?`
        )
        .get(resolvedId),
      `Context pack '${resolvedId}' was not found`
    );
    const items = db
      .prepare<[string], ContextPackItemRow>(
        `SELECT *
         FROM context_pack_items
         WHERE context_pack_id = ?
         ORDER BY rank`
      )
      .all(resolvedId);

    return { pack, items };
  });
}

export function findCachedContextPack(
  db: Database,
  cacheKey: string,
  memoryGeneration: number
): StoredContextPack | undefined {
  const resolvedCacheKey = requireNonEmptyString(cacheKey, "cacheKey");

  return withDbError(`loading cached context pack`, () => {
    const row = db
      .prepare<[string, number], { id: string }>(
        `SELECT id
         FROM context_packs
         WHERE cache_key = ?
           AND memory_generation = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(resolvedCacheKey, memoryGeneration);

    return row === undefined ? undefined : loadContextPack(db, row.id);
  });
}
