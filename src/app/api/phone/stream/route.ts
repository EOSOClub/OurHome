import { parseQuery, withAuth } from '@/server/api/http';
import { addStream } from '@/server/push/streamHub';
import { recordStream } from '@/server/services/phoneStatusService';
import { phoneStreamQuerySchema } from '@/lib/validation/phone';

// Stay connected (the Android app's StayConnectedService): one long-lived
// server-sent events stream per phone. Every push to the member is written
// here too (pushService), as `data: {json}`, the same fields a Firebase
// message carries. Nothing is stored; a phone that isn't connected just
// misses the stream copy and gets Firebase's, or catches up hourly.

/**
 * A comment line this often keeps proxies and NAT from closing an idle
 * connection (nginx's default is 60 s, Cloudflare's 100 s). The phone
 * reconnects when it hears nothing for two of these.
 */
const PING_MS = 45_000;
/**
 * The stream ends after this long and the phone reconnects at once, so a
 * session signed out or a member removed meanwhile is checked again.
 */
const MAX_MS = 30 * 60_000;

/** Opening and closing are both heard from the phone; a failure to note it never ends the stream. */
function noteStream(...args: Parameters<typeof recordStream>) {
  recordStream(...args).catch((err) => console.warn('[stream] noting the phone failed:', err));
}

export const GET = withAuth(async (ctx) => {
  const { installId, ...status } = parseQuery(ctx.req, phoneStreamQuerySchema);
  const householdId = ctx.user.householdId!;
  const userId = ctx.user.id;
  const encoder = new TextEncoder();
  let cleanup = () => {};
  let closed = false;
  // Status fields come only from a phone an adult looks after.
  const sentStatus = Object.values(status).some((v) => v !== undefined);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(text));
      const close = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed by the phone going away.
        }
      };
      const remove = addStream({
        householdId,
        userId,
        installId,
        send: (data) => write(`data: ${JSON.stringify(data)}\n\n`),
      });
      const ping = setInterval(() => {
        try {
          write(': ping\n\n');
        } catch {
          close();
        }
      }, PING_MS);
      const end = setTimeout(close, MAX_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        clearTimeout(end);
        remove();
        // Gone: if it doesn't come back, the supervisors hear why (phoneStatusService).
        noteStream(householdId, userId, installId, { opened: false });
      };
      ctx.req.signal.addEventListener('abort', close);
      // The phone counts the connection as up once this arrives.
      write('event: hello\ndata: {}\n\n');
      noteStream(householdId, userId, installId, { opened: true, status: sentStatus ? status : undefined });
      console.log(`[stream] phone connected (user ${userId})`);
    },
    cancel() {
      cleanup();
      console.log(`[stream] phone disconnected (user ${userId})`);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform: Next's gzip would otherwise hold the events back.
      'Cache-Control': 'no-cache, no-transform',
      // nginx: pass each event on at once instead of buffering.
      'X-Accel-Buffering': 'no',
    },
  });
});
