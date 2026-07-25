import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  pipeline,
  type ProgressCallback,
} from "@huggingface/transformers";
import { getModelCacheDir } from "../config/paths.js";
import { MemryonError, errorMessage } from "../utils/errors.js";

export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_MODEL_ID =
  "onnx-community/all-MiniLM-L6-v2-ONNX";
export const EMBEDDING_MODEL_REVISION =
  "aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f";
export const RERANKER_MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";
export const RERANKER_MODEL_REVISION =
  "a09144355adeed5f58c8ed011d209bf8ee5a1fec";

export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly modelId: string;
  readonly revision: string;
  readonly modelVersion: string;
  ensureReady(): Promise<void>;
  embed(text: string): Promise<Float32Array>;
}

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankedCandidate {
  id: string;
  score: number;
}

export interface Reranker {
  readonly modelId: string;
  readonly revision: string;
  readonly modelVersion: string;
  ensureReady(): Promise<void>;
  rerank(
    query: string,
    candidates: readonly RerankCandidate[]
  ): Promise<RerankedCandidate[]>;
}

export interface TransformersProviderOptions {
  cacheDir?: string;
  localFilesOnly?: boolean;
  progressCallback?: ProgressCallback;
}

interface TensorLike {
  data: Float32Array;
  dims: number[];
}

type FeatureExtractor = (
  text: string,
  options: { pooling: "mean"; normalize: true }
) => Promise<TensorLike>;

function isTensorLike(value: unknown): value is TensorLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record["data"] instanceof Float32Array &&
    Array.isArray(record["dims"]) &&
    record["dims"].every((dimension) => typeof dimension === "number")
  );
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly modelId = EMBEDDING_MODEL_ID;
  readonly revision = EMBEDDING_MODEL_REVISION;
  readonly modelVersion =
    `${EMBEDDING_MODEL_ID}@${EMBEDDING_MODEL_REVISION}:q8`;

  private readonly cacheDir: string;
  private readonly localFilesOnly: boolean;
  private readonly progressCallback: ProgressCallback | undefined;
  private extractorPromise: Promise<FeatureExtractor> | undefined;

  constructor(options: TransformersProviderOptions = {}) {
    this.cacheDir = options.cacheDir ?? getModelCacheDir();
    this.localFilesOnly = options.localFilesOnly ?? false;
    this.progressCallback = options.progressCallback;
  }

  async ensureReady(): Promise<void> {
    await this.getExtractor();
  }

  async embed(text: string): Promise<Float32Array> {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) {
      throw new MemryonError("Cannot embed empty text");
    }

    try {
      const extractor = await this.getExtractor();
      const output = await extractor(normalized, {
        pooling: "mean",
        normalize: true,
      });
      if (
        !isTensorLike(output) ||
        output.data.length !== EMBEDDING_DIMENSIONS
      ) {
        throw new MemryonError(
          `Embedding model returned ${output.data.length} dimensions; expected ${EMBEDDING_DIMENSIONS}`
        );
      }
      return new Float32Array(output.data);
    } catch (error) {
      throw new MemryonError(
        `Embedding model failed: ${errorMessage(error)}`
      );
    }
  }

  private getExtractor(): Promise<FeatureExtractor> {
    if (this.extractorPromise === undefined) {
      const loading = pipeline("feature-extraction", this.modelId, {
        cache_dir: this.cacheDir,
        revision: this.revision,
        local_files_only: this.localFilesOnly,
        dtype: "q8",
        ...(this.progressCallback !== undefined
          ? { progress_callback: this.progressCallback }
          : {}),
      }).then((loaded) => loaded as unknown as FeatureExtractor);
      this.extractorPromise = loading.catch((error: unknown) => {
        this.extractorPromise = undefined;
        throw error;
      });
    }

    return this.extractorPromise;
  }
}

interface RerankerRuntime {
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  model: Awaited<
    ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>
  >;
}

export class TransformersReranker implements Reranker {
  readonly modelId = RERANKER_MODEL_ID;
  readonly revision = RERANKER_MODEL_REVISION;
  readonly modelVersion =
    `${RERANKER_MODEL_ID}@${RERANKER_MODEL_REVISION}:q8`;

  private readonly cacheDir: string;
  private readonly localFilesOnly: boolean;
  private readonly progressCallback: ProgressCallback | undefined;
  private runtimePromise: Promise<RerankerRuntime> | undefined;

  constructor(options: TransformersProviderOptions = {}) {
    this.cacheDir = options.cacheDir ?? getModelCacheDir();
    this.localFilesOnly = options.localFilesOnly ?? false;
    this.progressCallback = options.progressCallback;
  }

  async ensureReady(): Promise<void> {
    await this.getRuntime();
  }

  async rerank(
    query: string,
    candidates: readonly RerankCandidate[]
  ): Promise<RerankedCandidate[]> {
    if (candidates.length === 0) {
      return [];
    }

    try {
      const { tokenizer, model } = await this.getRuntime();
      const queries = candidates.map(() => query);
      const passages = candidates.map((candidate) => candidate.text);
      const features = tokenizer(queries, {
        text_pair: passages,
        padding: true,
        truncation: true,
      });
      const rawOutput: unknown = await model(features);
      if (typeof rawOutput !== "object" || rawOutput === null) {
        throw new MemryonError("Reranker returned no output");
      }

      const logits = (rawOutput as Record<string, unknown>)["logits"];
      if (!isTensorLike(logits) || logits.data.length < candidates.length) {
        throw new MemryonError("Reranker returned an invalid logits tensor");
      }

      return candidates
        .map((candidate, index) => ({
          id: candidate.id,
          score: logits.data[index] ?? Number.NEGATIVE_INFINITY,
        }))
        .sort((left, right) => right.score - left.score);
    } catch (error) {
      throw new MemryonError(`Reranker failed: ${errorMessage(error)}`);
    }
  }

  private getRuntime(): Promise<RerankerRuntime> {
    if (this.runtimePromise === undefined) {
      const loading = Promise.all([
        AutoTokenizer.from_pretrained(this.modelId, {
          cache_dir: this.cacheDir,
          revision: this.revision,
          local_files_only: this.localFilesOnly,
          ...(this.progressCallback !== undefined
            ? { progress_callback: this.progressCallback }
            : {}),
        }),
        AutoModelForSequenceClassification.from_pretrained(this.modelId, {
          cache_dir: this.cacheDir,
          revision: this.revision,
          local_files_only: this.localFilesOnly,
          dtype: "q8",
          ...(this.progressCallback !== undefined
            ? { progress_callback: this.progressCallback }
            : {}),
        }),
      ]).then(([tokenizer, model]) => ({ tokenizer, model }));
      this.runtimePromise = loading.catch((error: unknown) => {
        this.runtimePromise = undefined;
        throw error;
      });
    }

    return this.runtimePromise;
  }
}
