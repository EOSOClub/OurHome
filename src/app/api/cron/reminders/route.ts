import { type NextRequest } from 'next/server';
import { fail, ok } from '@/server/api/http';
import { runReminderSweep } from '@/server/services/reminderSweep';

// On-demand reminder sweep for every household. The production server already
// runs it every 15 minutes (src/instrumentation.ts); this lets a person or an
// outside scheduler trigger one now. It authenticates with a shared CRON_SECRET
// bearer rather than a session cookie (like the NFC webhook).
export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return fail('CRON_SECRET not configured', 503);

  const token = extractToken(req);
  if (token !== secret) return fail('Unauthorized', 401);

  return ok(await runReminderSweep());
}

function extractToken(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() || null;
  }
  return req.headers.get('x-cron-secret')?.trim() || null;
}
