import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type Database } from "../db/connection.js";
import { MemryonError } from "../utils/errors.js";
import { handleRemember } from "./tools/remember.js";
import { handleRecall } from "./tools/recall.js";
import { handleForget } from "./tools/forget.js";
import { handleConflicts } from "./tools/conflicts.js";
import { handleCorroborate } from "./tools/corroborate.js";
import { handlePromote } from "./tools/promote.js";
import { handleProjectCreate } from "./tools/project-create.js";
import { handleProjectJoin } from "./tools/project-join.js";
import { handleProjectContext } from "./tools/project-context.js";
import { handleStorePut } from "./tools/store-put.js";
import { handleStoreGet } from "./tools/store-get.js";
import { handleStoreSearch } from "./tools/store-search.js";
import { handleStoreDelete } from "./tools/store-delete.js";
import { handleStoreListNamespaces } from "./tools/store-list-namespaces.js";
import { handlePrepareContext } from "./tools/prepare-context.js";
import { handleRecordHandoff } from "./tools/record-handoff.js";
import { getDefaultDbPath } from "../config/paths.js";
import { startEmbeddingWorker } from "../ingestion/embedding-worker.js";
import { JsonObjectSchema } from "./schemas.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Wrap a known error into an MCP tool-error result instead of crashing. */
function toErrorResult(err: unknown): { content: [{ type: "text"; text: string }]; isError: true } {
  const message =
    err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

function isKnownError(err: unknown): boolean {
  return err instanceof MemryonError;
}

function ok(result: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the stdio MCP server and registers the Memryon tool surface.
 */
export function createMcpServer(db: Database): McpServer {
  const server = new McpServer({
    name: "memryon",
    version: "0.1.0",
  });

  // ── remember ──────────────────────────────────────────────────────────────

  server.registerTool(
    "remember",
    {
      description: "Store a memory in the agent, project, or global scope.",
      inputSchema: {
        content: z.string().min(1).describe("The memory content to store"),
        agent_id: z.string().min(1).describe("ID of the writing agent"),
        user_id: z.string().min(1).describe("ID of the user"),
        scope: z.enum(["agent", "project", "global"]).describe("Memory visibility scope"),
        project_id: z.string().optional().describe("Required when scope='project'"),
        framework: z.string().optional().describe("Originating framework (e.g. claude-code)"),
        session_id: z.string().optional().describe("Session identifier"),
        importance_hint: z.number().min(0).max(1).optional().describe("0-1 importance weight"),
        content_type: z.string().optional().describe("MIME type; defaults to text/plain"),
        tags: z.array(z.string()).optional().describe("Tag list"),
        memory_kind: z
          .enum([
            "observation",
            "decision",
            "constraint",
            "failure",
            "outcome",
            "unresolved_question",
            "fact",
            "preference",
            "procedure",
            "handoff_summary",
          ])
          .optional()
          .describe("Typed memory category; defaults to observation"),
        task_id: z.string().optional().describe("Task or handoff identifier"),
        metadata_json: JsonObjectSchema
          .optional()
          .describe("Structured metadata"),
        evidence_refs: z
          .array(z.string().min(1))
          .optional()
          .describe("References supporting this memory"),
      },
    },
    async (args) => {
      try {
        return ok(handleRemember(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  server.registerTool(
    "prepare_context",
    {
      description:
        "Compile a task-aware, token-bounded evidence pack from visible memories.",
      inputSchema: {
        task: z.string().min(1).describe("The task the agent is about to perform"),
        user_id: z.string().min(1).describe("Local user identity"),
        agent_id: z.string().min(1).describe("Requesting agent identity"),
        project_id: z.string().optional().describe("Current project identity"),
        session_id: z.string().optional().describe("Current session identity"),
        token_budget: z
          .number()
          .int()
          .min(256)
          .max(32_000)
          .optional()
          .describe("Maximum estimated context tokens; defaults to 3000"),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum selected memories; defaults to 12"),
      },
    },
    async (args) => {
      try {
        return ok(await handlePrepareContext(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  server.registerTool(
    "record_handoff",
    {
      description:
        "Record a concise structured task handoff as independently retrievable memories.",
      inputSchema: {
        task: z.string().min(1).describe("Task that was performed"),
        summary: z.string().default("").describe("Concise task summary"),
        user_id: z.string().min(1).describe("Local user identity"),
        agent_id: z.string().min(1).describe("Writing agent identity"),
        project_id: z.string().optional().describe("Current project identity"),
        session_id: z.string().optional().describe("Current session identity"),
        framework: z.string().optional().describe("Originating agent framework"),
        decisions: z.array(z.string().min(1)).optional(),
        constraints: z.array(z.string().min(1)).optional(),
        failures: z.array(z.string().min(1)).optional(),
        outcomes: z.array(z.string().min(1)).optional(),
        unresolved_questions: z.array(z.string().min(1)).optional(),
        evidence_refs: z.array(z.string().min(1)).optional(),
      },
    },
    async (args) => {
      try {
        return ok(handleRecordHandoff(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  // ── recall ────────────────────────────────────────────────────────────────

  server.registerTool(
    "recall",
    {
      description: "Retrieve memories via fan-out across scope tiers or a targeted scope query.",
      inputSchema: {
        user_id: z.string().min(1).describe("ID of the user"),
        agent_id: z.string().min(1).describe("ID of the requesting agent"),
        query: z.string().optional().describe("Full-text search query"),
        intent_hint: z.string().optional().describe("Semantic intent hint (informational)"),
        scope: z.enum(["agent", "project", "global"]).optional().describe("Restrict to one scope tier"),
        project_id: z.string().optional().describe("Restrict to a specific project"),
        framework_filter: z.string().optional().describe("Only return memories from this framework"),
        top_k: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
      },
    },
    async (args) => {
      try {
        return ok(handleRecall(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  // ── forget ────────────────────────────────────────────────────────────────

  server.registerTool(
    "forget",
    {
      description: "Soft-delete a memory (sets valid_until = now).",
      inputSchema: {
        memcell_id: z.string().min(1).describe("ULID of the memory to forget"),
        agent_id: z.string().min(1).describe("Agent performing the forget (recorded as invalidated_by)"),
        reason: z.string().optional().describe("Human-readable reason for forgetting"),
      },
    },
    async (args) => {
      try {
        return ok(handleForget(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  // ── conflicts ─────────────────────────────────────────────────────────────

  server.registerTool(
    "conflicts",
    {
      description: "List unresolved memory conflicts, optionally filtered.",
      inputSchema: {
        since: z.string().optional().describe("ISO 8601 timestamp — only conflicts detected after this"),
        framework: z.string().optional().describe("Filter to conflicts involving this framework"),
        project_id: z.string().optional().describe("Filter to a specific project"),
        scope: z.enum(["agent", "project", "global"]).optional().describe("Filter by scope of involved memories"),
      },
    },
    async (args) => {
      try {
        return ok(handleConflicts(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  // ── corroborate ───────────────────────────────────────────────────────────

  server.registerTool(
    "corroborate",
    {
      description: "Vouch for an existing memory to prevent duplicate storage.",
      inputSchema: {
        memory_id: z.string().min(1).describe("ULID of the memory to corroborate"),
        agent_id: z.string().min(1).describe("Agent that is corroborating"),
      },
    },
    async (args) => {
      try {
        return ok(handleCorroborate(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  // ── promote ───────────────────────────────────────────────────────────────

  server.registerTool(
    "promote",
    {
      description: "Promote a memory to a wider scope (agent→project or agent/project→global).",
      inputSchema: {
        memory_id: z.string().min(1).describe("ULID of the memory to promote"),
        agent_id: z.string().min(1).describe("Requesting agent (must be the memory author)"),
        new_scope: z.enum(["project", "global"]).describe("Target scope"),
        project_id: z.string().optional().describe("Required when new_scope='project'"),
      },
    },
    async (args) => {
      try {
        return ok(handlePromote(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  // ── project_create ────────────────────────────────────────────────────────

  server.registerTool(
    "project_create",
    {
      description: "Create a new project. The requesting agent is automatically assigned as owner.",
      inputSchema: {
        name: z.string().min(1).describe("Project name"),
        description: z.string().optional().describe("Project description"),
        user_id: z.string().min(1).describe("User who owns this project"),
        agent_id: z.string().min(1).describe("Agent creating (and becoming owner of) the project"),
      },
    },
    async (args) => {
      try {
        return ok(handleProjectCreate(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  // ── project_join ──────────────────────────────────────────────────────────

  server.registerTool(
    "project_join",
    {
      description: "Add an agent to a project with a given role (default: contributor).",
      inputSchema: {
        project_id: z.string().min(1).describe("Project to join"),
        agent_id: z.string().min(1).describe("Agent joining the project"),
        role: z.enum(["owner", "contributor", "readonly"]).optional().describe("Role (default: contributor)"),
      },
    },
    async (args) => {
      try {
        return ok(handleProjectJoin(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  // ── project_context ───────────────────────────────────────────────────────

  server.registerTool(
    "project_context",
    {
      description: "Retrieve project metadata, member agents, memory count, and recent activity.",
      inputSchema: {
        project_id: z.string().min(1).describe("Project to inspect"),
        user_id: z.string().min(1).describe("User context (for memory visibility)"),
      },
    },
    async (args) => {
      try {
        return ok(handleProjectContext(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  server.registerTool(
    "store_put",
    {
      description:
        "Store or replace an exact LangGraph-style namespace/key item in Memryon.",
      inputSchema: {
        namespace: z.array(z.string().min(1)).min(1).describe("Namespace tuple"),
        key: z.string().min(1).describe("Exact item key"),
        value_json: z.record(z.string(), z.unknown()).describe("Exact JSON value"),
        user_id: z.string().min(1).describe("User context"),
        agent_id: z.string().min(1).describe("Writing agent"),
        session_id: z.string().optional().describe("Session identifier"),
        scope: z.enum(["agent", "project", "global"]).optional().describe("Visibility scope"),
        project_id: z.string().optional().describe("Required when scope resolves to project"),
        metadata_json: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional item metadata"),
      },
    },
    async (args) => {
      try {
        return ok(handleStorePut(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  server.registerTool(
    "store_get",
    {
      description: "Fetch an exact LangGraph-style namespace/key item from Memryon.",
      inputSchema: {
        namespace: z.array(z.string().min(1)).min(1).describe("Namespace tuple"),
        key: z.string().min(1).describe("Exact item key"),
        user_id: z.string().min(1).describe("User context"),
        agent_id: z.string().min(1).describe("Reading agent"),
        scope: z.enum(["agent", "project", "global"]).optional().describe("Visibility scope"),
        project_id: z.string().optional().describe("Project scope identifier"),
      },
    },
    async (args) => {
      try {
        return ok(handleStoreGet(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  server.registerTool(
    "store_search",
    {
      description: "Search exact store items under a namespace prefix.",
      inputSchema: {
        namespace_prefix: z
          .array(z.string().min(1))
          .min(1)
          .describe("Namespace prefix tuple"),
        user_id: z.string().min(1).describe("User context"),
        agent_id: z.string().min(1).describe("Reading agent"),
        query: z.string().optional().describe("Optional full-text query"),
        filter_json: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional exact-match filter on top-level value fields"),
        limit: z.number().int().min(1).max(500).optional().describe("Result limit"),
        offset: z.number().int().min(0).optional().describe("Result offset"),
        scope: z.enum(["agent", "project", "global"]).optional().describe("Visibility scope"),
        project_id: z.string().optional().describe("Project scope identifier"),
      },
    },
    async (args) => {
      try {
        return ok(handleStoreSearch(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  server.registerTool(
    "store_delete",
    {
      description: "Delete an exact store item and invalidate its backing MemCell.",
      inputSchema: {
        namespace: z.array(z.string().min(1)).min(1).describe("Namespace tuple"),
        key: z.string().min(1).describe("Exact item key"),
        user_id: z.string().min(1).describe("User context"),
        agent_id: z.string().min(1).describe("Deleting agent"),
        scope: z.enum(["agent", "project", "global"]).optional().describe("Visibility scope"),
        project_id: z.string().optional().describe("Project scope identifier"),
      },
    },
    async (args) => {
      try {
        return ok(handleStoreDelete(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  server.registerTool(
    "store_list_namespaces",
    {
      description: "List visible store namespaces with optional prefix/suffix filters.",
      inputSchema: {
        prefix: z.array(z.string().min(1)).optional().describe("Optional namespace prefix"),
        suffix: z.array(z.string().min(1)).optional().describe("Optional namespace suffix"),
        user_id: z.string().min(1).describe("User context"),
        agent_id: z.string().min(1).describe("Reading agent"),
        max_depth: z.number().int().min(1).optional().describe("Truncate namespaces to this depth"),
        limit: z.number().int().min(1).max(500).optional().describe("Result limit"),
        offset: z.number().int().min(0).optional().describe("Result offset"),
        scope: z.enum(["agent", "project", "global"]).optional().describe("Visibility scope"),
        project_id: z.string().optional().describe("Project scope identifier"),
      },
    },
    async (args) => {
      try {
        return ok(handleStoreListNamespaces(db, args));
      } catch (err) {
        if (isKnownError(err)) return toErrorResult(err);
        throw err;
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Entry point (stdio transport for production use)
// ---------------------------------------------------------------------------

export async function serveMcpServer(): Promise<void> {
  const { getDb } = await import("../db/connection.js");
  const dbPath = getDefaultDbPath();
  const db = getDb(dbPath);
  startEmbeddingWorker(db);

  const server = createMcpServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run when executed directly — not when imported by tests.
const isMain =
  process.argv[1] !== undefined &&
  (await import("url")).fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  process.on("unhandledRejection", (reason) => {
    console.error(reason);
    process.exitCode = 1;
  });

  serveMcpServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
