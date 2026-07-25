import type { Database } from "../../db/connection.js";
import {
  prepareContext,
  type PrepareContextArgs,
  type PrepareContextDependencies,
  type PrepareContextResult,
} from "../../context/prepare-context.js";

export type {
  PrepareContextArgs,
  PrepareContextDependencies,
  PrepareContextResult,
};

export async function handlePrepareContext(
  db: Database,
  args: PrepareContextArgs,
  dependencies: PrepareContextDependencies = {}
): Promise<PrepareContextResult> {
  return prepareContext(db, args, dependencies);
}
