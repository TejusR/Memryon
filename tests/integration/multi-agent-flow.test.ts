import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeDb, getDb } from "../../src/db/connection.js";
import { registerAgent } from "../../src/db/queries/agents.js";
import {
  getMemoryById,
  insertMemory,
  type MemoryRow,
} from "../../src/db/queries/memories.js";
import {
  getUnresolvedConflicts,
  logConflict,
  type ConflictRow,
} from "../../src/db/queries/conflicts.js";
import { getCorroborationCount } from "../../src/db/queries/corroborations.js";
import { createMcpServer } from "../../src/mcp/server.js";
import {
  checkCrossScopeConflicts,
  checkIntraProjectConflicts,
  resolveByTrustTier,
} from "../../src/scope/conflict-detection.js";
import { runStalenessSweep } from "../../src/utils/staleness.js";
import { arbitrateConcurrentWrites } from "../../src/ingestion/consolidation.js";
import type { CandidateBufferRow } from "../../src/ingestion/fast-path.js";

const DB = ":memory:";
const USER = "user-multi-agent";
const CLAUDE = "claude_code";
const HERMES = "hermes";

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

interface JsonTextBlock {
  type: "text";
  text: string;
}

interface RememberResponse {
  memcell_id: string;
  status: "stored";
}

interface RecallResponse {
  results: Array<{
    id: string;
    content: string;
    scope: "agent" | "project" | "global";
    agent_id: string;
  }>;
  scope_breakdown: {
    project: number;
    agent: number;
    global: number;
  };
}

interface PromoteResponse {
  status: "promoted";
  memory_id: string;
  new_scope: "project" | "global";
}

interface CorroborateResponse {
  status: "corroborated";
  corroboration_count: number;
}

interface ConflictToolResponse {
  conflict_log: ConflictRow[];
  count: number;
}

let db: ReturnType<typeof getDb>;
let client: Client;
let projectId: string;

function parseText<T>(result: CallResult): T {
  const block = result.content.find(
    (entry): entry is JsonTextBlock =>
      entry.type === "text" && typeof entry.text === "string"
  );

  if (!block) {
    throw new Error("No JSON text block found in MCP tool response");
  }

  return JSON.parse(block.text) as T;
}

async function callToolJson<T>(
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBeFalsy();
  return parseText<T>(result);
}

function makeEmbedding(values: number[]): Buffer {
  const data = new Float32Array(values);
  return Buffer.from(data.buffer.slice(0));
}

function writeProjectMemoryWithConflicts(input: {
  agentId: string;
  content: string;
  embedding: Buffer;
  projectId: string;
}): { memory: MemoryRow; conflicts: ConflictRow[] } {
  const memory = insertMemory(db, {
    user_id: USER,
    scope: "project",
    agent_id: input.agentId,
    project_id: input.projectId,
    content: input.content,
    embedding: input.embedding,
  });

  const candidates = [
    ...checkIntraProjectConflicts(db, memory),
    ...checkCrossScopeConflicts(db, memory),
  ];

  return {
    memory,
    conflicts: candidates.map((candidate) =>
      logConflict(db, {
        memoryA: memory.id,
        memoryB: candidate.existingMemoryId,
        projectId: memory.project_id ?? undefined,
        conflictType: candidate.conflictType,
      })
    ),
  };
}

function insertCandidate(overrides: Partial<CandidateBufferRow>): CandidateBufferRow {
  const id = overrides.id ?? `${Date.now()}-${Math.random()}`;

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
    overrides.content ?? "candidate",
    overrides.source_turn ?? overrides.content ?? "candidate",
    overrides.candidate_type ?? "fact",
    overrides.agent_id ?? CLAUDE,
    overrides.framework ?? "codex",
    overrides.session_id ?? "session-candidate",
    overrides.scope ?? "project",
    overrides.project_id ?? projectId,
    overrides.status ?? "PENDING",
    overrides.review_required ?? 0,
    overrides.decision_action ?? null,
    overrides.decision_reason ?? null,
    overrides.decision_confidence ?? null,
    overrides.processed_at ?? null,
    overrides.created_at ?? new Date().toISOString()
  );

  return db
    .prepare<[string], CandidateBufferRow>(
      `SELECT * FROM candidate_buffer WHERE id = ?`
    )
    .get(id) as CandidateBufferRow;
}

beforeEach(async () => {
  db = getDb(DB);

  registerAgent(db, {
    agentId: CLAUDE,
    displayName: "Claude Code",
    trustTier: 2,
    capabilities: [],
  });
  registerAgent(db, {
    agentId: HERMES,
    displayName: "Hermes",
    trustTier: 2,
    capabilities: [],
  });

  const server = createMcpServer(db);
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  client = new Client({ name: "multi-agent-test", version: "0.0.1" });
  await client.connect(clientTransport);

  const created = await callToolJson<{ project_id: string }>("project_create", {
    name: "memryon",
    description: "Shared multi-agent collaboration project",
    user_id: USER,
    agent_id: CLAUDE,
  });
  projectId = created.project_id;

  await callToolJson("project_join", {
    project_id: projectId,
    agent_id: HERMES,
    role: "contributor",
  });
});

