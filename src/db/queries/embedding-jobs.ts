import type { Database } from "better-sqlite3";
import {
  requireNonEmptyString,
  requireRecord,
  withDbError,
} from "../../utils/errors.js";

export type EmbeddingJobStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

export interface EmbeddingJobRow {
  memory_id: string;
  status: EmbeddingJobStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PendingEmbeddingJob extends EmbeddingJobRow {
  content: string;
}

export function getEmbeddingJob(
  db: Database,
  memoryId: string
): EmbeddingJobRow | undefined {
  const resolvedMemoryId = requireNonEmptyString(memoryId, "memoryId");
  return withDbError(`loading embedding job '${resolvedMemoryId}'`, () =>
    db
      .prepare<[string], EmbeddingJobRow>(
        `SELECT * FROM embedding_jobs WHERE memory_id = ?`
      )
      .get(resolvedMemoryId)
  );
}

/**
 * Claims pending work in one write transaction so only one worker embeds it.
 */
export function claimEmbeddingJobs(
  db: Database,
  limit: number
): PendingEmbeddingJob[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Embedding job limit must be a positive integer");
  }

  return withDbError("claiming embedding jobs", () =>
    db.transaction(() => {
      const rows = db
        .prepare<[number], PendingEmbeddingJob>(
          `SELECT j.*, m.content
           FROM embedding_jobs j
           JOIN memories m ON m.id = j.memory_id
           WHERE j.status IN ('PENDING', 'FAILED')
             AND j.attempts < 3
             AND m.invalidated_at IS NULL
             AND m.valid_until IS NULL
           ORDER BY j.updated_at ASC
           LIMIT ?`
        )
        .all(limit);

      const claim = db.prepare(
        `UPDATE embedding_jobs
         SET status = 'PROCESSING',
             attempts = attempts + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE memory_id = ?
           AND status IN ('PENDING', 'FAILED')`
      );

      const claimed: PendingEmbeddingJob[] = [];
      for (const row of rows) {
        if (claim.run(row.memory_id).changes > 0) {
          claimed.push({
            ...row,
            status: "PROCESSING",
            attempts: row.attempts + 1,
          });
        }
      }
      return claimed;
    })()
  );
}

export function completeEmbeddingJob(
  db: Database,
  memoryId: string
): EmbeddingJobRow {
  const resolvedMemoryId = requireNonEmptyString(memoryId, "memoryId");

  return withDbError(`completing embedding job '${resolvedMemoryId}'`, () => {
    db.prepare(
      `UPDATE embedding_jobs
       SET status = 'COMPLETED',
           last_error = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE memory_id = ?`
    ).run(resolvedMemoryId);

    return requireRecord(
      getEmbeddingJob(db, resolvedMemoryId),
      `Embedding job '${resolvedMemoryId}' was not found`
    );
  });
}

export function failEmbeddingJob(
  db: Database,
  memoryId: string,
  error: string
): EmbeddingJobRow {
  const resolvedMemoryId = requireNonEmptyString(memoryId, "memoryId");

  return withDbError(`failing embedding job '${resolvedMemoryId}'`, () => {
    db.prepare(
      `UPDATE embedding_jobs
       SET status = 'FAILED',
           last_error = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE memory_id = ?`
    ).run(error.slice(0, 2_000), resolvedMemoryId);

    return requireRecord(
      getEmbeddingJob(db, resolvedMemoryId),
      `Embedding job '${resolvedMemoryId}' was not found`
    );
  });
}
