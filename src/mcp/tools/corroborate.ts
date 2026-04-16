import type { Database } from "../../db/connection.js";
import {
  corroborate,
  getCorroborationCount,
} from "../../db/queries/corroborations.js";

export interface CorroborateArgs {
  memory_id: string;
  agent_id: string;
}

export interface CorroborateResult {
  status: "corroborated";
  corroboration_count: number;
}

/**
 * Records a corroboration and returns the latest corroboration count.
 */
export function handleCorroborate(
  db: Database,
  args: CorroborateArgs
): CorroborateResult {
  corroborate(db, args.memory_id, args.agent_id);
  const count = getCorroborationCount(db, args.memory_id);

  return { status: "corroborated", corroboration_count: count };
}
