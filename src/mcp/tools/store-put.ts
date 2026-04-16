import type { Database } from "../../db/connection.js";
import { invalidateMemory } from "../../db/queries/memories.js";
import {
  getCurrentStoreItem,
  insertStoreItem,
  retireStoreItem,
} from "../../db/queries/store-items.js";
import { extractCandidates } from "../../ingestion/fast-path.js";
import { StorePutArgsSchema } from "../schemas.js";
import { handleRemember } from "./remember.js";
import {
  buildStoreMemoryContent,
  buildStoreSearchText,
  resolveStoreContext,
  toPublicStoreItem,
  type PublicStoreItem,
} from "./store-shared.js";
import type { JsonObject } from "../../utils/json.js";
import { MemryonError, withDbError } from "../../utils/errors.js";

export interface StorePutArgs {
  namespace: string[];
  key: string;
  value_json: JsonObject;
  user_id: string;
  agent_id: string;
  session_id?: string | undefined;
  scope?: "agent" | "project" | "global" | undefined;
  project_id?: string | undefined;
  metadata_json?: JsonObject | undefined;
}

export interface StorePutResult {
  status: "stored";
  item: PublicStoreItem;
  memcell_id: string;
  candidates_buffered: number;
  replaced_memcell_id?: string;
}

/**
 * Upserts a LangGraph store item and links it to a backing MemCell.
 */
export function handleStorePut(
  db: Database,
  rawArgs: unknown
): StorePutResult {
  const args = StorePutArgsSchema.parse(rawArgs);
  const context = resolveStoreContext(db, {
    user_id: args.user_id,
    agent_id: args.agent_id,
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.project_id !== undefined ? { project_id: args.project_id } : {}),
  });
  const sessionId = args.session_id ?? `langgraph-${args.agent_id}`;
  const searchText = buildStoreSearchText(args.namespace, args.key, args.value_json);
  const memoryContent = buildStoreMemoryContent(
    args.namespace,
    args.key,
    args.value_json
  );

  return withDbError("executing store_put", () =>
    db.transaction(() => {
      const existing = getCurrentStoreItem(db, {
        userId: context.userId,
        scope: context.scope,
        ownerId: context.ownerId,
        namespace: args.namespace,
        key: args.key,
      });

      if (existing !== undefined) {
        if (!retireStoreItem(db, existing.id)) {
          throw new MemryonError(
            `Failed to retire existing store item '${existing.id}'`
          );
        }
        if (!invalidateMemory(db, existing.memory_id, context.agentId)) {
          throw new MemryonError(
            `Failed to invalidate existing memory '${existing.memory_id}'`
          );
        }
      }

      const buffered = extractCandidates(
        db,
        searchText,
        context.agentId,
        "langgraph",
        sessionId,
        context.scope,
        context.projectId
      );

      const remembered = handleRemember(db, {
        content: memoryContent,
        agent_id: context.agentId,
        user_id: context.userId,
        scope: context.scope,
        ...(context.projectId !== undefined
          ? { project_id: context.projectId }
          : {}),
        framework: "langgraph",
        session_id: sessionId,
        source_type: "adapter:langgraph:store",
        ...(existing !== undefined ? { supersedes: existing.memory_id } : {}),
      });

      const inserted = insertStoreItem(db, {
        memory_id: remembered.memcell_id,
        user_id: context.userId,
        scope: context.scope,
        owner_id: context.ownerId,
        ...(context.projectId !== undefined
          ? { project_id: context.projectId }
          : {}),
        agent_id: context.agentId,
        framework: "langgraph",
        session_id: sessionId,
        namespace: args.namespace,
        key: args.key,
        value_json: args.value_json,
        ...(args.metadata_json !== undefined
          ? { metadata_json: args.metadata_json }
          : {}),
        search_text: searchText,
      });

      return {
        status: "stored" as const,
        item: toPublicStoreItem(inserted),
        memcell_id: remembered.memcell_id,
        candidates_buffered: buffered.candidates_buffered,
        ...(existing !== undefined
          ? { replaced_memcell_id: existing.memory_id }
          : {}),
      };
    })()
  );
}
