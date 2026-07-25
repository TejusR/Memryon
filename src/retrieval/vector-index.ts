import type { Database } from "../db/connection.js";
import type { ScoredMemoryRow } from "../scope/fan-out.js";
import { ValidationError, withDbError } from "../utils/errors.js";
import { EMBEDDING_DIMENSIONS } from "../models/providers.js";

export interface VectorSearchResult {
  row: ScoredMemoryRow;
  distance: number;
  similarity: number;
}

function embeddingBuffer(vector: Float32Array): Buffer {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new ValidationError(
      `Expected a ${EMBEDDING_DIMENSIONS}-dimensional embedding, received ${vector.length}`
    );
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Replaces a memory's sqlite-vec row while preserving memories.rowid as key.
 */
export function upsertMemoryVector(
  db: Database,
  memoryId: string,
  vector: Float32Array,
  modelVersion: string
): void {
  const serialized = embeddingBuffer(vector);

  withDbError(`indexing vector for memory '${memoryId}'`, () => {
    db.transaction(() => {
      const memory = db
        .prepare<[string], { rowid: number }>(
          `SELECT rowid FROM memories WHERE id = ?`
        )
        .get(memoryId);
      if (memory === undefined) {
        throw new ValidationError(`Memory '${memoryId}' does not exist`);
      }

      const vectorRowId = BigInt(memory.rowid);
      db.prepare(`DELETE FROM memory_vectors WHERE rowid = ?`).run(vectorRowId);
      db.prepare(
        `INSERT INTO memory_vectors (rowid, embedding) VALUES (?, ?)`
      ).run(vectorRowId, serialized);
      db.prepare(
        `UPDATE memories
         SET embedding = ?, embedding_model_version = ?
         WHERE id = ?`
      ).run(serialized, modelVersion, memoryId);
    })();
  });
}

/**
 * Queries sqlite-vec globally, then intersects candidates with pre-resolved
 * visibility so private or stale rows can never cross the scope boundary.
 */
export function searchMemoryVectors(
  db: Database,
  queryVector: Float32Array,
  visibleRows: readonly ScoredMemoryRow[],
  limit: number
): VectorSearchResult[] {
  if (visibleRows.length === 0 || limit < 1) {
    return [];
  }

  const visibleByRowId = new Map<number, ScoredMemoryRow>();
  const memoryIds = visibleRows.map((row) => row.id);
  const placeholders = memoryIds.map(() => "?").join(", ");
  const rowIds = withDbError("resolving visible memory row identifiers", () =>
    db
      .prepare<unknown[], { rowid: number; id: string }>(
        `SELECT rowid, id
         FROM memories
         WHERE id IN (${placeholders})`
      )
      .all(...memoryIds)
  );
  const visibleById = new Map(visibleRows.map((row) => [row.id, row]));
  for (const row of rowIds) {
    const visible = visibleById.get(row.id);
    if (visible !== undefined) {
      visibleByRowId.set(row.rowid, visible);
    }
  }

  const visibleRowIds = [...visibleByRowId.keys()];
  const nearest = withDbError("searching the vector index", () =>
    db
      .prepare<[Buffer, string, number], { rowid: number; distance: number }>(
        `SELECT vectors.rowid,
                vec_distance_cosine(vectors.embedding, ?) AS distance
         FROM memory_vectors AS vectors
         JOIN json_each(?) AS visible
           ON vectors.rowid = visible.value
         ORDER BY distance
         LIMIT ?`
      )
      .all(
        embeddingBuffer(queryVector),
        JSON.stringify(visibleRowIds),
        limit
      )
  );

  const results: VectorSearchResult[] = [];
  for (const match of nearest) {
    const row = visibleByRowId.get(match.rowid);
    if (row === undefined) {
      continue;
    }
    results.push({
      row,
      distance: match.distance,
      similarity: 1 - match.distance,
    });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}
