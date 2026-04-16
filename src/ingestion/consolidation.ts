import type { Database } from "better-sqlite3";
import { ulid } from "ulid";
import { logConflict } from "../db/queries/conflicts.js";
import {
  fanOutQuery,
  invalidateMemory,
  type MemoryRow,
} from "../db/queries/memories.js";
import { getProject } from "../db/queries/projects.js";
import { handleRemember } from "../mcp/tools/remember.js";
import { resolveByTrustTier } from "../scope/conflict-detection.js";
import { runStalenessSweep } from "../utils/staleness.js";
import {
  MemryonError,
  requireRecord,
  withDbError,
  errorMessage,
} from "../utils/errors.js";
import type { CandidateBufferRow } from "./fast-path.js";

type QualityGateAction = "ACCEPT" | "UPDATE" | "REJECT";
type ConflictResolutionStatus = "pending" | "resolved" | "flagged";

export interface QualityGateInput {
  candidate_fact: string;
  existing_memory_context: Array<{
    id: string;
    content: string;
    agent_id: string;
    framework: string | null;
    session_id: string | null;
    recorded_at: string;
  }>;
  source_turn: string;
  agent_id: string;
  framework: string | null;
}

export interface QualityGateDecision {
  action: QualityGateAction;
  confidence: number;
  reason: string;
  targetMemoryId?: string;
}

export interface QualityGateClient {
  qualityGate(
    input: QualityGateInput
  ): Promise<QualityGateDecision> | QualityGateDecision;
}

export interface ProcessCandidateResult {
  candidate_id: string;
  action: QualityGateAction;
  memory_id?: string;
  conflict_id?: string;
}

export interface ConsolidationCycleResult {
  processed: number;
  accepted: number;
  rejected: number;
  conflicts_detected: number;
}

export interface ConflictLogRow {
  id: string;
  conflict_id: string | null;
  existing_memory_id: string;
  candidate_memory_id: string;
  existing_agent_id: string;
  candidate_agent_id: string;
  existing_framework: string | null;
  candidate_framework: string | null;
  project_id: string | null;
  conflict_type: string;
  resolution_status: ConflictResolutionStatus;
  resolution_reason: string | null;
  resolved_by: string | null;
  detected_at: string;
}

export interface ArbitrationDecision {
  candidateId: string;
  rank: number;
  effectiveConfidence: number;
  reviewRequired: boolean;
}

interface ResolvedCandidate extends CandidateBufferRow {
  user_id: string;
}

interface MemSceneCluster {
  sceneKey: string;
  userId: string;
  scope: MemoryRow["scope"];
  projectId: string | null;
  summary: string;
  memoryIds: string[];
  sessionCount: number;
}

const CONTRADICTION_SIMILARITY_THRESHOLD = 0.55;
const MEMSCENE_SIMILARITY_THRESHOLD = 0.85;
const CONCURRENT_WINDOW_MS = 60_000;
const TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "we",
  "with",
]);

function clampConfidence(value: number | null | undefined): number {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !TOKEN_STOPWORDS.has(token));
}

function tokenFrequency(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
}

