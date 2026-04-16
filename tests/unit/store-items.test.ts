import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { addAgent, createProject } from "../../src/db/queries/projects.js";
import { handleStoreDelete } from "../../src/mcp/tools/store-delete.js";
import { handleStoreGet } from "../../src/mcp/tools/store-get.js";
import { handleStoreListNamespaces } from "../../src/mcp/tools/store-list-namespaces.js";
import { handleStorePut } from "../../src/mcp/tools/store-put.js";
import { handleStoreSearch } from "../../src/mcp/tools/store-search.js";
import { ScopeViolationError } from "../../src/utils/errors.js";

const DB = ":memory:";
const USER = "user-store";
const AGENT = "agent-store";
const AGENT_OTHER = "agent-other";
let PROJECT_ID = "";

let db: ReturnType<typeof getDb>;

beforeEach(() => {
  db = getDb(DB);

  registerAgent(db, {
    agentId: AGENT,
    displayName: "Store Agent",
    trustTier: 2,
    capabilities: [],
  });
  registerAgent(db, {
    agentId: AGENT_OTHER,
    displayName: "Other Agent",
    trustTier: 2,
    capabilities: [],
  });

  const project = createProject(db, {
    userId: USER,
    name: "LangGraph Project",
    description: "",
  });
  PROJECT_ID = project.id;

  addAgent(db, {
    projectId: PROJECT_ID,
    agentId: AGENT,
    role: "owner",
  });
});

afterEach(() => {
  closeDb(DB);
});

