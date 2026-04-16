import type { Database } from "better-sqlite3";

export type EmbedFn = (text: string, modelVersion: string) => Promise<Float32Array>;

// ---------------------------------------------------------------------------
// ONNX session cache — one session per model version
// ---------------------------------------------------------------------------

// Typed loosely so the file compiles without onnxruntime-node in devDeps.
// At runtime the dynamic import resolves to the real package.
const sessionCache = new Map<string, unknown>();

async function loadOnnxSession(modelPath: string): Promise<unknown> {
  if (sessionCache.has(modelPath)) return sessionCache.get(modelPath)!;

  // Dynamic import so onnxruntime-node stays an optional peer dependency.
  // If not installed this throws a clear error at call time, not at load time.
  const ort = await import("onnxruntime-node").catch(() => {
    throw new Error(
      "onnxruntime-node is required for embedding generation. " +
        "Install it: npm install onnxruntime-node"
    );
  });

  // @ts-expect-error — ort is typed as unknown above
  const session = await ort.InferenceSession.create(modelPath);
  sessionCache.set(modelPath, session);
  return session;
}

// ---------------------------------------------------------------------------
// generateEmbedding
//
// Runs text through an ONNX sentence-embedding model and returns a Float32Array.
// Model path is resolved from MEMRYON_EMBEDDING_MODEL_PATH env var, falling
// back to ./models/<modelVersion>.onnx.
//
// Tracks modelVersion so callers can store it alongside the embedding blob.
// ---------------------------------------------------------------------------

export async function generateEmbedding(
  text: string,
  modelVersion: string
): Promise<Float32Array> {
  const modelPath =
    process.env.MEMRYON_EMBEDDING_MODEL_PATH ?? `./models/${modelVersion}.onnx`;

  const session = await loadOnnxSession(modelPath);

  const ort = await import("onnxruntime-node");

  // Minimal tokenisation: byte-encode each character as a token id.
  // Replace with a proper tokenizer (e.g. @xenova/transformers) once available.
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const tokenIds = new BigInt64Array(
    [...normalized].map((ch) => BigInt(ch.codePointAt(0) ?? 0))
  );

  // @ts-expect-error — session is typed as unknown above
  const feeds: Record<string, unknown> = {
    // @ts-expect-error — ort is typed as unknown above
    input_ids: new ort.Tensor("int64", tokenIds, [1, tokenIds.length]),
  };

  // @ts-expect-error — session is typed as unknown above
  const results = await session.run(feeds);

  // Expect the model to expose a "last_hidden_state" or "output" tensor.
  // @ts-expect-error — results is typed as unknown above
  const outputTensor = results["last_hidden_state"] ?? results["output"];

  // Mean-pool over the sequence dimension to produce a fixed-size vector.
  // @ts-expect-error — outputTensor is typed as unknown above
  const raw = outputTensor.data as Float32Array;
  // @ts-expect-error — outputTensor dims
  const [, seqLen, hiddenSize] = outputTensor.dims as number[];
  const pooled = new Float32Array(hiddenSize);

  for (let s = 0; s < seqLen; s++) {
    for (let h = 0; h < hiddenSize; h++) {
      pooled[h] += raw[s * hiddenSize + h] / seqLen;
    }
  }

  return pooled;
}

// ---------------------------------------------------------------------------
// reembedMemories
//
// Finds active memories whose embedding_model_version differs from
// newModelVersion and re-embeds them in batches.
//
// Skips archived / invalidated memories (only re-embeds on access, per spec).
// Idempotent: re-running with the same newModelVersion is a no-op.
//
// embedFn is injectable for testing; defaults to generateEmbedding.
// ---------------------------------------------------------------------------

export interface ReembedOptions {
  batchSize?: number;
  newModelVersion: string;
  embedFn?: EmbedFn;
}

export interface ReembedResult {
  reembedded_count: number;
  remaining: number;
}

export async function reembedMemories(
  db: Database,
  options: ReembedOptions
): Promise<ReembedResult> {
  const { batchSize = 100, newModelVersion, embedFn = generateEmbedding } = options;

  if (!newModelVersion) throw new Error("newModelVersion is required");
  if (batchSize <= 0) throw new Error("batchSize must be positive");

  // Count total that still need re-embedding before we start.
  const totalRow = db
    .prepare<[string], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM memories
       WHERE invalidated_at IS NULL
         AND valid_until IS NULL
         AND (embedding_model_version IS NULL OR embedding_model_version != ?)`
    )
    .get(newModelVersion);

  const total = totalRow?.cnt ?? 0;

  if (total === 0) {
    return { reembedded_count: 0, remaining: 0 };
  }

  // Fetch this batch.
  const batch = db
    .prepare<[string, number], { id: string; content: string }>(
      `SELECT id, content FROM memories
       WHERE invalidated_at IS NULL
         AND valid_until IS NULL
         AND (embedding_model_version IS NULL OR embedding_model_version != ?)
       ORDER BY recorded_at ASC
       LIMIT ?`
    )
    .all(newModelVersion, batchSize);

  // Generate embeddings outside the transaction (async).
  const updates: Array<{ id: string; embedding: Buffer }> = [];

  for (const row of batch) {
    const vec = await embedFn(row.content, newModelVersion);
    updates.push({ id: row.id, embedding: Buffer.from(vec.buffer) });
  }

  // Apply all updates atomically.
  const applyUpdates = db.transaction(() => {
    const stmt = db.prepare(
      `UPDATE memories
       SET embedding = ?, embedding_model_version = ?
       WHERE id = ?`
    );
    for (const { id, embedding } of updates) {
      stmt.run(embedding, newModelVersion, id);
    }
  });

  applyUpdates();

  return {
    reembedded_count: batch.length,
    remaining: Math.max(0, total - batch.length),
  };
}
