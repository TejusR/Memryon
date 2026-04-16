import type { Database } from "../../db/connection.js";
import { searchStoreItems } from "../../db/queries/store-items.js";
import { StoreSearchArgsSchema } from "../schemas.js";
import {
  resolveStoreContext,
  toPublicStoreItem,
  type PublicStoreItem,
} from "./store-shared.js";
import type { JsonObject } from "../../utils/json.js";

export interface StoreSearchArgs {
  namespace_prefix: string[];
  user_id: string;
  agent_id: string;
  query?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  scope?: "agent" | "project" | "global" | undefined;
  project_id?: string | undefined;
  filter_json?: JsonObject | undefined;
}

export interface StoreSearchResult {
  items: Array<PublicStoreItem & { score: number | null }>;
}

/**
 * Searches LangGraph store items beneath a namespace prefix for the resolved visibility context.
 */
export function handleStoreSearch(
  db: Database,
  rawArgs: unknown
): StoreSearchResult {
  const args = StoreSearchArgsSchema.parse(rawArgs);
  const context = resolveStoreContext(db, {
    user_id: args.user_id,
    agent_id: args.agent_id,
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.project_id !== undefined ? { project_id: args.project_id } : {}),
  });
  const rows = searchStoreItems(db, {
    userId: context.userId,
    scope: context.scope,
    ownerId: context.ownerId,
    namespacePrefix: args.namespace_prefix,
    ...(args.query !== undefined ? { query: args.query } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.offset !== undefined ? { offset: args.offset } : {}),
    ...(args.filter_json !== undefined ? { filter: args.filter_json } : {}),
  });

  return {
    items: rows.map((row) => ({
      ...toPublicStoreItem(row),
      score: row.score,
    })),
  };
}
