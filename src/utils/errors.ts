// ---------------------------------------------------------------------------
// Memryon error hierarchy
// ---------------------------------------------------------------------------

export class MemryonError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MemryonError";
  }
}

/**
 * Thrown when request validation fails before work can begin.
 */
export class ValidationError extends MemryonError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ValidationError";
  }
}

/**
 * Thrown when a requested record cannot be found.
 */
export class NotFoundError extends MemryonError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NotFoundError";
  }
}

/**
 * Thrown when a database call fails after inputs have been validated.
 */
export class DatabaseOperationError extends MemryonError {
  constructor(operation: string, cause: unknown) {
    super(
      `Database operation failed while ${operation}: ${errorMessage(cause)}`,
      cause instanceof Error ? { cause } : undefined
    );
    this.name = "DatabaseOperationError";
  }
}

/**
 * Thrown when a scope operation is invalid - for example promoting without
 * membership, demoting to a wider scope, or writing project memories
 * without a project_id.
 */
export class ScopeViolationError extends MemryonError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScopeViolationError";
  }
}

/**
 * Thrown when a write would create an unresolvable conflict and the caller
 * should surface it rather than proceed silently.
 */
export class ConflictError extends MemryonError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConflictError";
  }
}

/**
 * Returns a human-readable message for unknown error values.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ensures a required string argument is present before continuing.
 */
export function requireNonEmptyString(
  value: string | null | undefined,
  fieldName: string
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${fieldName} is required`);
  }

  return value;
}

/**
 * Ensures a record lookup returned a value and raises a typed not-found error otherwise.
 */
export function requireRecord<T>(
  value: T | undefined,
  message: string
): T {
  if (value === undefined) {
    throw new NotFoundError(message);
  }

  return value;
}

/**
 * Wraps low-level database exceptions in a typed Memryon error while preserving known failures.
 */
export function withDbError<T>(operation: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof MemryonError) {
      throw error;
    }

    throw new DatabaseOperationError(operation, error);
  }
}
