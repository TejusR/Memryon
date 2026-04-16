import path from "node:path";
import { closeDb, getDb } from "../src/db/connection.js";
import { registerAgent } from "../src/db/queries/agents.js";
import { logConflict } from "../src/db/queries/conflicts.js";
import {
  getMemoryById,
  insertMemory,
  type MemoryRow,
} from "../src/db/queries/memories.js";
import { addAgent, createProject } from "../src/db/queries/projects.js";
import {
  checkCrossScopeConflicts,
  checkIntraProjectConflicts,
  resolveByTrustTier,
} from "../src/scope/conflict-detection.js";

interface LoggedConflictSummary {
  id: string;
  type: "intra_project" | "cross_scope";
  memoryA: string;
  memoryB: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
}

const dbPath =
  process.env["MEMRYON_DB_PATH"] ??
  path.resolve(process.cwd(), "memryon.seed.db");
const userId = "seed-user";
const codexAgentId = "seed-codex";
const hermesAgentId = "seed-hermes";

function makeEmbedding(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer.slice(0));
}

function describeMemory(label: string, memory: MemoryRow): string {
  return `${label}: ${memory.id} (${memory.scope})`;
}

function recordDetectedConflicts(input: {
  projectId: string;
  memory: MemoryRow;
  resolveAfterLog?: boolean;
}): LoggedConflictSummary[] {
  const detected = [
    ...checkIntraProjectConflicts(db, input.memory),
    ...checkCrossScopeConflicts(db, input.memory),
  ];

  return detected.map((candidate) => {
    const conflict = logConflict(db, {
      memoryA: input.memory.id,
      memoryB: candidate.existingMemoryId,
      projectId: input.projectId,
      conflictType: candidate.conflictType,
    });

    const resolved = input.resolveAfterLog
      ? resolveByTrustTier(db, conflict.id)
      : conflict;

    return {
      id: resolved.id,
      type: candidate.conflictType,
      memoryA: resolved.memory_a,
      memoryB: resolved.memory_b,
      resolvedAt: resolved.resolved_at,
      resolvedBy: resolved.resolved_by,
      resolution: resolved.resolution,
    };
  });
}

const db = getDb(dbPath);

try {
  registerAgent(db, {
    agentId: codexAgentId,
    displayName: "Seed Codex",
    trustTier: 2,
    capabilities: ["remember", "recall", "project_context"],
  });
  registerAgent(db, {
    agentId: hermesAgentId,
    displayName: "Seed Hermes",
    trustTier: 3,
    capabilities: ["remember", "recall", "conflicts", "promote"],
  });

  const project = createProject(db, {
    userId,
    name: `Seed Demo ${new Date().toISOString()}`,
    description: "Demo project created by scripts/seed.ts",
  });

  addAgent(db, {
    projectId: project.id,
    agentId: codexAgentId,
    role: "owner",
  });
  addAgent(db, {
    projectId: project.id,
    agentId: hermesAgentId,
    role: "contributor",
  });

  const agentMemory = insertMemory(db, {
    user_id: userId,
    scope: "agent",
    agent_id: codexAgentId,
    content:
      "Seed note: codex is exploring refactors privately before sharing them.",
    tags: ["seed", "agent"],
  });

  const globalMemory = insertMemory(db, {
    user_id: userId,
    scope: "global",
    agent_id: hermesAgentId,
    content: "Seed global fact: Memryon defaults to SQLite with WAL enabled.",
    tags: ["seed", "global"],
    embedding: makeEmbedding([1, 0.01, 0]),
  });

  const projectMemoryA = insertMemory(db, {
    user_id: userId,
    scope: "project",
    agent_id: codexAgentId,
    project_id: project.id,
    content: "Seed project fact: the shared project is standardizing on SQLite.",
    tags: ["seed", "project"],
    embedding: makeEmbedding([1, 0.02, 0]),
  });

  const projectMemoryB = insertMemory(db, {
    user_id: userId,
    scope: "project",
    agent_id: hermesAgentId,
    project_id: project.id,
    content: "Seed project fact: SQLite remains the source of truth for local runs.",
    tags: ["seed", "project", "conflict-demo"],
    embedding: makeEmbedding([1, 0.03, 0]),
  });

  const conflicts = [
    ...recordDetectedConflicts({
      projectId: project.id,
      memory: projectMemoryA,
      resolveAfterLog: true,
    }),
    ...recordDetectedConflicts({
      projectId: project.id,
      memory: projectMemoryB,
      resolveAfterLog: true,
    }),
  ];

  const unresolved = conflicts.filter((conflict) => conflict.resolvedAt === null);

  console.log("Seeded Memryon demo data");
  console.log(`Database: ${dbPath}`);
  console.log(`Project: ${project.id}`);
  console.log(describeMemory("Agent memory", agentMemory));
  console.log(describeMemory("Global memory", globalMemory));
  console.log(describeMemory("Project memory A", projectMemoryA));
  console.log(describeMemory("Project memory B", projectMemoryB));
  console.log("");
  console.log("Conflict detection flow");

  if (conflicts.length === 0) {
    console.log("No conflicts were detected.");
  } else {
    for (const conflict of conflicts) {
      console.log(
        [
          `- ${conflict.id}`,
          `type=${conflict.type}`,
          `memoryA=${conflict.memoryA}`,
          `memoryB=${conflict.memoryB}`,
          `resolved=${conflict.resolvedAt !== null}`,
          conflict.resolution ? `resolution=${conflict.resolution}` : undefined,
          conflict.resolvedBy ? `resolvedBy=${conflict.resolvedBy}` : undefined,
        ]
          .filter(Boolean)
          .join(" ")
      );
    }
  }

  console.log("");
  console.log(
    `Summary: 2 agents, 1 project, 4 memories, ${conflicts.length} conflicts, ${unresolved.length} unresolved.`
  );

  const latestProjectMemory = getMemoryById(db, projectMemoryB.id);
  if (latestProjectMemory) {
    console.log(
      `Latest project memory scope check: ${latestProjectMemory.id} remains in '${latestProjectMemory.scope}' scope.`
    );
  }
} finally {
  closeDb(dbPath);
}
