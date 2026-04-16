import { ulid } from "ulid";
import type { Database } from "better-sqlite3";
import {
  AddAgentInputSchema,
  CreateProjectInputSchema,
  type AddAgentInput,
  type CreateProjectInput,
} from "../../mcp/schemas.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  created_at: string;
  archived_at: string | null;
}

export interface ProjectAgentRow {
  project_id: string;
  agent_id: string;
  role: "owner" | "contributor" | "readonly";
  joined_at: string;
}

// ---------------------------------------------------------------------------
// createProject
// ---------------------------------------------------------------------------

export function createProject(
  db: Database,
  input: CreateProjectInput
): ProjectRow {
  const parsed = CreateProjectInputSchema.parse(input);
  const id = ulid();

  db.prepare(
    `INSERT INTO projects (id, user_id, name, description)
     VALUES (?, ?, ?, ?)`
  ).run(id, parsed.userId, parsed.name, parsed.description);

  return db
    .prepare<[string], ProjectRow>(`SELECT * FROM projects WHERE id = ?`)
    .get(id) as ProjectRow;
}

// ---------------------------------------------------------------------------
// archiveProject
// ---------------------------------------------------------------------------

export function archiveProject(db: Database, projectId: string): boolean {
  if (!projectId) throw new Error("projectId is required");

  const result = db
    .prepare(
      `UPDATE projects
       SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
         AND archived_at IS NULL`
    )
    .run(projectId);

  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// getProject
// ---------------------------------------------------------------------------

export function getProject(
  db: Database,
  projectId: string
): ProjectRow | undefined {
  if (!projectId) throw new Error("projectId is required");

  return db
    .prepare<[string], ProjectRow>(`SELECT * FROM projects WHERE id = ?`)
    .get(projectId);
}

// ---------------------------------------------------------------------------
// addAgent
// ---------------------------------------------------------------------------

export function addAgent(db: Database, input: AddAgentInput): ProjectAgentRow {
  const parsed = AddAgentInputSchema.parse(input);

  db.prepare(
    `INSERT INTO project_agents (project_id, agent_id, role)
     VALUES (?, ?, ?)
     ON CONFLICT (project_id, agent_id) DO UPDATE SET role = excluded.role`
  ).run(parsed.projectId, parsed.agentId, parsed.role);

  return db
    .prepare<[string, string], ProjectAgentRow>(
      `SELECT * FROM project_agents WHERE project_id = ? AND agent_id = ?`
    )
    .get(parsed.projectId, parsed.agentId) as ProjectAgentRow;
}

// ---------------------------------------------------------------------------
// removeAgent
// ---------------------------------------------------------------------------

export function removeAgent(
  db: Database,
  projectId: string,
  agentId: string
): boolean {
  if (!projectId) throw new Error("projectId is required");
  if (!agentId) throw new Error("agentId is required");

  const result = db
    .prepare(
      `DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?`
    )
    .run(projectId, agentId);

  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// getProjectAgents
// ---------------------------------------------------------------------------

export function getProjectAgents(
  db: Database,
  projectId: string
): ProjectAgentRow[] {
  if (!projectId) throw new Error("projectId is required");

  return db
    .prepare<[string], ProjectAgentRow>(
      `SELECT * FROM project_agents WHERE project_id = ? ORDER BY joined_at ASC`
    )
    .all(projectId);
}

// ---------------------------------------------------------------------------
// isAgentMember
// ---------------------------------------------------------------------------

export function isAgentMember(
  db: Database,
  projectId: string,
  agentId: string
): boolean {
  if (!projectId) throw new Error("projectId is required");
  if (!agentId) throw new Error("agentId is required");

  const row = db
    .prepare<[string, string], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM project_agents
       WHERE project_id = ? AND agent_id = ?`
    )
    .get(projectId, agentId);

  return (row?.cnt ?? 0) > 0;
}
