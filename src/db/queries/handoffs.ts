import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import {
  requireNonEmptyString,
  requireRecord,
  withDbError,
} from "../../utils/errors.js";

export interface HandoffRow {
  id: string;
  user_id: string;
  project_id: string | null;
  agent_id: string;
  framework: string | null;
  session_id: string | null;
  task: string;
  summary: string;
  evidence_refs_json: string;
  created_at: string;
}

export interface HandoffMemoryRow {
  handoff_id: string;
  memory_id: string;
  ordinal: number;
  memory_kind: string;
}

export interface InsertHandoffInput {
  userId: string;
  agentId: string;
  task: string;
  summary: string;
  projectId?: string;
  framework?: string;
  sessionId?: string;
  evidenceRefs?: string[];
}

/**
 * Creates the task-level provenance record for a structured handoff.
 */
export function insertHandoff(
  db: Database,
  input: InsertHandoffInput
): HandoffRow {
  const userId = requireNonEmptyString(input.userId, "userId");
  const agentId = requireNonEmptyString(input.agentId, "agentId");
  const task = requireNonEmptyString(input.task, "task");
  const id = ulid();

  return withDbError(`inserting handoff '${id}'`, () => {
    db.prepare(
      `INSERT INTO handoffs (
         id, user_id, project_id, agent_id, framework, session_id,
         task, summary, evidence_refs_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      userId,
      input.projectId ?? null,
      agentId,
      input.framework ?? null,
      input.sessionId ?? null,
      task,
      input.summary,
      JSON.stringify(input.evidenceRefs ?? [])
    );

    return requireRecord(
      db
        .prepare<[string], HandoffRow>(
          `SELECT * FROM handoffs WHERE id = ?`
        )
        .get(id),
      `Handoff '${id}' was not found after insertion`
    );
  });
}

/**
 * Links one independently retrievable MemCell to its source handoff.
 */
export function linkHandoffMemory(
  db: Database,
  handoffId: string,
  memoryId: string,
  ordinal: number,
  memoryKind: string
): HandoffMemoryRow {
  const resolvedHandoffId = requireNonEmptyString(handoffId, "handoffId");
  const resolvedMemoryId = requireNonEmptyString(memoryId, "memoryId");
  const resolvedMemoryKind = requireNonEmptyString(memoryKind, "memoryKind");

  return withDbError(
    `linking memory '${resolvedMemoryId}' to handoff '${resolvedHandoffId}'`,
    () => {
      db.prepare(
        `INSERT INTO handoff_memories (
           handoff_id, memory_id, ordinal, memory_kind
         ) VALUES (?, ?, ?, ?)`
      ).run(
        resolvedHandoffId,
        resolvedMemoryId,
        ordinal,
        resolvedMemoryKind
      );

      return requireRecord(
        db
          .prepare<[string, string], HandoffMemoryRow>(
            `SELECT *
             FROM handoff_memories
             WHERE handoff_id = ? AND memory_id = ?`
          )
          .get(resolvedHandoffId, resolvedMemoryId),
        `Handoff-memory link was not found after insertion`
      );
    }
  );
}

export function getHandoffById(
  db: Database,
  handoffId: string
): HandoffRow | undefined {
  const resolvedHandoffId = requireNonEmptyString(handoffId, "handoffId");

  return withDbError(`loading handoff '${resolvedHandoffId}'`, () =>
    db
      .prepare<[string], HandoffRow>(`SELECT * FROM handoffs WHERE id = ?`)
      .get(resolvedHandoffId)
  );
}

export function listHandoffMemories(
  db: Database,
  handoffId: string
): HandoffMemoryRow[] {
  const resolvedHandoffId = requireNonEmptyString(handoffId, "handoffId");

  return withDbError(`loading memories for handoff '${resolvedHandoffId}'`, () =>
    db
      .prepare<[string], HandoffMemoryRow>(
        `SELECT *
         FROM handoff_memories
         WHERE handoff_id = ?
         ORDER BY ordinal`
      )
      .all(resolvedHandoffId)
  );
}
