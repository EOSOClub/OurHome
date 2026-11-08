// Shared service-layer error types. The HTTP layer (src/server/api/http.ts)
// maps these to status codes, keeping route handlers free of error plumbing.

import { Prisma } from '@prisma/client';

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

/** Prisma's "transaction failed due to a writing conflict" (Mongo). */
export function isWriteConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
}

/** Prisma's "record to update or delete not found": someone removed it a moment before. */
export function isRecordGone(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

/** Prisma's unique-index clash: a row with that key is already there (often written at the same moment). */
export function isUniqueClash(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Writes [rows] with [createMany]. When one clashes on a unique key (the same
 * alert written by a check-in and the sweep at the same moment), writes them
 * one by one with [createOne] instead and skips the ones already there: those
 * are done, so the clash is no error.
 */
export async function createAllOnce<T>(
  rows: T[],
  createMany: (rows: T[]) => Promise<unknown>,
  createOne: (row: T) => Promise<unknown>,
): Promise<void> {
  try {
    await createMany(rows);
  } catch (err) {
    if (!isUniqueClash(err)) throw err;
    for (const row of rows) {
      try {
        await createOne(row);
      } catch (e) {
        if (!isUniqueClash(e)) throw e;
      }
    }
  }
}

/** What a save that lost a write race says (409), unless its caller says something more exact. */
export const SAME_MOMENT = 'Someone else changed this at the same moment. Try again.';

/**
 * Runs [attempt] (a whole transaction). When two saves touch the same rows at
 * once, Mongo aborts one with a write conflict; that one is answered with a
 * plain ConflictError (409) instead of a 500, and nothing it wrote is kept.
 */
export async function plainWriteConflict<T>(attempt: () => Promise<T>, message: string = SAME_MOMENT): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (isWriteConflict(err)) throw new ConflictError(message);
    throw err;
  }
}
