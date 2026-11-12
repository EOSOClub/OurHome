'use client';

import { useEffect } from 'react';

/** Ask again when the tab comes back after this long (a tab left open for days). */
const AGAIN_AFTER_MS = 60 * 60 * 1000;

/**
 * Keeps a signed-in browser signed in. Better Auth extends a session, and
 * sends the cookie for it, when /api/auth/get-session is asked once the
 * session is a day old. Pages and the app's own API routes read the session
 * without extending it (server/auth/session.ts), so the website asks here:
 * once on each full load, and again when a tab left open comes back to the
 * front. The answer isn't used. Signed out, it answers null and nothing
 * happens.
 */
export function SessionKeepAlive() {
  useEffect(() => {
    let last = 0;
    const ask = () => {
      if (Date.now() - last < AGAIN_AFTER_MS) return;
      last = Date.now();
      void fetch('/api/auth/get-session', { credentials: 'same-origin', cache: 'no-store' }).catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') ask();
    };
    ask();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  return null;
}
