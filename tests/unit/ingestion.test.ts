import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import { insertMemory } from "../../src/db/queries/memories.js";
import { addAgent, createProject } from "../../src/db/queries/projects.js";
import {
  arbitrateConcurrentWrites,
  handleContradiction,
  processCandidate,
  runConsolidationCycle,
  type QualityGateClient,
} from "../../src/ingestion/consolidation.js";
import {
  extractCandidates,
  type CandidateBufferRow,
} from "../../src/ingestion/fast-path.js";

const DB = ":memory:";
const USER = "user-ingestion";
const AGENT_PRIMARY = "agent-primary";
const AGENT_SECONDARY = "agent-secondary";
let PROJECT_ID = "";

function seed(db: ReturnType<typeof getDb>): void {
  registerAgent(db, {
    agentId: AGENT_PRIMARY,
    displayName: "Primary",
    trustTier: 3,
    capabilities: [],
  });
  registerAgent(db, {
    agentId: AGENT_SECONDARY,
    displayName: "Secondary",
    trustTier: 1,
    capabilities: [],
  });

  const project = createProject(db, {
    userId: USER,
    name: "Ingestion Project",
    description: "",
  });

  PROJECT_ID = project.id;

  addAgent(db, {
    projectId: PROJECT_ID,
    agentId: AGENT_PRIMARY,
    role: "owner",
  });
  addAgent(db, {
    projectId: PROJECT_ID,
    agentId: AGENT_SECONDARY,
    role: "contributor",
  });
}

function insertCandidate(
  db: ReturnType<typeof getDb>,
  overrides: Partial<CandidateBufferRow> = {}
): CandidateBufferRow {
  const id = overrides.id ?? ulid();

  db.prepare(
    `INSERT INTO candidate_buffer (
       id, user_id, content, source_turn, candidate_type,
       agent_id, framework, session_id, scope, project_id,
       status, review_required, decision_action, decision_reason,
       decision_confidence, processed_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.user_id ?? USER,
    overrides.content ?? "Candidate content",
    overrides.source_turn ?? "Source turn for testing.",
    overrides.candidate_type ?? "fact",
    overrides.agent_id ?? AGENT_PRIMARY,
    overrides.framework ?? "codex",
    overrides.session_id ?? "session-1",
    overrides.scope ?? "agent",
    overrides.project_id ?? null,
    overrides.status ?? "PENDING",
    overrides.review_required ?? 0,
    overrides.decision_action ?? null,
    overrides.decision_reason ?? null,
    overrides.decision_confidence ?? null,
    overrides.processed_at ?? null,
    overrides.created_at ?? new Date().toISOString()
  );

  return db
    .prepare<[string], CandidateBufferRow>(`SELECT * FROM candidate_buffer WHERE id = ?`)
    .get(id) as CandidateBufferRow;
}

let db: ReturnType<typeof getDb>;

beforeEach(() => {
  db = getDb(DB);
  seed(db);
});

afterEach(() => {
  closeDb(DB);
});

describe("extractCandidates", () => {
  it("buffers heuristic candidates in under 300ms for a typical turn", () => {
    const turn =
      "Alice decided to use SQLite WAL mode for Project Atlas. " +
      "We prefer conflict-aware promotion over blind dedupe. " +
      "Project Atlas requires sqlite-vec embeddings for semantic recall.";

    const start = process.hrtime.bigint();
    const result = extractCandidates(
      db,
      turn,
      AGENT_PRIMARY,
      "codex",
      "session-fast",
      "project",
      PROJECT_ID
    );
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    const rows = db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM candidate_buffer WHERE session_id = 'session-fast'`
      )
      .get();

    expect(elapsedMs).toBeLessThan(300);
    expect(result.candidates_buffered).toBeGreaterThan(3);
    expect(rows?.count).toBe(result.candidates_buffered);
  });
});

describe("processCandidate", () => {
  it("creates a valid MemCell when the Quality Gate accepts", async () => {
    const candidate = insertCandidate(db, {
      content: "Project Atlas stores embeddings locally.",
      source_turn: "Project Atlas stores embeddings locally.",
      scope: "agent",
      agent_id: AGENT_PRIMARY,
      session_id: "session-accept",
    });

    const llmClient: QualityGateClient = {
      qualityGate: () => ({
        action: "ACCEPT",
        confidence: 0.93,
        reason: "Clear factual memory.",
      }),
    };

    const result = await processCandidate(db, candidate, llmClient);
    const stored = db
      .prepare<[string], { content: string; confidence: number; source_type: string }>(
        `SELECT content, confidence, source_type
         FROM memories
         WHERE id = ?`
      )
      .get(result.memory_id ?? "");

    expect(result.action).toBe("ACCEPT");
    expect(stored?.content).toBe(candidate.content);
    expect(stored?.confidence).toBeCloseTo(0.93);
    expect(stored?.source_type).toBe("consolidation:fact");
  });

  it("invalidates the old memory and sets supersedes on UPDATE", async () => {
    const existing = insertMemory(db, {
      user_id: USER,
      scope: "agent",
      agent_id: AGENT_PRIMARY,
      content: "Project Atlas uses sqlite-vss.",
      session_id: "session-old",
    });

    const candidate = insertCandidate(db, {
      content: "Project Atlas uses sqlite-vec.",
      source_turn: "Correction: Project Atlas uses sqlite-vec.",
      scope: "agent",
      agent_id: AGENT_PRIMARY,
      session_id: "session-new",
    });

    const llmClient: QualityGateClient = {
      qualityGate: () => ({
        action: "UPDATE",
        confidence: 0.97,
        reason: "Newer memory supersedes the old one.",
        targetMemoryId: existing.id,
      }),
    };

    const result = await processCandidate(db, candidate, llmClient);
    const oldMemory = db
      .prepare<[string], { valid_until: string | null; invalidated_by: string | null }>(
        `SELECT valid_until, invalidated_by FROM memories WHERE id = ?`
      )
      .get(existing.id);
    const replacement = db
      .prepare<[string], { supersedes: string | null; content: string }>(
        `SELECT supersedes, content FROM memories WHERE id = ?`
      )
      .get(result.memory_id ?? "");

    expect(result.action).toBe("UPDATE");
    expect(oldMemory?.valid_until).not.toBeNull();
    expect(oldMemory?.invalidated_by).toBe(AGENT_PRIMARY);
    expect(replacement?.supersedes).toBe(existing.id);
    expect(replacement?.content).toBe(candidate.content);
  });
});

