import { ulid } from "ulid";
import type { Database } from "better-sqlite3";
import {
  AddAgentInputSchema,
  CreateProjectInputSchema,
  type AddAgentInput,
  type CreateProjectInput,
} from "../../mcp/schemas.js";
import {
  requireNonEmptyString,
  requireRecord,
  withDbError,
} from "../../utils/errors.js";

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

/**
 * Creates a project row and returns the persisted record.
 */
export function createProject(
  db: Database,
  input: CreateProjectInput
): ProjectRow {
  const parsed = CreateProjectInputSchema.parse(input);
  const id = ulid();

  return withDbError(`creating project '${parsed.name}'`, () => {
    db.prepare(
      `INSERT INTO projects (id, user_id, name, description)
       VALUES (?, ?, ?, ?)`
    ).run(id, parsed.userId, parsed.name, parsed.description);

    return requireRecord(
      db
        .prepare<[string], ProjectRow>(`SELECT * FROM projects WHERE id = ?`)
        .get(id),
      `Project '${id}' was not found after creation`
    );
  });
}

// ---------------------------------------------------------------------------
// archiveProject
// ---------------------------------------------------------------------------

/**
 * Archives a project if it is still active.
 */
export function archiveProject(db: Database, projectId: string): boolean {
  const resolvedProjectId = requireNonEmptyString(projectId, "projectId");

  return withDbError(`archiving project '${resolvedProjectId}'`, () => {
    const result = db
      .prepare(
        `UPDATE projects
         SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?
           AND archived_at IS NULL`
      )
      .run(resolvedProjectId);

    return result.changes > 0;
  });
}

// ---------------------------------------------------------------------------
// getProject
// ---------------------------------------------------------------------------

/**
 * Loads a project by identifier.
 */
export function getProject(
  db: Database,
  projectId: string
): ProjectRow | undefined {
  const resolvedProjectId = requireNonEmptyString(projectId, "projectId");

  return withDbError(`loading project '${resolvedProjectId}'`, () =>
    db
      .prepare<[string], ProjectRow>(`SELECT * FROM projects WHERE id = ?`)
      .get(resolvedProjectId)
  );
}

// ---------------------------------------------------------------------------
// addAgent
// ---------------------------------------------------------------------------

/**
 * Adds or updates a project membership row for an agent.
 */
export function addAgent(db: Database, input: AddAgentInput): ProjectAgentRow {
  const parsed = AddAgentInputSchema.parse(input);

  return withDbError(
    `adding agent '${parsed.agentId}' to project '${parsed.projectId}'`,
    () => {
      db.prepare(
        `INSERT INTO project_agents (project_id, agent_id, role)
         VALUES (?, ?, ?)
         ON CONFLICT (project_id, agent_id) DO UPDATE SET role = excluded.role`
      ).run(parsed.projectId, parsed.agentId, parsed.role);

      return requireRecord(
        db
          .prepare<[string, string], ProjectAgentRow>(
            `SELECT * FROM project_agents WHERE project_id = ? AND agent_id = ?`
          )
          .get(parsed.projectId, parsed.agentId),
        `Membership for agent '${parsed.agentId}' in project '${parsed.projectId}' was not found`
      );
    }
  );
}

// ---------------------------------------------------------------------------
// removeAgent
// ---------------------------------------------------------------------------

/**
 * Removes an agent from a project membership list.
 */
export function removeAgent(
  db: Database,
  projectId: string,
  agentId: string
): boolean {
  const resolvedProjectId = requireNonEmptyString(projectId, "projectId");
  const resolvedAgentId = requireNonEmptyString(agentId, "agentId");

  return withDbError(
    `removing agent '${resolvedAgentId}' from project '${resolvedProjectId}'`,
    () => {
      const result = db
        .prepare(
          `DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?`
        )
        .run(resolvedProjectId, resolvedAgentId);

      return result.changes > 0;
    }
  );
}

// ---------------------------------------------------------------------------
// getProjectAgents
// ---------------------------------------------------------------------------

/**
 * Lists all agents assigned to a project in join order.
 */
export function getProjectAgents(
  db: Database,
  projectId: string
): ProjectAgentRow[] {
  const resolvedProjectId = requireNonEmptyString(projectId, "projectId");

  return withDbError(`listing agents for project '${resolvedProjectId}'`, () =>
    db
      .prepare<[string], ProjectAgentRow>(
        `SELECT * FROM project_agents WHERE project_id = ? ORDER BY joined_at ASC`
      )
      .all(resolvedProjectId)
  );
}

// ---------------------------------------------------------------------------
// isAgentMember
// ---------------------------------------------------------------------------

/**
 * Returns true when an agent currently belongs to the supplied project.
 */
export function isAgentMember(
  db: Database,
  projectId: string,
  agentId: string
): boolean {
  const resolvedProjectId = requireNonEmptyString(projectId, "projectId");
  const resolvedAgentId = requireNonEmptyString(agentId, "agentId");

  return withDbError(
    `checking membership for agent '${resolvedAgentId}' in project '${resolvedProjectId}'`,
    () => {
      const row = db
        .prepare<[string, string], { cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM project_agents
           WHERE project_id = ? AND agent_id = ?`
        )
        .get(resolvedProjectId, resolvedAgentId);

      return (row?.cnt ?? 0) > 0;
    }
  );
}
