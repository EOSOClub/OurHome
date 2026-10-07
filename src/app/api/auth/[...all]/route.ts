import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/server/auth/auth';
import { isHttpsRequest } from '@/server/security/network';
import { HTTPS_REQUIRED_MESSAGE, isRefusedPlainHttp } from '@/server/services/accessService';
import { needsSetup, setupRequiredMessage } from '@/server/services/setupService';

const handlers = toNextJsHandler(auth);

/**
 * Refuse with a message a client can show as-is (Better Auth's own error shape,
 * which the Android app's sign-in screen displays). A session lookup instead
 * gets the normal "signed out" answer, so a client shows its sign-in screen
 * rather than a connection error, and the reason appears when the user signs in.
 */
function refuse(req: Request, code: string, message: string, status: number): Response {
  if (new URL(req.url).pathname.endsWith('/get-session')) return Response.json(null);
  return Response.json({ code, message }, { status });
}

/**
 * Auth cookies are issued without the Secure flag so sign-in works over plain
 * HTTP on the home network (see auth.ts). When the browser came in over HTTPS,
 * mark them Secure again so they are never sent back over plain HTTP.
 */
function withSecureCookies(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    // A fresh install has no accounts yet: say so, instead of "invalid
    // username or password", and point at setup.
    if (await needsSetup()) {
      return refuse(req, 'SETUP_REQUIRED', setupRequiredMessage(req.headers, req.url), 503);
    }
    // Under "HTTPS only", nothing auth-related happens over plain HTTP from
    // another device: no sign-in, no session (see accessService).
    if (await isRefusedPlainHttp(req.headers, req.url)) {
      return refuse(req, 'HTTPS_REQUIRED', HTTPS_REQUIRED_MESSAGE, 403);
    }
    const res = await handler(req);
    const cookies = res.headers.getSetCookie();
    if (cookies.length === 0 || !isHttpsRequest(req.headers, req.url)) return res;

    const headers = new Headers(res.headers);
    headers.delete('set-cookie');
    for (const cookie of cookies) {
      headers.append('set-cookie', /;\s*secure\b/i.test(cookie) ? cookie : `${cookie}; Secure`);
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

export const GET = withSecureCookies(handlers.GET);
export const POST = withSecureCookies(handlers.POST);
