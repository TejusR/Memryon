import type { Database } from "better-sqlite3";
import {
  RegisterAgentInputSchema,
  type RegisterAgentInput,
} from "../../mcp/schemas.js";
import {
  requireNonEmptyString,
  requireRecord,
  withDbError,
} from "../../utils/errors.js";

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

/**
 * Creates or updates an agent record and returns the persisted row.
 */
export function registerAgent(db: Database, input: RegisterAgentInput): AgentRow {
  const parsed = RegisterAgentInputSchema.parse(input);
  const capabilities = JSON.stringify(parsed.capabilities);

  return withDbError(`registering agent '${parsed.agentId}'`, () => {
    db.prepare(
      `INSERT INTO agents (agent_id, display_name, trust_tier, capabilities)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE
         SET display_name  = excluded.display_name,
             trust_tier    = excluded.trust_tier,
             capabilities  = excluded.capabilities`
    ).run(parsed.agentId, parsed.displayName, parsed.trustTier, capabilities);

    return requireRecord(
      db
        .prepare<[string], AgentRow>(`SELECT * FROM agents WHERE agent_id = ?`)
        .get(parsed.agentId),
      `Agent '${parsed.agentId}' was not found after registration`
    );
  });
}

// ---------------------------------------------------------------------------
// getAgent
// ---------------------------------------------------------------------------

/**
 * Looks up a single agent row by identifier.
 */
export function getAgent(db: Database, agentId: string): AgentRow | undefined {
  const resolvedAgentId = requireNonEmptyString(agentId, "agentId");

  return withDbError(`loading agent '${resolvedAgentId}'`, () =>
    db
      .prepare<[string], AgentRow>(`SELECT * FROM agents WHERE agent_id = ?`)
      .get(resolvedAgentId)
  );
}

// ---------------------------------------------------------------------------
// getAgentTrustTier
// ---------------------------------------------------------------------------

/**
 * Returns the trust tier for an existing agent.
 */
export function getAgentTrustTier(db: Database, agentId: string): 1 | 2 | 3 {
  const resolvedAgentId = requireNonEmptyString(agentId, "agentId");

  return withDbError(`loading trust tier for agent '${resolvedAgentId}'`, () => {
    const row = requireRecord(
      db
        .prepare<[string], { trust_tier: 1 | 2 | 3 }>(
          `SELECT trust_tier FROM agents WHERE agent_id = ?`
        )
        .get(resolvedAgentId),
      `Agent '${resolvedAgentId}' not found`
    );

    return row.trust_tier;
  });
}
