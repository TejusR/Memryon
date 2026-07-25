import type { Database } from "better-sqlite3";
import {
  EMBEDDING_DIMENSIONS,
  TransformersEmbeddingProvider,
} from "../models/providers.js";
import { upsertMemoryVector } from "../retrieval/vector-index.js";
import { ValidationError, withDbError } from "./errors.js";

export type EmbedFn = (
  text: string,
  modelVersion: string
) => Promise<Float32Array>;

const defaultEmbeddingProvider = new TransformersEmbeddingProvider();

/**
 * Generates an embedding through the pinned Transformers.js provider.
 *
 * modelVersion remains in the signature for backward compatibility with the
 * re-embedding API. The provider reports the actual pinned version used by the
 * background indexer.
 */
export async function generateEmbedding(
  text: string,
  _modelVersion: string
): Promise<Float32Array> {
  return defaultEmbeddingProvider.embed(text);
}

export interface ReembedOptions {
  batchSize?: number;
  newModelVersion: string;
  embedFn?: EmbedFn;
}

export interface ReembedResult {
  reembedded_count: number;
  remaining: number;
}

/**
 * Re-embeds active memories whose stored embedding model version is out of date.
 */
export async function reembedMemories(
  db: Database,
  options: ReembedOptions
): Promise<ReembedResult> {
  const {
    batchSize = 100,
    newModelVersion,
    embedFn = generateEmbedding,
  } = options;

  if (!newModelVersion) {
    throw new ValidationError("newModelVersion is required");
  }
  if (batchSize <= 0) {
    throw new ValidationError("batchSize must be positive");
  }

  const totalRow = withDbError("counting memories that need re-embedding", () =>
    db
      .prepare<[string], { cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM memories
         WHERE invalidated_at IS NULL
           AND valid_until IS NULL
           AND (embedding_model_version IS NULL OR embedding_model_version != ?)`
      )
      .get(newModelVersion)
  );

  const total = totalRow?.cnt ?? 0;
  if (total === 0) {
    return { reembedded_count: 0, remaining: 0 };
  }

  const batch = withDbError("loading memories for re-embedding", () =>
    db
      .prepare<[string, number], { id: string; content: string }>(
        `SELECT id, content FROM memories
         WHERE invalidated_at IS NULL
           AND valid_until IS NULL
           AND (embedding_model_version IS NULL OR embedding_model_version != ?)
         ORDER BY recorded_at ASC
         LIMIT ?`
      )
      .all(newModelVersion, batchSize)
  );

  const updates: Array<{ id: string; vector: Float32Array }> = [];
  for (const row of batch) {
    updates.push({
      id: row.id,
      vector: await embedFn(row.content, newModelVersion),
    });
  }

  withDbError("writing refreshed embeddings", () => {
    db.transaction(() => {
      const fallbackUpdate = db.prepare(
        `UPDATE memories
         SET embedding = ?, embedding_model_version = ?
         WHERE id = ?`
      );

      for (const { id, vector } of updates) {
        if (vector.length === EMBEDDING_DIMENSIONS) {
          upsertMemoryVector(db, id, vector, newModelVersion);
        } else {
          fallbackUpdate.run(
            Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
            newModelVersion,
            id
          );
        }
      }
    })();
  });

  return {
    reembedded_count: batch.length,
    remaining: Math.max(0, total - batch.length),
  };
}
