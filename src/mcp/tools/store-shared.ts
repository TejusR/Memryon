import type { Database } from "../../db/connection.js";
import { getCurrentStoreItem } from "../../db/queries/store-items.js";
import { isAgentMember } from "../../db/queries/projects.js";
import { ScopeViolationError } from "../../utils/errors.js";
import { flattenJsonToSearchText, type JsonObject } from "../../utils/json.js";

export type StoreScope = "agent" | "project" | "global";

export interface StoreContextInput {
  user_id: string;
  agent_id: string;
  scope?: StoreScope;
  project_id?: string;
}

export interface ResolvedStoreContext {
  userId: string;
  agentId: string;
  scope: StoreScope;
  projectId?: string;
  ownerId: string;
}

export interface PublicStoreItem {
  id: string;
  memcell_id: string;
  scope: StoreScope;
  project_id: string | null;
  agent_id: string;
  framework: string | null;
  session_id: string | null;
  namespace: string[];
  key: string;
  value_json: JsonObject;
  metadata_json: JsonObject | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * Resolves the effective store scope, defaulting project IDs to project scope and everything else to agent scope.
 */
export function resolveStoreScope(
  explicitScope: StoreScope | undefined,
  projectId?: string
): StoreScope {
  return explicitScope ?? (projectId ? "project" : "agent");
}

/**
 * Resolves the effective visibility bucket for a store request and enforces project membership.
 */
export function resolveStoreContext(
  db: Database,
  input: StoreContextInput
): ResolvedStoreContext {
  const scope = resolveStoreScope(input.scope, input.project_id);

  if (scope === "project") {
    if (!input.project_id) {
      throw new ScopeViolationError(
        "project_id is required when scope is 'project'"
      );
    }
    if (!isAgentMember(db, input.project_id, input.agent_id)) {
      throw new ScopeViolationError(
        `Agent '${input.agent_id}' is not a member of project '${input.project_id}'`
      );
    }

    return {
      userId: input.user_id,
      agentId: input.agent_id,
      scope,
      projectId: input.project_id,
      ownerId: input.project_id,
    };
  }

  if (input.project_id !== undefined) {
    throw new ScopeViolationError(
      "project_id may only be supplied when scope is 'project'"
    );
  }

  return {
    userId: input.user_id,
    agentId: input.agent_id,
    scope,
    ownerId: scope === "agent" ? input.agent_id : input.user_id,
  };
}

/**
 * Builds the flattened search text stored for a LangGraph namespace/key item.
 */
export function buildStoreSearchText(
  namespace: readonly string[],
  key: string,
  value: JsonObject
): string {
  const namespaceLabel = namespace.join(" / ");
  const flattened = flattenJsonToSearchText(value);

  return [
    `namespace: ${namespaceLabel}`,
    `key: ${key}`,
    flattened,
  ].join("\n");
}

/**
 * Builds the backing MemCell content recorded for a LangGraph store update.
 */
export function buildStoreMemoryContent(
  namespace: readonly string[],
  key: string,
  value: JsonObject
): string {
  const namespaceLabel = namespace.join(" / ");
  const flattened = flattenJsonToSearchText(value);

  return [
    `LangGraph store item updated.`,
    `Namespace: ${namespaceLabel}`,
    `Key: ${key}`,
    flattened,
  ].join("\n");
}

/**
 * Converts an internal store row into the public tool response shape.
 */
export function toPublicStoreItem(
  row: NonNullable<ReturnType<typeof getCurrentStoreItem>>
): PublicStoreItem {
  return {
    id: row.id,
    memcell_id: row.memory_id,
    scope: row.scope,
    project_id: row.project_id,
    agent_id: row.agent_id,
    framework: row.framework,
    session_id: row.session_id,
    namespace: row.namespace,
    key: row.key,
    value_json: row.value_json,
    metadata_json: row.metadata_json,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}
