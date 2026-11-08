import { PaperlessError } from '@/server/paperless/client';
import { InboxError } from '@/server/inbox/client';
import { InboxReplyError } from '@/server/inbox/mapping';
import { ConflictError } from '@/server/services/errors';

/**
 * What "Check now" shows when an import fails. Our own messages are written
 * for the person setting the connection up (wrong token, can't reach the
 * address, a missing custom field), so they are shown as they are: the
 * connection errors, ConflictError, and plain `Error`s thrown by the sync code.
 * Anything else (a database or programming error) can name internal hosts or
 * code, so it is logged and replaced by [fallback].
 */
export function syncFailureMessage(err: unknown, fallback: string, logTag: string): string {
  if (
    err instanceof PaperlessError ||
    err instanceof InboxError ||
    err instanceof InboxReplyError ||
    err instanceof ConflictError ||
    (err instanceof Error && err.constructor === Error)
  ) {
    return err.message;
  }
  console.error(`[${logTag}] import failed`, err);
  return fallback;
}
