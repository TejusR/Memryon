import type { Database } from "../../db/connection.js";
import { invalidateMemory } from "../../db/queries/memories.js";
import {
  getCurrentStoreItem,
  retireStoreItem,
} from "../../db/queries/store-items.js";
import { StoreDeleteArgsSchema } from "../schemas.js";
import { resolveStoreContext } from "./store-shared.js";

export interface StoreDeleteArgs {
  namespace: string[];
  key: string;
  user_id: string;
  agent_id: string;
  scope?: "agent" | "project" | "global" | undefined;
  project_id?: string | undefined;
}

export interface StoreDeleteResult {
  status: "deleted" | "not_found";
  key: string;
  namespace: string[];
  memcell_id?: string;
}

export function handleStoreDelete(
  db: Database,
  rawArgs: unknown
): StoreDeleteResult {
  const args = StoreDeleteArgsSchema.parse(rawArgs);
  const context = resolveStoreContext(db, {
    user_id: args.user_id,
    agent_id: args.agent_id,
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.project_id !== undefined ? { project_id: args.project_id } : {}),
  });

  return db.transaction(() => {
    const existing = getCurrentStoreItem(db, {
      userId: context.userId,
      scope: context.scope,
      ownerId: context.ownerId,
      namespace: args.namespace,
      key: args.key,
    });

    if (existing === undefined) {
      return {
        status: "not_found",
        key: args.key,
        namespace: args.namespace,
      } satisfies StoreDeleteResult;
    }

    if (!retireStoreItem(db, existing.id)) {
      throw new Error(`Failed to retire store item '${existing.id}'`);
    }
    if (!invalidateMemory(db, existing.memory_id, context.agentId)) {
      throw new Error(`Failed to invalidate memory '${existing.memory_id}'`);
    }

    return {
      status: "deleted" as const,
      key: args.key,
      namespace: args.namespace,
      memcell_id: existing.memory_id,
    } satisfies StoreDeleteResult;
  })();
}
