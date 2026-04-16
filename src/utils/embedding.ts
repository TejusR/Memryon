import type { Database } from "better-sqlite3";
import type { InferenceSession, Tensor } from "onnxruntime-node";

export type EmbedFn = (
  text: string,
  modelVersion: string
) => Promise<Float32Array>;

type OrtModule = typeof import("onnxruntime-node");

// ---------------------------------------------------------------------------
// ONNX session cache - one session per model version
// ---------------------------------------------------------------------------

const sessionCache = new Map<string, InferenceSession>();

async function loadOrtModule(): Promise<OrtModule> {
  try {
    return await import("onnxruntime-node");
  } catch {
    throw new Error(
      "onnxruntime-node is required for embedding generation. " +
        "Install it: npm install onnxruntime-node"
    );
  }
}

async function loadOnnxSession(modelPath: string): Promise<InferenceSession> {
  const existing = sessionCache.get(modelPath);
  if (existing !== undefined) {
    return existing;
  }

  const ort = await loadOrtModule();
  const session = await ort.InferenceSession.create(modelPath);
  sessionCache.set(modelPath, session);
  return session;
}

function requireFloatOutputTensor(
  results: Record<string, Tensor>
): { data: Float32Array; dims: [number, number, number] } {
  const outputTensor = results["last_hidden_state"] ?? results["output"];

  if (outputTensor === undefined) {
    throw new Error(
      "Embedding model output must expose 'last_hidden_state' or 'output'"
    );
  }

  if (!(outputTensor.data instanceof Float32Array)) {
    throw new Error("Embedding model output tensor must contain Float32 data");
  }

  const [, seqLen, hiddenSize] = outputTensor.dims;
  if (seqLen === undefined || hiddenSize === undefined) {
    throw new Error("Embedding model output tensor must be rank-3");
  }

  return {
    data: outputTensor.data,
    dims: [1, seqLen, hiddenSize],
  };
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

  const [ort, session] = await Promise.all([
    loadOrtModule(),
    loadOnnxSession(modelPath),
  ]);

  // Minimal tokenisation: byte-encode each character as a token id.
  // Replace with a proper tokenizer (e.g. @xenova/transformers) once available.
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const tokenIds = new BigInt64Array(
    [...normalized].map((ch) => BigInt(ch.codePointAt(0) ?? 0))
  );

  const feeds: Record<string, Tensor> = {
    input_ids: new ort.Tensor("int64", tokenIds, [1, tokenIds.length]),
  };

  const results = await session.run(feeds);
  const { data: raw, dims } = requireFloatOutputTensor(results);
  const [, seqLen, hiddenSize] = dims;
  const pooled = new Float32Array(hiddenSize);

  for (let s = 0; s < seqLen; s++) {
    for (let h = 0; h < hiddenSize; h++) {
      const current = pooled[h] ?? 0;
      const value = raw[s * hiddenSize + h] ?? 0;
      pooled[h] = current + value / seqLen;
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
  const {
    batchSize = 100,
    newModelVersion,
    embedFn = generateEmbedding,
  } = options;

  if (!newModelVersion) throw new Error("newModelVersion is required");
  if (batchSize <= 0) throw new Error("batchSize must be positive");

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

  const updates: Array<{ id: string; embedding: Buffer }> = [];

  for (const row of batch) {
    const vec = await embedFn(row.content, newModelVersion);
    updates.push({ id: row.id, embedding: Buffer.from(vec.buffer) });
  }

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