function cosineFromCounts(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const value of a.values()) {
    normA += value * value;
  }

  for (const value of b.values()) {
    normB += value * value;
  }

  for (const [token, left] of a.entries()) {
    const right = b.get(token) ?? 0;
    dot += left * right;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function contentSimilarity(left: string, right: string): number {
  return cosineFromCounts(tokenFrequency(tokenize(left)), tokenFrequency(tokenize(right)));
}

function hasNegation(value: string): boolean {
  return /\b(no|not|never|disabled|disable|false|cannot|can't|won't|without|reject)\b/i.test(
    value
  );
}

function hasContradictoryPolarity(left: string, right: string): boolean {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  const contradictoryPairs: Array<[string, string]> = [
    ["enabled", "disabled"],
    ["allow", "deny"],
    ["allows", "denies"],
    ["true", "false"],
    ["yes", "no"],
    ["accept", "reject"],
    ["supports", "unsupported"],
    ["present", "absent"],
  ];

  for (const [positive, negative] of contradictoryPairs) {
    const leftPositive = normalizedLeft.includes(positive);
    const leftNegative = normalizedLeft.includes(negative);
    const rightPositive = normalizedRight.includes(positive);
    const rightNegative = normalizedRight.includes(negative);

    if ((leftPositive && rightNegative) || (leftNegative && rightPositive)) {
      return true;
    }
  }

  return hasNegation(left) !== hasNegation(right);
}

function frameworkPriority(framework: string | null): number {
  const normalized = framework?.toLowerCase() ?? "";

  if (
    normalized.includes("orchestrator") ||
    normalized.includes("planner") ||
    normalized.includes("manager")
  ) {
    return 3;
  }

  if (
    normalized.includes("codex") ||
    normalized.includes("openclaw") ||
    normalized.includes("hermes")
  ) {
    return 2;
  }

  return 1;
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveCandidateUserId(db: Database, candidate: CandidateBufferRow): string {
  if (candidate.user_id) {
    return candidate.user_id;
  }

  if (candidate.project_id) {
    const project = getProject(db, candidate.project_id);
    if (project) {
      return project.user_id;
    }
  }

  const knownUserIds = db
    .prepare<[], { user_id: string }>(
      `SELECT user_id FROM (
         SELECT user_id FROM memories
         UNION
         SELECT user_id FROM projects
       )`
    )
    .all()
    .map((row) => row.user_id);

  if (knownUserIds.length === 1) {
    return knownUserIds[0] ?? "local-user";
  }

  return process.env.MEMRYON_USER_ID ?? "local-user";
}

function enrichCandidate(
  db: Database,
  candidate: CandidateBufferRow
): ResolvedCandidate {
  return {
    ...candidate,
    user_id: resolveCandidateUserId(db, candidate),
  };
}

function loadExistingMemoryContext(
  db: Database,
  candidate: ResolvedCandidate
): MemoryRow[] {
  const memories = fanOutQuery(
    db,
    candidate.user_id,
    candidate.agent_id,
    candidate.project_id ?? undefined,
    50
  );

  return memories
    .filter((memory) => memory.id !== candidate.id)
    .sort(
      (left, right) =>
        contentSimilarity(candidate.content, right.content) -
        contentSimilarity(candidate.content, left.content)
    );
}

function resolveUpdateTarget(
  context: MemoryRow[],
  decision: QualityGateDecision
): MemoryRow | undefined {
  if (decision.targetMemoryId) {
    return context.find((memory) => memory.id === decision.targetMemoryId);
  }

  return context[0];
}

function findContradictionTarget(
  context: MemoryRow[],
  candidate: ResolvedCandidate
): MemoryRow | undefined {
  return context.find(
    (memory) =>
      memory.agent_id !== candidate.agent_id &&
      contentSimilarity(memory.content, candidate.content) >=
        CONTRADICTION_SIMILARITY_THRESHOLD &&
      hasContradictoryPolarity(memory.content, candidate.content)
  );
}

function updateCandidateStatus(
  db: Database,
  candidateId: string,
  status: CandidateBufferRow["status"],
  action: QualityGateAction,
  confidence: number,
  reason: string
): void {
  db.prepare(
    `UPDATE candidate_buffer
     SET status = ?,
         decision_action = ?,
         decision_confidence = ?,
         decision_reason = ?,
         processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`
  ).run(status, action, clampConfidence(confidence), reason, candidateId);
}

function logAdapterError(
  db: Database,
  adapter: string,
  error: unknown
): void {
  const message = error instanceof Error ? error.stack ?? error.message : errorMessage(error);

  db.prepare(
    `INSERT INTO adapter_errors (id, adapter, error)
     VALUES (?, ?, ?)`
  ).run(ulid(), adapter, message);
}

function getCandidateById(
  db: Database,
  candidateId: string
): CandidateBufferRow | undefined {
  return db
    .prepare<[string], CandidateBufferRow>(
      `SELECT * FROM candidate_buffer WHERE id = ?`
    )
    .get(candidateId);
}

function getPendingCandidates(db: Database): CandidateBufferRow[] {
  return db
    .prepare<[], CandidateBufferRow>(
      `SELECT * FROM candidate_buffer
       WHERE status = 'PENDING'
       ORDER BY created_at ASC`
    )
    .all();
}

function rememberCandidate(
  db: Database,
  candidate: ResolvedCandidate,
  confidence: number,
  supersedes?: string
): string {
  const result = handleRemember(db, {
    content: candidate.content,
    agent_id: candidate.agent_id,
    user_id: candidate.user_id,
    scope: candidate.scope,
    ...(candidate.project_id ? { project_id: candidate.project_id } : {}),
    ...(candidate.framework ? { framework: candidate.framework } : {}),
    ...(candidate.session_id ? { session_id: candidate.session_id } : {}),
    confidence,
    source_type: `consolidation:${candidate.candidate_type}`,
    ...(supersedes ? { supersedes } : {}),
  });

  return result.memcell_id;
}

function upsertConflictLog(
  db: Database,
  params: {
    conflictId: string | null;
    existingMemory: MemoryRow;
    candidateMemory: MemoryRow;
    resolutionStatus: ConflictResolutionStatus;
    resolutionReason: string | null;
    resolvedBy: string | null;
  }
): ConflictLogRow {
  const id = ulid();

  db.prepare(
    `INSERT INTO conflict_log (
       id, conflict_id, existing_memory_id, candidate_memory_id,
       existing_agent_id, candidate_agent_id,
       existing_framework, candidate_framework,
       project_id, conflict_type,
       resolution_status, resolution_reason, resolved_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.conflictId,
    params.existingMemory.id,
    params.candidateMemory.id,
    params.existingMemory.agent_id,
    params.candidateMemory.agent_id,
    params.existingMemory.framework,
    params.candidateMemory.framework,
    params.candidateMemory.project_id,
    params.candidateMemory.project_id ? "intra_project" : "cross_scope",
    params.resolutionStatus,
    params.resolutionReason,
    params.resolvedBy
  );

  return db
    .prepare<[string], ConflictLogRow>(
      `SELECT * FROM conflict_log WHERE id = ?`
    )
    .get(id) as ConflictLogRow;
}

function getMemoryById(db: Database, memoryId: string): MemoryRow {
  return requireRecord(
    db
      .prepare<[string], MemoryRow>(`SELECT * FROM memories WHERE id = ?`)
      .get(memoryId),
    `Memory '${memoryId}' not found`
  );
}

function deriveSceneSummary(memories: MemoryRow[]): string {
  const terms = memories
    .flatMap((memory) => tokenize(memory.content))
    .reduce<Map<string, number>>((counts, token) => {
      counts.set(token, (counts.get(token) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());

  const topTerms = [...terms.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([token]) => token);

  return topTerms.length > 0
    ? `MemScene: ${topTerms.join(", ")}`
    : `MemScene: ${memories[0]?.content.slice(0, 80) ?? "cluster"}`;
}

function deriveSceneKey(memories: MemoryRow[]): string {
  const anchor = deriveSceneSummary(memories).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const exemplarIds = memories
    .map((memory) => memory.id)
    .sort()
    .slice(0, 3)
    .join("-");

  return `${memories[0]?.user_id ?? "local-user"}:${memories[0]?.scope ?? "global"}:${anchor}:${exemplarIds}`;
}

function buildMemSceneClusters(memories: MemoryRow[]): MemSceneCluster[] {
  const clusters: MemSceneCluster[] = [];
  const buckets = new Map<string, MemoryRow[]>();

  for (const memory of memories) {
    if (!memory.session_id) {
      continue;
    }

    const key = `${memory.user_id}:${memory.scope}:${memory.project_id ?? "-"}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(memory);
    buckets.set(key, bucket);
  }

  for (const bucket of buckets.values()) {
    const visited = new Set<string>();

    for (const memory of bucket) {
      if (visited.has(memory.id)) {
        continue;
      }

      const queue = [memory];
      const component: MemoryRow[] = [];
      visited.add(memory.id);

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
          continue;
        }

        component.push(current);

        for (const candidate of bucket) {
          if (visited.has(candidate.id)) {
            continue;
          }

          if (
            contentSimilarity(current.content, candidate.content) >=
            MEMSCENE_SIMILARITY_THRESHOLD
          ) {
            visited.add(candidate.id);
            queue.push(candidate);
          }
        }
      }

      const distinctSessions = new Set(
        component
          .map((entry) => entry.session_id)
          .filter((sessionId): sessionId is string => sessionId !== null)
      );

      if (component.length < 3 || distinctSessions.size < 2) {
        continue;
      }

      clusters.push({
        sceneKey: deriveSceneKey(component),
        userId: component[0]?.user_id ?? "local-user",
        scope: component[0]?.scope ?? "global",
        projectId: component[0]?.project_id ?? null,
        summary: deriveSceneSummary(component),
        memoryIds: component.map((entry) => entry.id).sort(),
        sessionCount: distinctSessions.size,
      });
    }
  }

  return clusters;
}

