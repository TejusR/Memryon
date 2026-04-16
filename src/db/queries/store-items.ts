import { ulid } from "ulid";
import type { Database } from "better-sqlite3";
import {
  InsertStoreItemInputSchema,
  type InsertStoreItemInput,
} from "../../mcp/schemas.js";
import {
  jsonObjectMatchesFilter,
  namespaceToPath,
  pathHasPrefix,
  pathHasSuffix,
  stableJsonStringify,
  truncateNamespace,
  type JsonObject,
} from "../../utils/json.js";

interface StoreItemRowRaw {
  id: string;
  memory_id: string;
  user_id: string;
  scope: "agent" | "project" | "global";
  owner_id: string;
  project_id: string | null;
  agent_id: string;
  framework: string | null;
  session_id: string | null;
  namespace_json: string;
  namespace_path: string;
  item_key: string;
  value_json: string;
  metadata_json: string | null;
  search_text: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface StoreSearchRowRaw extends StoreItemRowRaw {
  rank?: number | null;
}

export interface StoreItemRow {
  id: string;
  memory_id: string;
  user_id: string;
  scope: "agent" | "project" | "global";
  owner_id: string;
  project_id: string | null;
  agent_id: string;
  framework: string | null;
  session_id: string | null;
  namespace: string[];
  namespace_path: string;
  key: string;
  value_json: JsonObject;
  metadata_json: JsonObject | null;
  search_text: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface StoreSearchResult extends StoreItemRow {
  score: number | null;
}

export interface StoreVisibility {
  userId: string;
  scope: "agent" | "project" | "global";
  ownerId: string;
}

export interface StoreItemIdentity extends StoreVisibility {
  namespace: string[];
  key: string;
}

export interface SearchStoreItemsArgs extends StoreVisibility {
  namespacePrefix: string[];
  query?: string;
  filter?: JsonObject;
  limit?: number;
  offset?: number;
}

export interface ListStoreNamespacesArgs extends StoreVisibility {
  prefix?: string[];
  suffix?: string[];
  maxDepth?: number;
  limit?: number;
  offset?: number;
}

function hydrateStoreItem(row: StoreItemRowRaw): StoreItemRow {
  return {
    id: row.id,
    memory_id: row.memory_id,
    user_id: row.user_id,
    scope: row.scope,
    owner_id: row.owner_id,
    project_id: row.project_id,
    agent_id: row.agent_id,
    framework: row.framework,
    session_id: row.session_id,
    namespace: JSON.parse(row.namespace_json) as string[],
    namespace_path: row.namespace_path,
    key: row.item_key,
    value_json: JSON.parse(row.value_json) as JsonObject,
    metadata_json:
      row.metadata_json === null
        ? null
        : (JSON.parse(row.metadata_json) as JsonObject),
    search_text: row.search_text,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

function toSearchResult(row: StoreSearchRowRaw): StoreSearchResult {
  return {
    ...hydrateStoreItem(row),
    score:
      row.rank === null || row.rank === undefined
        ? null
        : 1 / (1 + Math.max(row.rank, 0)),
  };
}

export function insertStoreItem(
  db: Database,
  input: InsertStoreItemInput
): StoreItemRow {
  const parsed = InsertStoreItemInputSchema.parse(input);
  const id = ulid();
  const namespaceJson = JSON.stringify(parsed.namespace);
  const namespacePath = namespaceToPath(parsed.namespace);
  const valueJson = stableJsonStringify(parsed.value_json);
  const metadataJson =
    parsed.metadata_json === undefined
      ? null
      : stableJsonStringify(parsed.metadata_json);

  db.prepare(
    `INSERT INTO store_items (
       id, memory_id, user_id, scope, owner_id, project_id, agent_id,
       framework, session_id, namespace_json, namespace_path, item_key,
       value_json, metadata_json, search_text, created_at, updated_at, deleted_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       NULL
     )`
  ).run(
    id,
    parsed.memory_id,
    parsed.user_id,
    parsed.scope,
    parsed.owner_id,
    parsed.project_id ?? null,
    parsed.agent_id,
    parsed.framework ?? null,
    parsed.session_id ?? null,
    namespaceJson,
    namespacePath,
    parsed.key,
    valueJson,
    metadataJson,
    parsed.search_text
  );

  const row = db
    .prepare<[string], StoreItemRowRaw>(`SELECT * FROM store_items WHERE id = ?`)
    .get(id) as StoreItemRowRaw;

  return hydrateStoreItem(row);
}

export function getCurrentStoreItem(
  db: Database,
  identity: StoreItemIdentity
): StoreItemRow | undefined {
  const namespaceJson = JSON.stringify(identity.namespace);
  const row = db
    .prepare<unknown[], StoreItemRowRaw>(
      `SELECT * FROM store_items
       WHERE user_id = ?
         AND scope = ?
         AND owner_id = ?
         AND namespace_json = ?
         AND item_key = ?
         AND deleted_at IS NULL`
    )
    .get(
      identity.userId,
      identity.scope,
      identity.ownerId,
      namespaceJson,
      identity.key
    );

  return row === undefined ? undefined : hydrateStoreItem(row);
}

export function retireStoreItem(db: Database, id: string): boolean {
  const result = db
    .prepare(
      `UPDATE store_items
       SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
         AND deleted_at IS NULL`
    )
    .run(id);

  return result.changes > 0;
}

function selectSearchRows(
  db: Database,
  args: SearchStoreItemsArgs,
  applyLimitInSql: boolean
): StoreSearchRowRaw[] {
  const namespacePrefixPath = namespaceToPath(args.namespacePrefix);
  const namespacePattern = `${namespacePrefixPath}\u001f%`;
  const limit = args.limit ?? 10;
  const offset = args.offset ?? 0;

  if (args.query !== undefined) {
    const sql = applyLimitInSql
      ? `SELECT s.*, bm25(store_items_fts) AS rank
         FROM store_items_fts
         JOIN store_items s ON s.rowid = store_items_fts.rowid
         WHERE store_items_fts MATCH ?
           AND s.user_id = ?
           AND s.scope = ?
           AND s.owner_id = ?
           AND s.deleted_at IS NULL
           AND (s.namespace_path = ? OR s.namespace_path LIKE ?)
         ORDER BY rank ASC, s.updated_at DESC
         LIMIT ? OFFSET ?`
      : `SELECT s.*, bm25(store_items_fts) AS rank
         FROM store_items_fts
         JOIN store_items s ON s.rowid = store_items_fts.rowid
         WHERE store_items_fts MATCH ?
           AND s.user_id = ?
           AND s.scope = ?
           AND s.owner_id = ?
           AND s.deleted_at IS NULL
           AND (s.namespace_path = ? OR s.namespace_path LIKE ?)
         ORDER BY rank ASC, s.updated_at DESC`;

    return applyLimitInSql
      ? db
          .prepare<unknown[], StoreSearchRowRaw>(sql)
          .all(
            args.query,
            args.userId,
            args.scope,
            args.ownerId,
            namespacePrefixPath,
            namespacePattern,
            limit,
            offset
          )
      : db
          .prepare<unknown[], StoreSearchRowRaw>(sql)
          .all(
            args.query,
            args.userId,
            args.scope,
            args.ownerId,
            namespacePrefixPath,
            namespacePattern
          );
  }

  const sql = applyLimitInSql
    ? `SELECT s.*, NULL AS rank
       FROM store_items s
       WHERE s.user_id = ?
         AND s.scope = ?
         AND s.owner_id = ?
         AND s.deleted_at IS NULL
         AND (s.namespace_path = ? OR s.namespace_path LIKE ?)
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`
    : `SELECT s.*, NULL AS rank
       FROM store_items s
       WHERE s.user_id = ?
         AND s.scope = ?
         AND s.owner_id = ?
         AND s.deleted_at IS NULL
         AND (s.namespace_path = ? OR s.namespace_path LIKE ?)
       ORDER BY s.updated_at DESC`;

  return applyLimitInSql
    ? db
        .prepare<unknown[], StoreSearchRowRaw>(sql)
        .all(
          args.userId,
          args.scope,
          args.ownerId,
          namespacePrefixPath,
          namespacePattern,
          limit,
          offset
        )
    : db
        .prepare<unknown[], StoreSearchRowRaw>(sql)
        .all(
          args.userId,
          args.scope,
          args.ownerId,
          namespacePrefixPath,
          namespacePattern
        );
}

export function searchStoreItems(
  db: Database,
  args: SearchStoreItemsArgs
): StoreSearchResult[] {
  const applyLimitInSql = args.filter === undefined;
  const rows = selectSearchRows(db, args, applyLimitInSql).map(toSearchResult);

  if (args.filter === undefined) {
    return rows;
  }

  const offset = args.offset ?? 0;
  const limit = args.limit ?? 10;

  return rows
    .filter((row) => jsonObjectMatchesFilter(row.value_json, args.filter))
    .slice(offset, offset + limit);
}

export function listStoreNamespaces(
  db: Database,
  args: ListStoreNamespacesArgs
): string[][] {
  const prefixPath =
    args.prefix === undefined ? undefined : namespaceToPath(args.prefix);
  const prefixPattern =
    prefixPath === undefined ? undefined : `${prefixPath}\u001f%`;

  const rows = db
    .prepare<unknown[], { namespace_json: string; namespace_path: string }>(
      `SELECT namespace_json, namespace_path
       FROM store_items
       WHERE user_id = ?
         AND scope = ?
         AND owner_id = ?
         AND deleted_at IS NULL
         AND (
           ? IS NULL OR namespace_path = ? OR namespace_path LIKE ?
         )
       ORDER BY namespace_path ASC`
    )
    .all(
      args.userId,
      args.scope,
      args.ownerId,
      prefixPath ?? null,
      prefixPath ?? null,
      prefixPattern ?? null
    );

  const suffixPath =
    args.suffix === undefined ? undefined : namespaceToPath(args.suffix);
  const seen = new Set<string>();
  const namespaces: string[][] = [];

  for (const row of rows) {
    const namespace = JSON.parse(row.namespace_json) as string[];

    if (
      args.prefix !== undefined &&
      !pathHasPrefix(row.namespace_path, namespaceToPath(args.prefix))
    ) {
      continue;
    }

    if (suffixPath !== undefined && !pathHasSuffix(row.namespace_path, suffixPath)) {
      continue;
    }

    const truncated = truncateNamespace(namespace, args.maxDepth);
    const key = stableJsonStringify(truncated);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    namespaces.push(truncated);
  }

  const offset = args.offset ?? 0;
  const limit = args.limit ?? 100;

  return namespaces
    .sort((left, right) =>
      stableJsonStringify(left).localeCompare(stableJsonStringify(right))
    )
    .slice(offset, offset + limit);
}
