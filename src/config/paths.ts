import os from "node:os";
import path from "node:path";

export const DEFAULT_USER_ID = "local-user";

export function getMemryonDataDir(): string {
  const configured = process.env["MEMRYON_HOME"];
  if (configured !== undefined && configured.trim().length > 0) {
    return path.resolve(configured);
  }

  if (process.platform === "win32") {
    const base = process.env["LOCALAPPDATA"] ?? process.env["APPDATA"];
    return path.join(base ?? os.homedir(), "Memryon");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Memryon");
  }

  return path.join(
    process.env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share"),
    "memryon"
  );
}

export function getDefaultDbPath(): string {
  return process.env["MEMRYON_DB_PATH"] ?? path.join(getMemryonDataDir(), "memryon.db");
}

export function getModelCacheDir(): string {
  return process.env["MEMRYON_MODEL_CACHE"] ?? path.join(getMemryonDataDir(), "models");
}

export function getModelManifestPath(): string {
  return path.join(getModelCacheDir(), "manifest.json");
}