function persistMemScenes(db: Database, clusters: MemSceneCluster[]): void {
  const upsertCluster = db.transaction((cluster: MemSceneCluster) => {
    const existing = db
      .prepare<[string], { id: string }>(`SELECT id FROM memscenes WHERE scene_key = ?`)
      .get(cluster.sceneKey);

    const sceneId = existing?.id ?? ulid();

    if (existing) {
      db.prepare(
        `UPDATE memscenes
         SET summary = ?,
             memory_count = ?,
             session_count = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(cluster.summary, cluster.memoryIds.length, cluster.sessionCount, sceneId);
      db.prepare(`DELETE FROM memscene_memories WHERE scene_id = ?`).run(sceneId);
    } else {
      db.prepare(
        `INSERT INTO memscenes (
           id, scene_key, user_id, scope, project_id, summary, memory_count, session_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sceneId,
        cluster.sceneKey,
        cluster.userId,
        cluster.scope,
        cluster.projectId,
        cluster.summary,
        cluster.memoryIds.length,
        cluster.sessionCount
      );
    }

    const insertMembership = db.prepare(
      `INSERT OR IGNORE INTO memscene_memories (scene_id, memory_id)
       VALUES (?, ?)`
    );

    for (const memoryId of cluster.memoryIds) {
      insertMembership.run(sceneId, memoryId);
    }
  });

  for (const cluster of clusters) {
    upsertCluster(cluster);
  }
}

function clusterMemScenes(db: Database): void {
  const memories = db
    .prepare<[], MemoryRow>(
      `SELECT * FROM memories
       WHERE invalidated_at IS NULL
         AND valid_until IS NULL
       ORDER BY recorded_at DESC
       LIMIT 500`
    )
    .all();

  const clusters = buildMemSceneClusters(memories);
  persistMemScenes(db, clusters);
}

/**
 * Runs the consolidation quality gate for a buffered candidate and persists the result.
 */
export async function processCandidate(
  db: Database,
  candidate: CandidateBufferRow,
  llmClient: QualityGateClient
): Promise<ProcessCandidateResult> {
  const { resolvedCandidate, context } = withDbError(
    `loading context for candidate '${candidate.id}'`,
    () => {
      const enriched = enrichCandidate(db, candidate);
      return {
        resolvedCandidate: enriched,
        context: loadExistingMemoryContext(db, enriched),
      };
    }
  );

  try {
    const decision = await llmClient.qualityGate({
      candidate_fact: resolvedCandidate.content,
      existing_memory_context: context.slice(0, 10).map((memory) => ({
        id: memory.id,
        content: memory.content,
        agent_id: memory.agent_id,
        framework: memory.framework,
        session_id: memory.session_id,
        recorded_at: memory.recorded_at,
      })),
      source_turn: resolvedCandidate.source_turn,
      agent_id: resolvedCandidate.agent_id,
      framework: resolvedCandidate.framework,
    });

    const confidence = clampConfidence(decision.confidence);

    return withDbError(`processing candidate '${resolvedCandidate.id}'`, () => {
      if (decision.action === "REJECT") {
        updateCandidateStatus(
          db,
          resolvedCandidate.id,
          "REJECTED",
          decision.action,
          confidence,
          decision.reason
        );

        return {
          candidate_id: resolvedCandidate.id,
          action: "REJECT",
        };
      }

      const contradictionTarget = findContradictionTarget(context, resolvedCandidate);

      if (contradictionTarget) {
        const conflict = handleContradiction(db, contradictionTarget, {
          ...resolvedCandidate,
          decision_confidence: confidence,
        });

        updateCandidateStatus(
          db,
          resolvedCandidate.id,
          "ACCEPTED",
          decision.action,
          confidence,
          decision.reason
        );

        return {
          candidate_id: resolvedCandidate.id,
          action: decision.action,
          memory_id: conflict.candidate_memory_id,
          conflict_id: conflict.id,
        };
      }

      if (decision.action === "UPDATE") {
        const target = resolveUpdateTarget(context, decision);
        if (target && !invalidateMemory(db, target.id, resolvedCandidate.agent_id)) {
          throw new MemryonError(
            `Failed to invalidate superseded memory '${target.id}'`
          );
        }

        const memoryId = rememberCandidate(
          db,
          resolvedCandidate,
          confidence,
          target?.id
        );

        updateCandidateStatus(
          db,
          resolvedCandidate.id,
          "ACCEPTED",
          decision.action,
          confidence,
          decision.reason
        );

        return {
          candidate_id: resolvedCandidate.id,
          action: "UPDATE",
          memory_id: memoryId,
        };
      }

      const memoryId = rememberCandidate(db, resolvedCandidate, confidence);

      updateCandidateStatus(
        db,
        resolvedCandidate.id,
        "ACCEPTED",
        decision.action,
        confidence,
        decision.reason
      );

      return {
        candidate_id: resolvedCandidate.id,
        action: "ACCEPT",
        memory_id: memoryId,
      };
    });
  } catch (error) {
    logAdapterError(db, candidate.framework ?? "quality-gate", error);
    updateCandidateStatus(
      db,
      candidate.id,
      "REJECTED",
      "REJECT",
      0,
      errorMessage(error)
    );

    return {
      candidate_id: candidate.id,
      action: "REJECT",
    };
  }
}

/**
 * Processes all pending candidates in arbitration order and runs follow-up maintenance passes.
 */
export async function runConsolidationCycle(
  db: Database,
  llmClient: QualityGateClient
): Promise<ConsolidationCycleResult> {
  const pendingCandidates = withDbError("loading pending consolidation candidates", () =>
    getPendingCandidates(db)
  );
  const arbitration = arbitrateConcurrentWrites(db, pendingCandidates);
  const rankMap = new Map(
    arbitration.map((decision) => [decision.candidateId, decision.rank])
  );
  const ordered = [...pendingCandidates].sort(
    (left, right) => (rankMap.get(left.id) ?? 0) - (rankMap.get(right.id) ?? 0)
  );

  let processed = 0;
  let accepted = 0;
  let rejected = 0;
  let conflictsDetected = 0;

  for (const candidate of ordered) {
    const latest = withDbError(`reloading candidate '${candidate.id}'`, () =>
      getCandidateById(db, candidate.id)
    );
    if (!latest || latest.status !== "PENDING") {
      continue;
    }

    const result = await processCandidate(db, latest, llmClient);
    processed += 1;

    if (result.action === "REJECT") {
      rejected += 1;
    } else {
      accepted += 1;
    }

    if (result.conflict_id) {
      conflictsDetected += 1;
    }
  }

  withDbError("clustering memscenes", () => {
    clusterMemScenes(db);
  });
  runStalenessSweep(db);

  return {
    processed,
    accepted,
    rejected,
    conflicts_detected: conflictsDetected,
  };
}

/**
 * Records a contradiction by invalidating the older memory, writing the new one, and logging the conflict.
 */
export function handleContradiction(
  db: Database,
  existingMemory: MemoryRow,
  candidate: CandidateBufferRow | (CandidateBufferRow & { decision_confidence?: number })
): ConflictLogRow {
  return withDbError(
    `handling contradiction for memory '${existingMemory.id}'`,
    () => {
      const resolvedCandidate = enrichCandidate(db, candidate);
      const decisionConfidence = clampConfidence(candidate.decision_confidence);
      const validUntil = resolvedCandidate.created_at;

      db.prepare(
        `UPDATE memories
         SET valid_until = ?,
             invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             invalidated_by = ?
         WHERE id = ?
           AND invalidated_at IS NULL`
      ).run(validUntil, resolvedCandidate.agent_id, existingMemory.id);

      const candidateMemoryId = rememberCandidate(
        db,
        {
          ...resolvedCandidate,
          project_id: resolvedCandidate.project_id ?? existingMemory.project_id,
        },
        decisionConfidence,
        existingMemory.id
      );

      const candidateMemory = getMemoryById(db, candidateMemoryId);
      const conflict = logConflict(db, {
        memoryA: existingMemory.id,
        memoryB: candidateMemory.id,
        ...(candidateMemory.project_id ? { projectId: candidateMemory.project_id } : {}),
        conflictType: candidateMemory.project_id ? "intra_project" : "cross_scope",
      });

      let resolutionStatus: ConflictResolutionStatus = "pending";
      let resolutionReason: string | null = null;
      let resolvedBy: string | null = null;

      if (
        existingMemory.project_id &&
        candidateMemory.project_id &&
        existingMemory.project_id === candidateMemory.project_id
      ) {
        const resolvedConflict = resolveByTrustTier(db, conflict.id);
        if (resolvedConflict.resolved_at) {
          resolutionStatus = "resolved";
          resolutionReason = resolvedConflict.resolution;
          resolvedBy = resolvedConflict.resolved_by;
        } else {
          resolutionStatus = "flagged";
          resolutionReason = "trust_tier_tie";
        }
      }

      return upsertConflictLog(db, {
        conflictId: conflict.id,
        existingMemory,
        candidateMemory,
        resolutionStatus,
        resolutionReason,
        resolvedBy,
      });
    }
  );
}

/**
 * Ranks near-simultaneous candidate writes so the most reliable one is processed first.
 */
export function arbitrateConcurrentWrites(
  db: Database,
  candidates: CandidateBufferRow[]
): ArbitrationDecision[] {
  return withDbError("arbitrating concurrent writes", () => {
    const groups: CandidateBufferRow[][] = [];
    const sortedCandidates = [...candidates].sort(
      (left, right) =>
        parseTimestamp(left.created_at) - parseTimestamp(right.created_at)
    );

    for (const candidate of sortedCandidates) {
      const group = groups.find((currentGroup) =>
        currentGroup.some(
          (existing) =>
            Math.abs(
              parseTimestamp(existing.created_at) -
                parseTimestamp(candidate.created_at)
            ) <= CONCURRENT_WINDOW_MS &&
            contentSimilarity(existing.content, candidate.content) >= 0.7
        )
      );

      if (group) {
        group.push(candidate);
      } else {
        groups.push([candidate]);
      }
    }

    const decisions: ArbitrationDecision[] = [];
    let rank = 1;

    for (const group of groups) {
      const ordered = [...group].sort((left, right) => {
        const confidenceDelta =
          clampConfidence(right.decision_confidence) -
          clampConfidence(left.decision_confidence);

        if (confidenceDelta !== 0) {
          return confidenceDelta;
        }

        const hierarchyDelta =
          frameworkPriority(right.framework) - frameworkPriority(left.framework);
        if (hierarchyDelta !== 0) {
          return hierarchyDelta;
        }

        return parseTimestamp(left.created_at) - parseTimestamp(right.created_at);
      });

      const top = ordered[0];
      const runnerUp = ordered[1];
      const tied =
        top !== undefined &&
        runnerUp !== undefined &&
        clampConfidence(top.decision_confidence) ===
          clampConfidence(runnerUp.decision_confidence) &&
        frameworkPriority(top.framework) === frameworkPriority(runnerUp.framework);

      const spanMs =
        ordered.length > 1
          ? parseTimestamp(
              ordered[ordered.length - 1]?.created_at ?? top?.created_at ?? ""
            ) - parseTimestamp(top?.created_at ?? "")
          : 0;

      const forcedReview = tied && spanMs >= CONCURRENT_WINDOW_MS;
      if (forcedReview && top) {
        db.prepare(
          `UPDATE candidate_buffer
           SET review_required = 1,
               decision_confidence = 0.5
           WHERE id = ?`
        ).run(top.id);
      }

      for (const candidate of ordered) {
        decisions.push({
          candidateId: candidate.id,
          rank,
          effectiveConfidence:
            forcedReview && candidate.id === top?.id
              ? 0.5
              : clampConfidence(candidate.decision_confidence),
          reviewRequired: forcedReview && candidate.id === top?.id,
        });
        rank += 1;
      }
    }

    return decisions;
  });
}
