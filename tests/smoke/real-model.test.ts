import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  TransformersEmbeddingProvider,
  TransformersReranker,
} from "../../src/models/providers.js";

const enabled = process.env["MEMRYON_REAL_MODEL_TEST"] === "1";

describe.skipIf(!enabled)("real local model smoke", () => {
  it(
    "loads the pinned models, embeds text, and reranks candidates",
    async () => {
      const embedding = new TransformersEmbeddingProvider();
      const reranker = new TransformersReranker();
      const vector = await embedding.embed("shared agent memory");
      const ranked = await reranker.rerank("database decision", [
        { id: "relevant", text: "Use SQLite for the database." },
        { id: "irrelevant", text: "The logo background is transparent." },
      ]);

      expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(ranked[0]?.id).toBe("relevant");
    },
    180_000
  );
});
