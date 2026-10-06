// Shared service-layer error types. The HTTP layer (src/server/api/http.ts)
// maps these to status codes, keeping route handlers free of error plumbing.

/** Thrown when a requested entity doesn't exist (or isn't in the caller's household). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Thrown when the caller is authenticated but lacks permission for the action. */
export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Thrown when an action conflicts with existing state (e.g. a duplicate name). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
