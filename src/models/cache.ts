import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  getModelCacheDir,
  getModelManifestPath,
} from "../config/paths.js";
import { errorMessage } from "../utils/errors.js";
import {
  TransformersEmbeddingProvider,
  TransformersReranker,
  type EmbeddingProvider,
  type Reranker,
} from "./providers.js";
import type { ProgressInfo } from "@huggingface/transformers";

export interface ModelManifest {
  version: 1;
  installed_at: string;
  cache_checksum: string;
  embedding: {
    model_id: string;
    revision: string;
    model_version: string;
  };
  reranker: {
    model_id: string;
    revision: string;
    model_version: string;
  };
}

export interface ModelStatus {
  installed: boolean;
  verified: boolean;
  cache_dir: string;
  manifest?: ModelManifest;
  error?: string;
}

export interface ModelInstallProgress {
  component: "embedding" | "reranker";
  status: ProgressInfo["status"];
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(absolute)));
    } else if (
      entry.isFile() &&
      absolute !== getModelManifestPath()
    ) {
      files.push(absolute);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

export async function checksumModelCache(
  cacheDir = getModelCacheDir()
): Promise<string> {
  const hash = createHash("sha256");
  const files = await listFilesRecursively(cacheDir);

  for (const file of files) {
    const relative = path.relative(cacheDir, file).replaceAll("\\", "/");
    hash.update(relative);
    for await (const chunk of createReadStream(file)) {
      hash.update(chunk as Buffer);
    }
  }

  return hash.digest("hex");
}

export async function installModels(options: {
  embeddingProvider?: EmbeddingProvider;
  reranker?: Reranker;
  onProgress?: (progress: ModelInstallProgress) => void;
} = {}): Promise<ModelManifest> {
  const cacheDir = getModelCacheDir();
  await mkdir(cacheDir, { recursive: true });

  const embedding =
    options.embeddingProvider ??
    new TransformersEmbeddingProvider({
      cacheDir,
      progressCallback: (progress) =>
        options.onProgress?.({
          component: "embedding",
          status: progress.status,
          ...("file" in progress ? { file: progress.file } : {}),
          ...("progress" in progress ? { progress: progress.progress } : {}),
          ...("loaded" in progress ? { loaded: progress.loaded } : {}),
          ...("total" in progress ? { total: progress.total } : {}),
        }),
    });
  const reranker =
    options.reranker ??
    new TransformersReranker({
      cacheDir,
      progressCallback: (progress) =>
        options.onProgress?.({
          component: "reranker",
          status: progress.status,
          ...("file" in progress ? { file: progress.file } : {}),
          ...("progress" in progress ? { progress: progress.progress } : {}),
          ...("loaded" in progress ? { loaded: progress.loaded } : {}),
          ...("total" in progress ? { total: progress.total } : {}),
        }),
    });

  await embedding.ensureReady();
  await reranker.ensureReady();

  const manifest: ModelManifest = {
    version: 1,
    installed_at: new Date().toISOString(),
    cache_checksum: await checksumModelCache(cacheDir),
    embedding: {
      model_id: embedding.modelId,
      revision: embedding.revision,
      model_version: embedding.modelVersion,
    },
    reranker: {
      model_id: reranker.modelId,
      revision: reranker.revision,
      model_version: reranker.modelVersion,
    },
  };

  await writeFile(
    getModelManifestPath(),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return manifest;
}

export async function getModelStatus(): Promise<ModelStatus> {
  const cacheDir = getModelCacheDir();
  const manifestPath = getModelManifestPath();

  try {
    if (!(await stat(manifestPath)).isFile()) {
      return { installed: false, verified: false, cache_dir: cacheDir };
    }
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as ModelManifest;
    const checksum = await checksumModelCache(cacheDir);
    return {
      installed: true,
      verified: checksum === manifest.cache_checksum,
      cache_dir: cacheDir,
      manifest,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { installed: false, verified: false, cache_dir: cacheDir };
    }
    return {
      installed: false,
      verified: false,
      cache_dir: cacheDir,
      error: errorMessage(error),
    };
  }
}