describe("LangGraph store tools", () => {
  it("store_put creates a backing MemCell and a current store_items row", () => {
    const result = handleStorePut(db, {
      namespace: ["users", USER, "profile"],
      key: "prefs",
      value_json: {
        favorite_food: "pizza",
        notifications: true,
      },
      user_id: USER,
      agent_id: AGENT,
    });

    const row = db
      .prepare<
        [string],
        {
          memory_id: string;
          search_text: string;
          deleted_at: string | null;
        }
      >(
        `SELECT memory_id, search_text, deleted_at
         FROM store_items
         WHERE item_key = ?`
      )
      .get("prefs");
    const memory = db
      .prepare<
        [string],
        { framework: string | null; source_type: string; invalidated_at: string | null }
      >(
        `SELECT framework, source_type, invalidated_at
         FROM memories
         WHERE id = ?`
      )
      .get(result.memcell_id);
    const buffered = db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM candidate_buffer WHERE framework = 'langgraph'`
      )
      .get();

    expect(result.status).toBe("stored");
    expect(result.item.key).toBe("prefs");
    expect(row?.memory_id).toBe(result.memcell_id);
    expect(row?.search_text).toContain("favorite_food");
    expect(row?.deleted_at).toBeNull();
    expect(memory?.framework).toBe("langgraph");
    expect(memory?.source_type).toBe("adapter:langgraph:store");
    expect(memory?.invalidated_at).toBeNull();
    expect(buffered?.count).toBeGreaterThan(0);
  });

  it("store_put replaces an existing current item and invalidates the old memory", () => {
    const initial = handleStorePut(db, {
      namespace: ["users", USER, "profile"],
      key: "prefs",
      value_json: { favorite_food: "pizza" },
      user_id: USER,
      agent_id: AGENT,
    });

    const replacement = handleStorePut(db, {
      namespace: ["users", USER, "profile"],
      key: "prefs",
      value_json: { favorite_food: "tacos" },
      user_id: USER,
      agent_id: AGENT,
    });

    const currentRows = db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM store_items
         WHERE item_key = 'prefs' AND deleted_at IS NULL`
      )
      .get();
    const retiredRows = db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM store_items
         WHERE item_key = 'prefs' AND deleted_at IS NOT NULL`
      )
      .get();
    const oldMemory = db
      .prepare<[string], { invalidated_at: string | null }>(
        `SELECT invalidated_at FROM memories WHERE id = ?`
      )
      .get(initial.memcell_id);
    const newMemory = db
      .prepare<[string], { supersedes: string | null }>(
        `SELECT supersedes FROM memories WHERE id = ?`
      )
      .get(replacement.memcell_id);

    expect(replacement.replaced_memcell_id).toBe(initial.memcell_id);
    expect(currentRows?.count).toBe(1);
    expect(retiredRows?.count).toBe(1);
    expect(oldMemory?.invalidated_at).not.toBeNull();
    expect(newMemory?.supersedes).toBe(initial.memcell_id);
  });

  it("store_get returns the exact JSON value for the requested namespace and key", () => {
    handleStorePut(db, {
      namespace: ["users", USER, "prefs"],
      key: "theme",
      value_json: {
        mode: "dark",
        density: "compact",
      },
      user_id: USER,
      agent_id: AGENT,
    });

    const result = handleStoreGet(db, {
      namespace: ["users", USER, "prefs"],
      key: "theme",
      user_id: USER,
      agent_id: AGENT,
    });

    expect(result.item?.namespace).toEqual(["users", USER, "prefs"]);
    expect(result.item?.key).toBe("theme");
    expect(result.item?.value_json).toEqual({
      mode: "dark",
      density: "compact",
    });
  });

  it("store_search respects namespace prefixes and excludes deleted items", () => {
    handleStorePut(db, {
      namespace: ["users", USER, "profile"],
      key: "prefs",
      value_json: { favorite_food: "pizza" },
      user_id: USER,
      agent_id: AGENT,
    });
    handleStorePut(db, {
      namespace: ["users", USER, "profile", "extended"],
      key: "facts",
      value_json: { hobby: "climbing" },
      user_id: USER,
      agent_id: AGENT,
    });
    handleStorePut(db, {
      namespace: ["system", "shared"],
      key: "prefs",
      value_json: { favorite_food: "sushi" },
      user_id: USER,
      agent_id: AGENT,
    });

    handleStoreDelete(db, {
      namespace: ["users", USER, "profile"],
      key: "prefs",
      user_id: USER,
      agent_id: AGENT,
    });

    const result = handleStoreSearch(db, {
      namespace_prefix: ["users", USER],
      user_id: USER,
      agent_id: AGENT,
      query: "climbing",
      limit: 10,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.namespace).toEqual(["users", USER, "profile", "extended"]);
    expect(result.items[0]?.value_json).toEqual({ hobby: "climbing" });
  });

  it("store_delete soft-deletes the item and invalidates the backing memory", () => {
    const stored = handleStorePut(db, {
      namespace: ["users", USER, "profile"],
      key: "prefs",
      value_json: { favorite_food: "pizza" },
      user_id: USER,
      agent_id: AGENT,
    });

    const deleted = handleStoreDelete(db, {
      namespace: ["users", USER, "profile"],
      key: "prefs",
      user_id: USER,
      agent_id: AGENT,
    });

    const row = db
      .prepare<[string], { deleted_at: string | null }>(
        `SELECT deleted_at FROM store_items WHERE memory_id = ?`
      )
      .get(stored.memcell_id);
    const memory = db
      .prepare<[string], { invalidated_at: string | null }>(
        `SELECT invalidated_at FROM memories WHERE id = ?`
      )
      .get(stored.memcell_id);

    expect(deleted.status).toBe("deleted");
    expect(row?.deleted_at).not.toBeNull();
    expect(memory?.invalidated_at).not.toBeNull();
  });

  it("store_list_namespaces returns distinct visible namespaces and supports max_depth", () => {
    handleStorePut(db, {
      namespace: ["users", USER, "profile"],
      key: "prefs",
      value_json: { favorite_food: "pizza" },
      user_id: USER,
      agent_id: AGENT,
    });
    handleStorePut(db, {
      namespace: ["users", USER, "profile", "extended"],
      key: "facts",
      value_json: { hobby: "climbing" },
      user_id: USER,
      agent_id: AGENT,
    });
    handleStorePut(db, {
      namespace: ["users", USER, "settings"],
      key: "ui",
      value_json: { theme: "dark" },
      user_id: USER,
      agent_id: AGENT,
    });

    const result = handleStoreListNamespaces(db, {
      prefix: ["users", USER],
      max_depth: 3,
      user_id: USER,
      agent_id: AGENT,
    });

    expect(result.namespaces).toEqual([
      ["users", USER, "profile"],
      ["users", USER, "settings"],
    ]);
  });

  it("enforces project membership for project-scoped writes", () => {
    expect(() =>
      handleStorePut(db, {
        namespace: ["projects", PROJECT_ID, "memory"],
        key: "prefs",
        value_json: { shared: true },
        user_id: USER,
        agent_id: AGENT_OTHER,
        project_id: PROJECT_ID,
      })
    ).toThrow(ScopeViolationError);
  });
});
