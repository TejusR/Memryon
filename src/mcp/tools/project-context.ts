import type { Database } from "../../db/connection.js";
import { getProject, getProjectAgents, type ProjectRow, type ProjectAgentRow } from "../../db/queries/projects.js";
import { getValidMemories, type MemoryRow } from "../../db/queries/memories.js";
import { MemryonError } from "../../utils/errors.js";

export interface ProjectContextArgs {
  project_id: string;
  user_id: string;
}

export interface ProjectContextResult {
  project: ProjectRow;
  agents: ProjectAgentRow[];
  memory_count: number;
  recent_activity: Array<{ id: string; content: string; agent_id: string; recorded_at: string }>;
}

export function handleProjectContext(
  db: Database,
  args: ProjectContextArgs
): ProjectContextResult {
  const project = getProject(db, args.project_id);
  if (project === undefined) {
    throw new MemryonError(`Project '${args.project_id}' not found`);
  }

  const agents = getProjectAgents(db, args.project_id);

  const memories: MemoryRow[] = getValidMemories(
    db,
    { user_id: args.user_id, scope: "project", project_id: args.project_id },
    1000
  );

  const recent_activity = memories.slice(0, 5).map((m) => ({
    id: m.id,
    content: m.content.slice(0, 120),
    agent_id: m.agent_id,
    recorded_at: m.recorded_at,
  }));

  return {
    project,
    agents,
    memory_count: memories.length,
    recent_activity,
  };
}
