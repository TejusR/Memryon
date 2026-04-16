// ---------------------------------------------------------------------------
// Memryon error hierarchy
// ---------------------------------------------------------------------------

export class MemryonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemryonError";
  }
}

/**
 * Thrown when a scope operation is invalid — e.g. promoting without
 * membership, demoting to a wider scope, or writing project memories
 * without a project_id.
 */
export class ScopeViolationError extends MemryonError {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolationError";
  }
}

/**
 * Thrown when a write would create an unresolvable conflict and the caller
 * should surface it rather than proceed silently.
 */
export class ConflictError extends MemryonError {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
