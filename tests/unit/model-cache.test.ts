import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  getModelStatus,
  installModels,
} from "../../src/models/cache.js";
import type {
  EmbeddingProvider,
  Reranker,
} from "../../src/models/providers.js";

let cacheDir: string;
let previousCache: string | undefined;

const embedding: EmbeddingProvider = {
  dimensions: 384,
  modelId: "fake-embedding",
  revision: "fixture",
  modelVersion: "fake-embedding@fixture",
  async ensureReady() {},
  async embed() {
    return new Float32Array(384);
  },
};

const reranker: Reranker = {
  modelId: "fake-reranker",
  revision: "fixture",
  modelVersion: "fake-reranker@fixture",
  async ensureReady() {},
  async rerank() {
    return [];
  },
};

beforeEach(async () => {
  previousCache = process.env["MEMRYON_MODEL_CACHE"];
  cacheDir = await mkdtemp(path.join(process.cwd(), ".tmp-model-cache-"));
  process.env["MEMRYON_MODEL_CACHE"] = cacheDir;
});

afterEach(async () => {
  if (previousCache === undefined) {
    delete process.env["MEMRYON_MODEL_CACHE"];
  } else {
    process.env["MEMRYON_MODEL_CACHE"] = previousCache;
  }
  await rm(cacheDir, { recursive: true, force: true });
});

describe("model cache manifest", () => {
  it("installs through injectable providers and detects cache tampering", async () => {
    const manifest = await installModels({
      embeddingProvider: embedding,
      reranker,
    });
    const installed = await getModelStatus();

    expect(manifest.embedding.model_version).toBe(
      embedding.modelVersion
    );
    expect(manifest.reranker.model_version).toBe(reranker.modelVersion);
    expect(installed).toMatchObject({
      installed: true,
      verified: true,
      cache_dir: cacheDir,
    });

    await writeFile(
      path.join(cacheDir, "unexpected.bin"),
      Buffer.from([1, 2, 3])
    );
    expect((await getModelStatus()).verified).toBe(false);
  });
});
