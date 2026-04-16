import type { Database } from "better-sqlite3";
import {
  RegisterAgentInputSchema,
  type RegisterAgentInput,
} from "../../mcp/schemas.js";

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export interface AgentRow {
  agent_id: string;
  display_name: string;
  trust_tier: 1 | 2 | 3;
  /** JSON-serialised string[]. Parse with JSON.parse(). */
  capabilities: string;
  registered_at: string;
}

// ---------------------------------------------------------------------------
// registerAgent
// ---------------------------------------------------------------------------

export function registerAgent(
  db: Database,
  input: RegisterAgentInput
): AgentRow {
  const parsed = RegisterAgentInputSchema.parse(input);
  const capabilities = JSON.stringify(parsed.capabilities);

  db.prepare(
    `INSERT INTO agents (agent_id, display_name, trust_tier, capabilities)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (agent_id) DO UPDATE
       SET display_name  = excluded.display_name,
           trust_tier    = excluded.trust_tier,
           capabilities  = excluded.capabilities`
  ).run(parsed.agentId, parsed.displayName, parsed.trustTier, capabilities);

  return db
    .prepare<[string], AgentRow>(`SELECT * FROM agents WHERE agent_id = ?`)
    .get(parsed.agentId) as AgentRow;
}

// ---------------------------------------------------------------------------
// getAgent
// ---------------------------------------------------------------------------

export function getAgent(
  db: Database,
  agentId: string
): AgentRow | undefined {
  if (!agentId) throw new Error("agentId is required");

  return db
    .prepare<[string], AgentRow>(`SELECT * FROM agents WHERE agent_id = ?`)
    .get(agentId);
}

// ---------------------------------------------------------------------------
// getAgentTrustTier
// ---------------------------------------------------------------------------

export function getAgentTrustTier(
  db: Database,
  agentId: string
): 1 | 2 | 3 {
  if (!agentId) throw new Error("agentId is required");

  const row = db
    .prepare<[string], { trust_tier: 1 | 2 | 3 }>(
      `SELECT trust_tier FROM agents WHERE agent_id = ?`
    )
    .get(agentId);

  if (!row) throw new Error(`Agent '${agentId}' not found`);
  return row.trust_tier;
}