afterEach(async () => {
  await client.close();
  closeDb(DB);
});

describe("two agents collaborating on the Memryon project", () => {
  it("enforces scope isolation, shares global/project knowledge, and preserves provenance on promotion", async () => {
    const globalMemory = await callToolJson<RememberResponse>("remember", {
      content: "Global preference: keep embeddings local to the machine",
      user_id: USER,
      agent_id: HERMES,
      scope: "global",
    });
    const privateMemory = await callToolJson<RememberResponse>("remember", {
      content: "Considering WAL mode for SQLite",
      user_id: USER,
      agent_id: CLAUDE,
      scope: "agent",
    });
    await callToolJson<RememberResponse>("remember", {
      content: "Architecture uses SQLite with FTS5",
      user_id: USER,
      agent_id: HERMES,
      scope: "project",
      project_id: projectId,
    });

    const hermesRecall = await callToolJson<RecallResponse>("recall", {
      user_id: USER,
      agent_id: HERMES,
      project_id: projectId,
      top_k: 10,
    });
    const claudeRecall = await callToolJson<RecallResponse>("recall", {
      user_id: USER,
      agent_id: CLAUDE,
      project_id: projectId,
      top_k: 10,
    });

    expect(hermesRecall.results.map((row) => row.content)).not.toContain(
      "Considering WAL mode for SQLite"
    );
    expect(claudeRecall.results.map((row) => row.content)).toContain(
      "Architecture uses SQLite with FTS5"
    );
    expect(hermesRecall.results.map((row) => row.id)).toContain(
      globalMemory.memcell_id
    );
    expect(claudeRecall.results.map((row) => row.id)).toContain(
      globalMemory.memcell_id
    );

    const promoted = await callToolJson<PromoteResponse>("promote", {
      memory_id: privateMemory.memcell_id,
      agent_id: CLAUDE,
      new_scope: "project",
      project_id: projectId,
    });

    expect(promoted.status).toBe("promoted");
    expect(promoted.new_scope).toBe("project");

    const afterPromotion = await callToolJson<RecallResponse>("recall", {
      user_id: USER,
      agent_id: HERMES,
      project_id: projectId,
      query: "Considering WAL mode SQLite",
      top_k: 10,
    });
    expect(afterPromotion.results.map((row) => row.id)).toContain(
      privateMemory.memcell_id
    );

    const promotedRow = getMemoryById(db, privateMemory.memcell_id);
    expect(promotedRow?.scope).toBe("project");
    expect(promotedRow?.project_id).toBe(projectId);
    expect(promotedRow?.agent_id).toBe(CLAUDE);

    db.prepare(`UPDATE agents SET trust_tier = 1 WHERE agent_id = ?`).run(CLAUDE);

    const failedGlobalPromotion = await client.callTool({
      name: "promote",
      arguments: {
        memory_id: privateMemory.memcell_id,
        agent_id: CLAUDE,
        new_scope: "global",
      },
    });

    expect(failedGlobalPromotion.isError).toBe(true);
    expect(parseText<{ error: string }>(failedGlobalPromotion).error).toMatch(
      /trust_tier/i
    );
  });

  it("counts corroborations and keeps a corroborated memory from being flagged stale", async () => {
    const walMemory = await callToolJson<RememberResponse>("remember", {
      content: "Considering WAL mode for SQLite",
      user_id: USER,
      agent_id: CLAUDE,
      scope: "agent",
    });

    await callToolJson<PromoteResponse>("promote", {
      memory_id: walMemory.memcell_id,
      agent_id: CLAUDE,
      new_scope: "project",
      project_id: projectId,
    });

    const oldTimestamp = new Date(
      Date.now() - 45 * 24 * 60 * 60 * 1000
    ).toISOString();
    db.prepare(`UPDATE memories SET valid_from = ? WHERE id = ?`).run(
      oldTimestamp,
      walMemory.memcell_id
    );

    const corroborated = await callToolJson<CorroborateResponse>(
      "corroborate",
      {
        memory_id: walMemory.memcell_id,
        agent_id: HERMES,
      }
    );

    expect(corroborated.corroboration_count).toBe(1);
    expect(getCorroborationCount(db, walMemory.memcell_id)).toBe(1);

    const sweep = runStalenessSweep(db, {
      staleDays: 30,
      corroborationWindowDays: 7,
    });
    const refreshed = getMemoryById(db, walMemory.memcell_id);

    expect(sweep.memories).not.toContain(walMemory.memcell_id);
    expect(JSON.parse(refreshed?.tags ?? "[]")).not.toContain("stale");
  });

  it("detects unresolved intra-project and cross-scope conflicts between equal-trust agents", async () => {
    const nearA = makeEmbedding([1, 0.01, 0]);
    const nearB = makeEmbedding([1, 0.02, 0]);
    const nearC = makeEmbedding([0.98, 0.05, 0]);

    writeProjectMemoryWithConflicts({
      agentId: CLAUDE,
      content: "Using WAL mode for the database",
      embedding: nearA,
      projectId,
    });

    const intra = writeProjectMemoryWithConflicts({
      agentId: HERMES,
      content: "WAL mode is incompatible with our NFS setup",
      embedding: nearB,
      projectId,
    });

    expect(intra.conflicts).toHaveLength(1);
    expect(intra.conflicts[0]?.conflict_type).toBe("intra_project");

    const equalTierResolution = resolveByTrustTier(db, intra.conflicts[0]!.id);
    expect(equalTierResolution.resolved_at).toBeNull();

    const unresolved = await callToolJson<ConflictToolResponse>("conflicts", {
      project_id: projectId,
    });
    expect(unresolved.conflict_log.map((row) => row.id)).toContain(
      intra.conflicts[0]?.id
    );

    insertMemory(db, {
      user_id: USER,
      scope: "global",
      agent_id: HERMES,
      content: "User prefers PostgreSQL",
      embedding: nearA,
    });

    const cross = writeProjectMemoryWithConflicts({
      agentId: CLAUDE,
      content: "Memryon uses SQLite",
      embedding: nearC,
      projectId,
    });

    expect(
      cross.conflicts.some((row) => row.conflict_type === "cross_scope")
    ).toBe(true);

    const unresolvedRows = getUnresolvedConflicts(db, { projectId });
    expect(
      unresolvedRows.some((row) => row.id === intra.conflicts[0]?.id)
    ).toBe(true);
    expect(
      unresolvedRows.some((row) => row.id === cross.conflicts[0]?.id)
    ).toBe(true);
  });

  it("arbitrates concurrent writes by confidence first and earlier timestamps on ties", () => {
    const baseTime = Date.parse("2026-04-16T20:00:00.000Z");

    const lowerConfidence = insertCandidate({
      content: "Concurrent WAL rollout status",
      agent_id: CLAUDE,
      framework: "codex",
      decision_confidence: 0.72,
      created_at: new Date(baseTime).toISOString(),
    });
    const higherConfidence = insertCandidate({
      content: "Concurrent WAL rollout status",
      agent_id: HERMES,
      framework: "codex",
      decision_confidence: 0.91,
      created_at: new Date(baseTime + 5_000).toISOString(),
    });

    const confidenceOrder = arbitrateConcurrentWrites(db, [
      lowerConfidence,
      higherConfidence,
    ]);

    expect(confidenceOrder[0]?.candidateId).toBe(higherConfidence.id);
    expect(confidenceOrder[1]?.candidateId).toBe(lowerConfidence.id);

    const earlierTie = insertCandidate({
      content: "Concurrent FTS fanout status",
      agent_id: CLAUDE,
      framework: "codex",
      decision_confidence: 0.88,
      created_at: new Date(baseTime + 20_000).toISOString(),
    });
    const laterTie = insertCandidate({
      content: "Concurrent FTS fanout status",
      agent_id: HERMES,
      framework: "codex",
      decision_confidence: 0.88,
      created_at: new Date(baseTime + 45_000).toISOString(),
    });

    const tieOrder = arbitrateConcurrentWrites(db, [earlierTie, laterTie]);

    expect(tieOrder[0]?.candidateId).toBe(earlierTie.id);
    expect(tieOrder[1]?.candidateId).toBe(laterTie.id);
  });

  it("fans recall out in project -> agent -> global order with an accurate scope breakdown", async () => {
    await callToolJson<RememberResponse>("remember", {
      content: "Fanout global memory for Memryon",
      user_id: USER,
      agent_id: HERMES,
      scope: "global",
    });
    await callToolJson<RememberResponse>("remember", {
      content: "Fanout agent memory for Claude Code",
      user_id: USER,
      agent_id: CLAUDE,
      scope: "agent",
    });
    await callToolJson<RememberResponse>("remember", {
      content: "Fanout project memory for the Memryon project",
      user_id: USER,
      agent_id: HERMES,
      scope: "project",
      project_id: projectId,
    });

    const recalled = await callToolJson<RecallResponse>("recall", {
      user_id: USER,
      agent_id: CLAUDE,
      project_id: projectId,
      top_k: 10,
    });

    expect(recalled.results.slice(0, 3).map((row) => row.scope)).toEqual([
      "project",
      "agent",
      "global",
    ]);
    expect(recalled.scope_breakdown).toEqual({
      project: 1,
      agent: 1,
      global: 1,
    });
  });
});
