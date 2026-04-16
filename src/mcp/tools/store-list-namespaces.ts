import type { Database } from "../../db/connection.js";
import { listStoreNamespaces } from "../../db/queries/store-items.js";
import { StoreListNamespacesArgsSchema } from "../schemas.js";
import { resolveStoreContext } from "./store-shared.js";

export interface StoreListNamespacesArgs {
  prefix?: string[] | undefined;
  suffix?: string[] | undefined;
  user_id: string;
  agent_id: string;
  max_depth?: number | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  scope?: "agent" | "project" | "global" | undefined;
  project_id?: string | undefined;
}

export interface StoreListNamespacesResult {
  namespaces: string[][];
}

/**
 * Lists distinct visible namespaces for the resolved LangGraph store context.
 */
export function handleStoreListNamespaces(
  db: Database,
  rawArgs: unknown
): StoreListNamespacesResult {
  const args = StoreListNamespacesArgsSchema.parse(rawArgs);
  const context = resolveStoreContext(db, {
    user_id: args.user_id,
    agent_id: args.agent_id,
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.project_id !== undefined ? { project_id: args.project_id } : {}),
  });

  return {
    namespaces: listStoreNamespaces(db, {
      userId: context.userId,
      scope: context.scope,
      ownerId: context.ownerId,
      ...(args.prefix !== undefined ? { prefix: args.prefix } : {}),
      ...(args.suffix !== undefined ? { suffix: args.suffix } : {}),
      ...(args.max_depth !== undefined ? { maxDepth: args.max_depth } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
    }),
  };
}
