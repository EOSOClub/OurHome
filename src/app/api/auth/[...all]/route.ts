import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/server/auth/auth';
import { isHttpsRequest } from '@/server/security/network';
import { HTTPS_REQUIRED_MESSAGE, isRefusedPlainHttp } from '@/server/services/accessService';

const handlers = toNextJsHandler(auth);

/**
 * Auth cookies are issued without the Secure flag so sign-in works over plain
 * HTTP on the home network (see auth.ts). When the browser came in over HTTPS,
 * mark them Secure again so they are never sent back over plain HTTP.
 */
function withSecureCookies(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    // Under "HTTPS only", nothing auth-related happens over plain HTTP from
    // another device: no sign-in, no session (see accessService).
    if (await isRefusedPlainHttp(req.headers, req.url)) {
      return Response.json(
        { code: 'HTTPS_REQUIRED', message: HTTPS_REQUIRED_MESSAGE },
        { status: 403 },
      );
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
