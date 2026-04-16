import type { Database } from "../../db/connection.js";
import { addAgent } from "../../db/queries/projects.js";

export interface ProjectJoinArgs {
  project_id: string;
  agent_id: string;
  role?: "owner" | "contributor" | "readonly";
}

export interface ProjectJoinResult {
  status: "joined";
  role: "owner" | "contributor" | "readonly";
}

export function handleProjectJoin(
  db: Database,
  args: ProjectJoinArgs
): ProjectJoinResult {
  const membership = addAgent(db, {
    projectId: args.project_id,
    agentId: args.agent_id,
    role: args.role ?? "contributor",
  });

  return { status: "joined", role: membership.role };
}
