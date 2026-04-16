import type { Database } from "../../db/connection.js";
import { invalidateMemory } from "../../db/queries/memories.js";
import { MemryonError } from "../../utils/errors.js";

export interface ForgetArgs {
  memcell_id: string;
  agent_id: string;
  reason?: string | undefined;
}

export interface ForgetResult {
  status: "forgotten" | "not_found";
  memcell_id: string;
}

/**
 * Soft-invalidates a memory and reports the outcome.
 */
export function handleForget(db: Database, args: ForgetArgs): ForgetResult {
  const changed = invalidateMemory(db, args.memcell_id, args.agent_id);

  if (!changed) {
    throw new MemryonError(
      `Memory '${args.memcell_id}' not found or already invalidated`
    );
  }

  return { status: "forgotten", memcell_id: args.memcell_id };
}
