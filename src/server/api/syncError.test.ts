import { describe, expect, it, vi } from 'vitest';
import { syncFailureMessage } from './syncError';
import { PaperlessError } from '@/server/paperless/client';
import { InboxError } from '@/server/inbox/client';
import { ConflictError } from '@/server/services/errors';

describe('syncFailureMessage', () => {
  it('shows our own readable messages as they are', () => {
    expect(syncFailureMessage(new PaperlessError('Paperless rejected the API token.'), 'x', 't')).toBe(
      'Paperless rejected the API token.',
    );
    expect(syncFailureMessage(new InboxError('Can’t reach OurHomeInbox.'), 'x', 't')).toBe('Can’t reach OurHomeInbox.');
    expect(syncFailureMessage(new ConflictError('Enter the token.'), 'x', 't')).toBe('Enter the token.');
    expect(syncFailureMessage(new Error('Custom field "Amount" doesn’t exist.'), 'x', 't')).toBe(
      'Custom field "Amount" doesn’t exist.',
    );
  });

  it('hides anything else behind the fallback, and logs it', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    class PrismaLikeError extends Error {}
    expect(syncFailureMessage(new PrismaLikeError('connect ECONNREFUSED mongo:27017'), 'Import failed.', 't')).toBe(
      'Import failed.',
    );
    expect(syncFailureMessage(new TypeError('x is undefined'), 'Import failed.', 't')).toBe('Import failed.');
    expect(syncFailureMessage('boom', 'Import failed.', 't')).toBe('Import failed.');
    expect(log).toHaveBeenCalledTimes(3);
    log.mockRestore();
  });
});
