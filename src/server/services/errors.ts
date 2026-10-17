// Shared service-layer error types. The HTTP layer (src/server/api/http.ts)
// maps these to status codes, keeping route handlers free of error plumbing.

/** Thrown when a requested entity doesn't exist (or isn't in the caller's household). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Thrown when the caller is authenticated but lacks permission for the action.
 * [field]: the form field whose value caused it (a wrong current password), so the form can mark it.
 */
export class ForbiddenError extends Error {
  readonly field?: string;
  constructor(message = 'Forbidden', field?: string) {
    super(message);
    this.name = 'ForbiddenError';
    this.field = field;
  }
}

/**
 * Thrown when an action conflicts with existing state (e.g. a duplicate name).
 * [field]: the form field whose value caused it, so the form can mark it.
 */
export class ConflictError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ConflictError';
    this.field = field;
  }
}
