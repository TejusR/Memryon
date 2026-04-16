import type { Database } from "../../db/connection.js";
import { getCurrentStoreItem } from "../../db/queries/store-items.js";
import { StoreGetArgsSchema } from "../schemas.js";
import {
  resolveStoreContext,
  toPublicStoreItem,
  type PublicStoreItem,
} from "./store-shared.js";

export interface StoreGetArgs {
  namespace: string[];
  key: string;
  user_id: string;
  agent_id: string;
  scope?: "agent" | "project" | "global" | undefined;
  project_id?: string | undefined;
}

export interface StoreGetResult {
  item: PublicStoreItem | null;
}

export function handleStoreGet(
  db: Database,
  rawArgs: unknown
): StoreGetResult {
  const args = StoreGetArgsSchema.parse(rawArgs);
  const context = resolveStoreContext(db, {
    user_id: args.user_id,
    agent_id: args.agent_id,
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.project_id !== undefined ? { project_id: args.project_id } : {}),
  });
  const row = getCurrentStoreItem(db, {
    userId: context.userId,
    scope: context.scope,
    ownerId: context.ownerId,
    namespace: args.namespace,
    key: args.key,
  });

  return {
    item: row === undefined ? null : toPublicStoreItem(row),
  };
}
