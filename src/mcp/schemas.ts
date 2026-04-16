import { z } from "zod";
import type { JsonObject, JsonValue } from "../utils/json.js";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const ScopeSchema = z.enum(["agent", "project", "global"]);
const NamespaceSchema = z.array(z.string().min(1)).min(1);

const RoleSchema = z.enum(["owner", "contributor", "readonly"]).default("contributor");

const TrustTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  JsonValueSchema
);

// ---------------------------------------------------------------------------
// Memory schemas
// ---------------------------------------------------------------------------

const commonMemoryFields = {
  user_id: z.string().min(1),
  agent_id: z.string().min(1),
  content: z.string().min(1),
  content_type: z.string().default("text/plain"),
  tags: z.array(z.string()).default([]),
  valid_from: z.string().optional(),
  valid_until: z.string().optional(),
  confidence: z.number().min(0).max(1).default(1.0),
  importance: z.number().min(0).max(1).default(0.5),
  caused_by: z.string().optional(),
  supersedes: z.string().optional(),
  framework: z.string().optional(),
  session_id: z.string().optional(),
  source_type: z.string().default("manual"),
  embedding: z.instanceof(Buffer).optional(),
  embedding_model_version: z.string().optional(),
};

/** Validated input for insertMemory. project_id is required iff scope='project'. */
export const InsertMemoryInputSchema = z.discriminatedUnion("scope", [
  z.object({ ...commonMemoryFields, scope: z.literal("agent") }),
  z.object({ ...commonMemoryFields, scope: z.literal("global") }),
  z.object({
    ...commonMemoryFields,
    scope: z.literal("project"),
    project_id: z.string().min(1),
  }),
]);

export type InsertMemoryInput = z.infer<typeof InsertMemoryInputSchema>;

export const MemoryFiltersSchema = z.object({
  user_id: z.string().min(1),
  scope: ScopeSchema.optional(),
  project_id: z.string().optional(),
  agent_id: z.string().optional(),
});

export type MemoryFilters = z.infer<typeof MemoryFiltersSchema>;

// ---------------------------------------------------------------------------
// Project schemas
// ---------------------------------------------------------------------------

export const CreateProjectInputSchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
});

export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const AddAgentInputSchema = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  role: RoleSchema,
});

export type AddAgentInput = z.infer<typeof AddAgentInputSchema>;

// ---------------------------------------------------------------------------
// Agent schemas
// ---------------------------------------------------------------------------

export const RegisterAgentInputSchema = z.object({
  agentId: z.string().min(1),
  displayName: z.string().min(1),
  trustTier: TrustTierSchema,
  capabilities: z.array(z.string()).default([]),
});

export type RegisterAgentInput = z.infer<typeof RegisterAgentInputSchema>;

// ---------------------------------------------------------------------------
// Conflict schemas
// ---------------------------------------------------------------------------

export const LogConflictInputSchema = z.object({
  memoryA: z.string().min(1),
  memoryB: z.string().min(1),
  projectId: z.string().optional(),
  conflictType: z.string().min(1),
});

export type LogConflictInput = z.infer<typeof LogConflictInputSchema>;

export const ConflictFiltersSchema = z.object({
  projectId: z.string().optional(),
  scope: ScopeSchema.optional(),
  since: z.string().optional(),
  framework: z.string().optional(),
});

export type ConflictFilters = z.infer<typeof ConflictFiltersSchema>;

// ---------------------------------------------------------------------------
// LangGraph store schemas
// ---------------------------------------------------------------------------

export const StoreToolScopeSchema = ScopeSchema.optional();

export const StorePutArgsSchema = z.object({
  namespace: NamespaceSchema,
  key: z.string().min(1),
  value_json: JsonObjectSchema,
  user_id: z.string().min(1),
  agent_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  scope: StoreToolScopeSchema,
  project_id: z.string().optional(),
  metadata_json: JsonObjectSchema.optional(),
});

export type StorePutArgsInput = z.infer<typeof StorePutArgsSchema>;

export const StoreGetArgsSchema = z.object({
  namespace: NamespaceSchema,
  key: z.string().min(1),
  user_id: z.string().min(1),
  agent_id: z.string().min(1),
  scope: StoreToolScopeSchema,
  project_id: z.string().optional(),
});

export type StoreGetArgsInput = z.infer<typeof StoreGetArgsSchema>;

export const StoreSearchArgsSchema = z.object({
  namespace_prefix: NamespaceSchema,
  user_id: z.string().min(1),
  agent_id: z.string().min(1),
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
  scope: StoreToolScopeSchema,
  project_id: z.string().optional(),
  filter_json: JsonObjectSchema.optional(),
});

export type StoreSearchArgsInput = z.infer<typeof StoreSearchArgsSchema>;

export const StoreDeleteArgsSchema = z.object({
  namespace: NamespaceSchema,
  key: z.string().min(1),
  agent_id: z.string().min(1),
  user_id: z.string().min(1),
  scope: StoreToolScopeSchema,
  project_id: z.string().optional(),
});

export type StoreDeleteArgsInput = z.infer<typeof StoreDeleteArgsSchema>;

export const StoreListNamespacesArgsSchema = z.object({
  prefix: NamespaceSchema.optional(),
  suffix: NamespaceSchema.optional(),
  user_id: z.string().min(1),
  agent_id: z.string().min(1),
  max_depth: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
  scope: StoreToolScopeSchema,
  project_id: z.string().optional(),
});

export type StoreListNamespacesArgsInput = z.infer<
  typeof StoreListNamespacesArgsSchema
>;

export const InsertStoreItemInputSchema = z.object({
  memory_id: z.string().min(1),
  user_id: z.string().min(1),
  scope: ScopeSchema,
  owner_id: z.string().min(1),
  project_id: z.string().optional(),
  agent_id: z.string().min(1),
  framework: z.string().optional(),
  session_id: z.string().optional(),
  namespace: NamespaceSchema,
  key: z.string().min(1),
  value_json: JsonObjectSchema,
  metadata_json: JsonObjectSchema.optional(),
  search_text: z.string().min(1),
});

export type InsertStoreItemInput = z.infer<typeof InsertStoreItemInputSchema>;
