import type { Database } from "../db/connection.js";
import {
  claimEmbeddingJobs,
  completeEmbeddingJob,
  failEmbeddingJob,
} from "../db/queries/embedding-jobs.js";
import { getMemoryById } from "../db/queries/memories.js";
import { logConflict } from "../db/queries/conflicts.js";
import { upsertMemoryVector } from "../retrieval/vector-index.js";
import {
  checkCrossScopeConflicts,
  checkIntraProjectConflicts,
} from "../scope/conflict-detection.js";
import { errorMessage } from "../utils/errors.js";
import {
  TransformersEmbeddingProvider,
  type EmbeddingProvider,
} from "../models/providers.js";

export interface EmbeddingWorkerResult {
  claimed: number;
  completed: number;
  failed: number;
}

function conflictExists(
  db: Database,
  memoryA: string,
  memoryB: string
): boolean {
  return (
    db
      .prepare<[string, string, string, string], { present: number }>(
        `SELECT 1 AS present
         FROM conflicts
         WHERE (memory_a = ? AND memory_b = ?)
            OR (memory_a = ? AND memory_b = ?)
         LIMIT 1`
      )
      .get(memoryA, memoryB, memoryB, memoryA) !== undefined
  );
}

function detectAndLogConflicts(db: Database, memoryId: string): void {
  const memory = getMemoryById(db, memoryId);
  if (memory === undefined || memory.scope !== "project") {
    return;
  }

  const candidates = [
    ...checkIntraProjectConflicts(db, memory),
    ...checkCrossScopeConflicts(db, memory),
  ];
  for (const candidate of candidates) {
    if (conflictExists(db, memory.id, candidate.existingMemoryId)) {
      continue;
    }
    logConflict(db, {
      memoryA: memory.id,
      memoryB: candidate.existingMemoryId,
      projectId: memory.project_id ?? undefined,
      conflictType: candidate.conflictType,
    });
  }
}

/**
 * Processes a bounded batch. Failures are recorded per memory and never stop
 * later jobs from being indexed.
 */
export async function processEmbeddingJobs(
  db: Database,
  provider: EmbeddingProvider,
  limit = 8
): Promise<EmbeddingWorkerResult> {
  const jobs = claimEmbeddingJobs(db, limit);
  let completed = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      const vector = await provider.embed(job.content);
      upsertMemoryVector(db, job.memory_id, vector, provider.modelVersion);
      detectAndLogConflicts(db, job.memory_id);
      completeEmbeddingJob(db, job.memory_id);
      completed += 1;
    } catch (error) {
      failEmbeddingJob(db, job.memory_id, errorMessage(error));
      failed += 1;
    }
  }

  return { claimed: jobs.length, completed, failed };
}

export interface EmbeddingWorkerHandle {
  stop(): void;
}

/**
 * Starts the serialized background indexer used by the stdio server.
 */
export function startEmbeddingWorker(
  db: Database,
  options: {
    provider?: EmbeddingProvider;
    intervalMs?: number;
    batchSize?: number;
  } = {}
): EmbeddingWorkerHandle {
  const provider = options.provider ?? new TransformersEmbeddingProvider();
  const intervalMs = options.intervalMs ?? 1_000;
  const batchSize = options.batchSize ?? 8;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      await processEmbeddingJobs(db, provider, batchSize);
    } catch {
      // Individual jobs record their own errors. A batch-level database failure
      // is retried on the next interval without taking down the MCP process.
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  void tick();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
