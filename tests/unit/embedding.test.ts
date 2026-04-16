import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { reembedMemories, type EmbedFn } from "../../src/utils/embedding.js";

const DB = ":memory:";
const USER = "user-embed";
const AGENT = "agent-embed";

let db: ReturnType<typeof getDb>;

function seedAgent() {
  registerAgent(db, { agentId: AGENT, displayName: AGENT, trustTier: 2, capabilities: [] });
}

function insertMemoryRaw(opts: {
  content?: string;
  embeddingModelVersion?: string | null;
  hasEmbedding?: boolean;
}): string {
  const id = `mem-${Math.random().toString(36).slice(2)}`;
  const content = opts.content ?? "test content";
  const modelVersion = opts.embeddingModelVersion ?? null;

  // Use a minimal 4-byte embedding blob when requested.
  const embeddingBlob = opts.hasEmbedding
    ? Buffer.from(new Float32Array([1.0]).buffer)
    : null;

  db.prepare(
    `INSERT INTO memories
       (id, user_id, scope, agent_id, content, content_type, tags,
        valid_from, recorded_at, confidence, importance, source_type,
        embedding, embedding_model_version)
     VALUES (?, ?, 'global', ?, ?, 'text/plain', '[]',
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             1.0, 0.5, 'manual', ?, ?)`
  ).run(id, USER, AGENT, content, embeddingBlob, modelVersion);

  return id;
}

function getModelVersion(id: string): string | null {
  return db
    .prepare<[string], { embedding_model_version: string | null }>(
      `SELECT embedding_model_version FROM memories WHERE id = ?`
    )
    .get(id)?.embedding_model_version ?? null;
}

function getEmbeddingBlob(id: string): Buffer | null {
  return (
    db
      .prepare<[string], { embedding: Buffer | null }>(
        `SELECT embedding FROM memories WHERE id = ?`
      )
      .get(id)?.embedding ?? null
  );
}

// A deterministic mock embedFn: returns a 4-element Float32Array based on content.
const mockEmbedFn: EmbedFn = async (text, _modelVersion) => {
  return new Float32Array([text.length, text.charCodeAt(0) ?? 0, 0.5, 1.0]);
};

beforeEach(() => {
  db = getDb(DB);
  seedAgent();
});

afterEach(() => {
  closeDb(DB);
});

// ---------------------------------------------------------------------------
// reembedMemories — core behaviour
// ---------------------------------------------------------------------------

describe("reembedMemories", () => {
  it("updates embedding and embedding_model_version for a memory with no current version", async () => {
    const id = insertMemoryRaw({ content: "hello world", embeddingModelVersion: null });

    const result = await reembedMemories(db, {
      newModelVersion: "v2",
      embedFn: mockEmbedFn,
    });

    expect(result.reembedded_count).toBe(1);
    expect(result.remaining).toBe(0);
    expect(getModelVersion(id)).toBe("v2");
    expect(getEmbeddingBlob(id)).not.toBeNull();
  });

  it("updates a memory with an outdated model version", async () => {
    const id = insertMemoryRaw({ embeddingModelVersion: "v1", hasEmbedding: true });

    const result = await reembedMemories(db, {
      newModelVersion: "v2",
      embedFn: mockEmbedFn,
    });

    expect(result.reembedded_count).toBe(1);
    expect(getModelVersion(id)).toBe("v2");
  });

  it("skips memories that are already on the current model version", async () => {
    const id = insertMemoryRaw({ embeddingModelVersion: "v2", hasEmbedding: true });

    const result = await reembedMemories(db, {
      newModelVersion: "v2",
      embedFn: mockEmbedFn,
    });

    expect(result.reembedded_count).toBe(0);
    expect(result.remaining).toBe(0);

    // Embedding blob should be unchanged — mock was never called for this memory.
    const blob = getEmbeddingBlob(id);
    expect(blob?.length).toBe(4); // original 1-element Float32Array = 4 bytes
  });

  it("skips invalidated (archived) memories", async () => {
    const id = insertMemoryRaw({ embeddingModelVersion: "v1" });
    db.prepare(
      `UPDATE memories SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    ).run(id);

    const result = await reembedMemories(db, {
      newModelVersion: "v2",
      embedFn: mockEmbedFn,
    });

    expect(result.reembedded_count).toBe(0);
    expect(getModelVersion(id)).toBe("v1"); // unchanged
  });

  it("skips memories where valid_until is set", async () => {
    const id = insertMemoryRaw({ embeddingModelVersion: "v1" });
    db.prepare(
      `UPDATE memories SET valid_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    ).run(id);

    const result = await reembedMemories(db, {
      newModelVersion: "v2",
      embedFn: mockEmbedFn,
    });

    expect(result.reembedded_count).toBe(0);
    expect(getModelVersion(id)).toBe("v1");
  });
});

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

describe("reembedMemories batching", () => {
  it("respects batchSize and reports remaining correctly", async () => {
    for (let i = 0; i < 5; i++) {
      insertMemoryRaw({ content: `memory ${i}`, embeddingModelVersion: "v1" });
    }

    const result = await reembedMemories(db, {
      newModelVersion: "v2",
      batchSize: 3,
      embedFn: mockEmbedFn,
    });

    expect(result.reembedded_count).toBe(3);
    expect(result.remaining).toBe(2);
  });

  it("returns remaining=0 when all memories fit within one batch", async () => {
    insertMemoryRaw({ embeddingModelVersion: "v1" });
    insertMemoryRaw({ embeddingModelVersion: "v1" });

    const result = await reembedMemories(db, {
      newModelVersion: "v2",
      batchSize: 100,
      embedFn: mockEmbedFn,
    });

    expect(result.reembedded_count).toBe(2);
    expect(result.remaining).toBe(0);
  });

  it("is idempotent — re-running with same version is a no-op", async () => {
    insertMemoryRaw({ embeddingModelVersion: "v1" });

    await reembedMemories(db, { newModelVersion: "v2", embedFn: mockEmbedFn });
    const embedFnSpy = vi.fn(mockEmbedFn);
    const result = await reembedMemories(db, { newModelVersion: "v2", embedFn: embedFnSpy });

    expect(embedFnSpy).not.toHaveBeenCalled();
    expect(result.reembedded_count).toBe(0);
    expect(result.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Embedding content
// ---------------------------------------------------------------------------

describe("reembedMemories embedding content", () => {
  it("stores the Float32Array returned by embedFn as a blob", async () => {
    const id = insertMemoryRaw({ content: "hello", embeddingModelVersion: null });

    await reembedMemories(db, { newModelVersion: "v2", embedFn: mockEmbedFn });

    const blob = getEmbeddingBlob(id);
    expect(blob).not.toBeNull();

    // The mock returns a 4-element Float32Array (16 bytes).
    const vec = new Float32Array(blob!.buffer, blob!.byteOffset, blob!.byteLength / 4);
    expect(vec.length).toBe(4);
    expect(vec[0]).toBe("hello".length); // content.length
  });

  it("calls embedFn with the memory content and new model version", async () => {
    const embedFnSpy = vi.fn(mockEmbedFn);
    insertMemoryRaw({ content: "important fact", embeddingModelVersion: null });

    await reembedMemories(db, { newModelVersion: "v3", embedFn: embedFnSpy });

    expect(embedFnSpy).toHaveBeenCalledWith("important fact", "v3");
  });
});