describe("handleContradiction", () => {
  it("logs a contradiction between two agents in conflict_log", () => {
    const existing = insertMemory(db, {
      user_id: USER,
      scope: "project",
      agent_id: AGENT_PRIMARY,
      project_id: PROJECT_ID,
      content: "Project Atlas feature flag is enabled.",
      framework: "orchestrator",
      session_id: "session-a",
    });

    const candidate = insertCandidate(db, {
      content: "Project Atlas feature flag is disabled.",
      source_turn: "The latest run shows the feature flag is disabled.",
      scope: "project",
      project_id: PROJECT_ID,
      agent_id: AGENT_SECONDARY,
      framework: "codex",
      session_id: "session-b",
    });

    const conflict = handleContradiction(db, existing, {
      ...candidate,
      decision_confidence: 0.88,
    });

    const logged = db
      .prepare<[string], { existing_agent_id: string; candidate_agent_id: string }>(
        `SELECT existing_agent_id, candidate_agent_id
         FROM conflict_log
         WHERE id = ?`
      )
      .get(conflict.id);

    expect(logged?.existing_agent_id).toBe(AGENT_PRIMARY);
    expect(logged?.candidate_agent_id).toBe(AGENT_SECONDARY);
  });
});

describe("arbitrateConcurrentWrites", () => {
  it("orders concurrent candidates by confidence, then hierarchy, then timestamp", () => {
    const sharedTime = new Date("2026-04-16T17:00:00.000Z").toISOString();

    const lowerConfidence = insertCandidate(db, {
      content: "Project Atlas rollout status is green.",
      created_at: sharedTime,
      decision_confidence: 0.72,
      framework: "codex",
    });
    const higherConfidence = insertCandidate(db, {
      content: "Project Atlas rollout status is green.",
      created_at: sharedTime,
      decision_confidence: 0.91,
      framework: "codex",
    });
    const sameConfidenceOrchestrator = insertCandidate(db, {
      content: "Project Atlas rollout status is green.",
      created_at: sharedTime,
      decision_confidence: 0.91,
      framework: "orchestrator",
    });

    const decisions = arbitrateConcurrentWrites(db, [
      lowerConfidence,
      higherConfidence,
      sameConfidenceOrchestrator,
    ]);

    expect(decisions[0]?.candidateId).toBe(sameConfidenceOrchestrator.id);
    expect(decisions[1]?.candidateId).toBe(higherConfidence.id);
    expect(decisions[2]?.candidateId).toBe(lowerConfidence.id);
  });
});

describe("runConsolidationCycle", () => {
  it("clusters similar memories into a MemScene", async () => {
    insertMemory(db, {
      user_id: USER,
      scope: "project",
      agent_id: AGENT_PRIMARY,
      project_id: PROJECT_ID,
      content: "Project Atlas feature flag rollout is enabled.",
      session_id: "session-1",
    });
    insertMemory(db, {
      user_id: USER,
      scope: "project",
      agent_id: AGENT_PRIMARY,
      project_id: PROJECT_ID,
      content: "Project Atlas rollout keeps the feature flag enabled.",
      session_id: "session-2",
    });
    insertMemory(db, {
      user_id: USER,
      scope: "project",
      agent_id: AGENT_SECONDARY,
      project_id: PROJECT_ID,
      content: "We enabled the Project Atlas feature flag rollout.",
      session_id: "session-2",
    });

    const llmClient: QualityGateClient = {
      qualityGate: () => ({
        action: "REJECT",
        confidence: 0,
        reason: "No pending candidates in this test.",
      }),
    };

    const result = await runConsolidationCycle(db, llmClient);
    const scene = db
      .prepare<[], { id: string; memory_count: number; session_count: number }>(
        `SELECT id, memory_count, session_count FROM memscenes`
      )
      .get();
    const membershipCount = db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM memscene_memories WHERE scene_id = ?`
      )
      .get(scene?.id ?? "");

    expect(result.processed).toBe(0);
    expect(scene?.memory_count).toBe(3);
    expect(scene?.session_count).toBe(2);
    expect(membershipCount?.count).toBe(3);
  });
});
