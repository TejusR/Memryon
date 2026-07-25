import type { Database } from "../../db/connection.js";
import { getAgent, registerAgent } from "../../db/queries/agents.js";
import { corroborate } from "../../db/queries/corroborations.js";
import {
  insertHandoff,
  linkHandoffMemory,
} from "../../db/queries/handoffs.js";
import { addAgent, isAgentMember } from "../../db/queries/projects.js";
import type { MemoryKindSchema } from "../schemas.js";
import { ValidationError } from "../../utils/errors.js";
import type { z } from "zod";
import { handleRemember } from "./remember.js";

type MemoryKind = z.infer<typeof MemoryKindSchema>;

export interface RecordHandoffArgs {
  task: string;
  summary: string;
  user_id: string;
  agent_id: string;
  project_id?: string | undefined;
  session_id?: string | undefined;
  framework?: string | undefined;
  decisions?: string[] | undefined;
  constraints?: string[] | undefined;
  failures?: string[] | undefined;
  outcomes?: string[] | undefined;
  unresolved_questions?: string[] | undefined;
  evidence_refs?: string[] | undefined;
}

export interface RecordHandoffResult {
  handoff_id: string;
  memory_ids: string[];
  conflict_ids: string[];
  items_recorded: number;
  status: "recorded";
}

interface StructuredItem {
  kind: MemoryKind;
  content: string;
  importance: number;
}

function cleanItems(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 0);
}

function validateRuntimeArgs(args: RecordHandoffArgs): void {
  for (const [name, value] of [
    ["task", args.task],
    ["summary", args.summary],
    ["user_id", args.user_id],
    ["agent_id", args.agent_id],
  ] as const) {
    if (typeof value !== "string") {
      throw new ValidationError(`${name} must be a string`);
    }
  }

  for (const [name, value] of [
    ["decisions", args.decisions],
    ["constraints", args.constraints],
    ["failures", args.failures],
    ["outcomes", args.outcomes],
    ["unresolved_questions", args.unresolved_questions],
    ["evidence_refs", args.evidence_refs],
  ] as const) {
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string"))
    ) {
      throw new ValidationError(`${name} must be an array of strings`);
    }
  }
}

function collectStructuredItems(args: RecordHandoffArgs): StructuredItem[] {
  const items: StructuredItem[] = [];
  const append = (
    kind: MemoryKind,
    values: readonly string[] | undefined,
    importance: number
  ) => {
    for (const content of cleanItems(values)) {
      items.push({ kind, content, importance });
    }
  };

  const summary = args.summary.replace(/\s+/g, " ").trim();
  if (summary.length > 0) {
    items.push({
      kind: "handoff_summary",
      content: summary,
      importance: 0.7,
    });
  }
  append("decision", args.decisions, 0.9);
  append("constraint", args.constraints, 0.9);
  append("failure", args.failures, 0.8);
  append("outcome", args.outcomes, 0.8);
  append("unresolved_question", args.unresolved_questions, 0.75);
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}\u0000${item.content.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function findExistingStructuredMemory(
  db: Database,
  args: RecordHandoffArgs,
  item: StructuredItem
): string | undefined {
  const sharedWhere =
    args.project_id === undefined
      ? "m.scope = 'agent' AND m.agent_id = ?"
      : "m.scope = 'project' AND m.project_id = ?";
  const ownerId = args.project_id ?? args.agent_id;
  return db
    .prepare<
      [string, string, string, string],
      { id: string }
    >(
      `SELECT m.id
       FROM memories AS m
       WHERE m.user_id = ?
         AND ${sharedWhere}
         AND m.memory_kind = ?
         AND m.content = ? COLLATE NOCASE
         AND m.invalidated_at IS NULL
         AND m.valid_until IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM memories AS replacement
           WHERE replacement.supersedes = m.id
             AND replacement.invalidated_at IS NULL
             AND replacement.valid_until IS NULL
         )
       ORDER BY m.recorded_at DESC
       LIMIT 1`
    )
    .get(args.user_id, ownerId, item.kind, item.content)?.id;
}

function ensureAgentAndMembership(
  db: Database,
  args: RecordHandoffArgs
): void {
  if (getAgent(db, args.agent_id) === undefined) {
    registerAgent(db, {
      agentId: args.agent_id,
      displayName: args.agent_id,
      trustTier: 2,
      capabilities: ["prepare_context", "record_handoff"],
    });
  }

  if (
    args.project_id !== undefined &&
    !isAgentMember(db, args.project_id, args.agent_id)
  ) {
    addAgent(db, {
      projectId: args.project_id,
      agentId: args.agent_id,
      role: "contributor",
    });
  }
}

/**
 * Stores a concise handoff as independently retrievable, typed MemCells linked
 * to one task-level provenance record.
 */
export function handleRecordHandoff(
  db: Database,
  args: RecordHandoffArgs
): RecordHandoffResult {
  validateRuntimeArgs(args);
  const task = args.task.replace(/\s+/g, " ").trim();
  if (task.length === 0) {
    throw new ValidationError("task is required");
  }
  if (args.user_id.trim().length === 0 || args.agent_id.trim().length === 0) {
    throw new ValidationError("user_id and agent_id are required");
  }

  const items = collectStructuredItems(args);
  if (items.length === 0) {
    throw new ValidationError(
      "A handoff requires a summary or at least one structured item"
    );
  }

  ensureAgentAndMembership(db, args);
  const evidenceRefs = cleanItems(args.evidence_refs);

  return db.transaction(() => {
    const handoff = insertHandoff(db, {
      userId: args.user_id,
      agentId: args.agent_id,
      task,
      summary: args.summary.trim(),
      ...(args.project_id !== undefined
        ? { projectId: args.project_id }
        : {}),
      ...(args.framework !== undefined
        ? { framework: args.framework }
        : {}),
      ...(args.session_id !== undefined
        ? { sessionId: args.session_id }
        : {}),
      evidenceRefs,
    });

    const memoryIds: string[] = [];
    const conflictIds: string[] = [];
    items.forEach((item, ordinal) => {
      const existingMemoryId = findExistingStructuredMemory(db, args, item);
      if (existingMemoryId !== undefined) {
        corroborate(db, existingMemoryId, args.agent_id);
        memoryIds.push(existingMemoryId);
        linkHandoffMemory(
          db,
          handoff.id,
          existingMemoryId,
          ordinal,
          item.kind
        );
        return;
      }

      const remembered = handleRemember(db, {
        content: item.content,
        agent_id: args.agent_id,
        user_id: args.user_id,
        scope: args.project_id === undefined ? "agent" : "project",
        ...(args.project_id !== undefined
          ? { project_id: args.project_id }
          : {}),
        ...(args.framework !== undefined
          ? { framework: args.framework }
          : {}),
        ...(args.session_id !== undefined
          ? { session_id: args.session_id }
          : {}),
        importance_hint: item.importance,
        source_type: "handoff",
        memory_kind: item.kind,
        task_id: handoff.id,
        metadata_json: {
          handoff_id: handoff.id,
          task,
          ordinal,
        },
        evidence_refs: evidenceRefs,
      });
      memoryIds.push(remembered.memcell_id);
      conflictIds.push(...(remembered.conflict_ids ?? []));
      linkHandoffMemory(
        db,
        handoff.id,
        remembered.memcell_id,
        ordinal,
        item.kind
      );
    });

    return {
      handoff_id: handoff.id,
      memory_ids: memoryIds,
      conflict_ids: [...new Set(conflictIds)],
      items_recorded: memoryIds.length,
      status: "recorded" as const,
    };
  })();
}
