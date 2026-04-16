import type { Database } from "../../db/connection.js";
import { createProject } from "../../db/queries/projects.js";
import { addAgent } from "../../db/queries/projects.js";

export interface ProjectCreateArgs {
  name: string;
  description?: string;
  user_id: string;
  agent_id: string;
}

export interface ProjectCreateResult {
  project_id: string;
  status: "created";
}

export function handleProjectCreate(
  db: Database,
  args: ProjectCreateArgs
): ProjectCreateResult {
  const project = createProject(db, {
    userId: args.user_id,
    name: args.name,
    description: args.description ?? "",
  });

  // Auto-assign the requesting agent as owner.
  addAgent(db, {
    projectId: project.id,
    agentId: args.agent_id,
    role: "owner",
  });

  return { project_id: project.id, status: "created" };
}
