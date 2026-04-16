import type { Database } from "../../db/connection.js";
import { promoteMemory } from "../../scope/promotion.js";

export interface PromoteArgs {
  memory_id: string;
  agent_id: string;
  new_scope: "project" | "global";
  project_id?: string;
}

export interface PromoteResult {
  status: "promoted";
  memory_id: string;
  new_scope: "project" | "global";
}

export function handlePromote(db: Database, args: PromoteArgs): PromoteResult {
  promoteMemory(db, {
    memoryId: args.memory_id,
    requestingAgentId: args.agent_id,
    newScope: args.new_scope,
    ...(args.project_id !== undefined ? { projectId: args.project_id } : {}),
  });

  return {
    status: "promoted",
    memory_id: args.memory_id,
    new_scope: args.new_scope,
  };
}
