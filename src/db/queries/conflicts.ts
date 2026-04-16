import { ulid } from "ulid";
import type { Database } from "better-sqlite3";
import {
  ConflictFiltersSchema,
  LogConflictInputSchema,
  type ConflictFilters,
  type LogConflictInput,
} from "../../mcp/schemas.js";
import {
  requireNonEmptyString,
  requireRecord,
  withDbError,
} from "../../utils/errors.js";

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export interface ConflictRow {
  id: string;
  memory_a: string;
  memory_b: string;
  project_id: string | null;
  conflict_type: string;
  detected_at: string;
  resolved_at: string | null;
  resolution: string | null;
  resolved_by: string | null;
}

// ---------------------------------------------------------------------------
// logConflict
// ---------------------------------------------------------------------------

/**
 * Inserts a conflict row and returns the stored record.
 */
export function logConflict(db: Database, input: LogConflictInput): ConflictRow {
  const parsed = LogConflictInputSchema.parse(input);
  const id = ulid();

  return withDbError(
    `logging conflict between '${parsed.memoryA}' and '${parsed.memoryB}'`,
    () => {
      db.prepare(
        `INSERT INTO conflicts (id, memory_a, memory_b, project_id, conflict_type)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        id,
        parsed.memoryA,
        parsed.memoryB,
        parsed.projectId ?? null,
        parsed.conflictType
      );

      return requireRecord(
        db
          .prepare<[string], ConflictRow>(`SELECT * FROM conflicts WHERE id = ?`)
          .get(id),
        `Conflict '${id}' was not found after creation`
      );
    }
  );
}

// ---------------------------------------------------------------------------
// resolveConflict
// ---------------------------------------------------------------------------

/**
 * Marks an unresolved conflict as resolved by a specific agent.
 */
export function resolveConflict(
  db: Database,
  conflictId: string,
  resolution: string,
  resolvedBy: string
): boolean {
  const resolvedConflictId = requireNonEmptyString(conflictId, "conflictId");
  const resolvedResolution = requireNonEmptyString(resolution, "resolution");
  const resolvedResolvedBy = requireNonEmptyString(resolvedBy, "resolvedBy");

  return withDbError(`resolving conflict '${resolvedConflictId}'`, () => {
    const result = db
      .prepare(
        `UPDATE conflicts
         SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             resolution  = ?,
             resolved_by = ?
         WHERE id = ?
           AND resolved_at IS NULL`
      )
      .run(resolvedResolution, resolvedResolvedBy, resolvedConflictId);

    return result.changes > 0;
  });
}

// ---------------------------------------------------------------------------
// getUnresolvedConflicts
//
// Optional filters:
//   projectId  — direct column on conflicts
//   since      — detected_at >= since (ISO string)
//   scope      — at least one side-memory must have this scope
//   framework  — at least one side-memory must have this framework
// ---------------------------------------------------------------------------

/**
 * Returns unresolved conflicts that match the supplied project, scope, time, or framework filters.
 */
export function getUnresolvedConflicts(
  db: Database,
  filters: ConflictFilters = {}
): ConflictRow[] {
  const { projectId, scope, since, framework } =
    ConflictFiltersSchema.parse(filters);

  // scope and framework require looking at the referenced memory rows.
  // We LEFT JOIN both sides and use OR so a conflict is included if
  // either memory_a or memory_b matches the requested attribute.
  return withDbError("loading unresolved conflicts", () =>
    db
      .prepare<unknown[], ConflictRow>(
        `SELECT DISTINCT c.*
         FROM conflicts c
         LEFT JOIN memories ma ON c.memory_a = ma.id
         LEFT JOIN memories mb ON c.memory_b = mb.id
         WHERE c.resolved_at IS NULL
           AND (? IS NULL OR c.project_id = ?)
           AND (? IS NULL OR c.detected_at >= ?)
           AND (? IS NULL OR ma.scope = ? OR mb.scope = ?)
           AND (? IS NULL OR ma.framework = ? OR mb.framework = ?)
         ORDER BY c.detected_at DESC`
      )
      .all(
        projectId ?? null,   projectId ?? null,
        since ?? null,       since ?? null,
        scope ?? null,       scope ?? null,       scope ?? null,
        framework ?? null,   framework ?? null,   framework ?? null
      )
  );
}
