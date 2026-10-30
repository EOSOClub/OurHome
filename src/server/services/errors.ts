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
 * Thrown when an action conflicts with existing state (e.g., a duplicate name).
 * [field]: the form field whose value caused it, so the form can mark it.
 * [code]: a stable machine code sent as `error.details.code`, for a refusal
 * an app acts on (so it never matches the message text).
 */
export class ConflictError extends Error {
  readonly field?: string;
  readonly code?: string;
  constructor(message: string, field?: string, code?: string) {
    super(message);
    this.name = 'ConflictError';
    this.field = field;
    this.code = code;
  }
}

/**
 * Thrown when something sent can't be used though it passed the schema (a
 * photo that isn't a JPEG we accept). Answered 422, like a failed form.
 * [field]: the form field it's about, so the form can mark it.
 */
export class UnprocessableError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'UnprocessableError';
    this.field = field;
  }
}

/** Thrown when a request body is bigger than its route allows (413). */
export class PayloadTooLargeError extends Error {
  constructor(message = 'That’s too big to send.') {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

/** Thrown when the caller did one thing too often in a short time (429). */
export class TooManyRequestsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooManyRequestsError';
  }
}
