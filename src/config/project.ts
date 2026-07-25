import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "../db/connection.js";
import { registerAgent } from "../db/queries/agents.js";
import {
  addAgent,
  createProject,
  getProject,
  isAgentMember,
} from "../db/queries/projects.js";
import { DEFAULT_USER_ID } from "./paths.js";

export const INTEGRATION_AGENT_IDS = {
  "claude-code": "claude-code",
  codex: "codex",
  openclaw: "openclaw",
  hermes: "hermes",
} as const;

export type IntegrationName = keyof typeof INTEGRATION_AGENT_IDS;

export interface ProjectConfig {
  version: 1;
  project_id: string;
  user_id: string;
  name: string;
  created_at: string;
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".memryon", "project.json");
}

export async function readProjectConfig(
  projectRoot = process.cwd()
): Promise<ProjectConfig | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(projectConfigPath(projectRoot), "utf8")
    );
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const value = parsed as Record<string, unknown>;
    if (
      value["version"] !== 1 ||
      typeof value["project_id"] !== "string" ||
      typeof value["user_id"] !== "string" ||
      typeof value["name"] !== "string" ||
      typeof value["created_at"] !== "string"
    ) {
      return undefined;
    }
    return value as unknown as ProjectConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function findProjectRoot(
  startingDirectory = process.cwd()
): Promise<string | undefined> {
  let current = path.resolve(startingDirectory);
  while (true) {
    if ((await readProjectConfig(current)) !== undefined) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function ensureIntegrationAgents(db: Database, projectId: string): void {
  for (const [framework, agentId] of Object.entries(INTEGRATION_AGENT_IDS)) {
    registerAgent(db, {
      agentId,
      displayName: framework,
      trustTier: 2,
      capabilities: ["prepare_context", "record_handoff"],
    });
    if (!isAgentMember(db, projectId, agentId)) {
      addAgent(db, {
        projectId,
        agentId,
        role: framework === "claude-code" ? "owner" : "contributor",
      });
    }
  }
}

/**
 * Creates or repairs the stable repository-to-database project mapping.
 */
export async function initializeProject(
  db: Database,
  projectRoot = process.cwd(),
  userId = DEFAULT_USER_ID
): Promise<ProjectConfig> {
  const root = path.resolve(projectRoot);
  const existing = await readProjectConfig(root);
  if (existing !== undefined && getProject(db, existing.project_id) !== undefined) {
    ensureIntegrationAgents(db, existing.project_id);
    return existing;
  }

  const name = path.basename(root);
  const project = createProject(db, {
    userId: existing?.user_id ?? userId,
    name: existing?.name ?? name,
    description: `Memryon project brain for ${name}`,
  });
  const config: ProjectConfig = {
    version: 1,
    project_id: project.id,
    user_id: project.user_id,
    name: project.name,
    created_at: new Date().toISOString(),
  };
  await mkdir(path.dirname(projectConfigPath(root)), { recursive: true });
  await writeFile(
    projectConfigPath(root),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8"
  );
  ensureIntegrationAgents(db, config.project_id);
  return config;
}
