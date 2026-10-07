import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { getServerSession, type AuthUser } from '@/server/auth/session';
import {
  ACCESS_PAGE_LABELS,
  can,
  canModify,
  hasAnyAccess,
  type AccessMatrix,
  type AccessPage,
  type Permission,
} from '@/lib/permissions';
import { getUserAccess } from '@/server/services/permissionService';
import { isUserRole, type UserRole } from '@/lib/enums';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@/server/services/errors';

// Thin, reusable HTTP layer so route handlers contain no business logic:
//   route handler -> withAuth -> parse (Zod) -> service.

export interface AuthedContext {
  user: AuthUser;
  req: NextRequest;
}

type Handler = (ctx: AuthedContext) => Promise<Response> | Response;

/** Structured success envelope. */
export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

/** Structured error envelope. */
export function fail(message: string, status: number, details?: unknown) {
  return NextResponse.json(
    { ok: false, error: { message, details } },
    { status },
  );
}

/**
 * Wraps a route handler with authentication, household scoping, a best-effort
 * rate limit, audit logging, and uniform error handling.
 */
export function withAuth(handler: Handler) {
  return async (req: NextRequest): Promise<Response> => {
    if (!allowRequest(req)) {
      return fail('Too many requests', 429);
    }

    const session = await getServerSession();
    if (!session?.user) return fail('Unauthorized', 401);

    const user = session.user as unknown as AuthUser;
    if (!user.householdId) return fail('No household assigned', 403);

    try {
      const res = await handler({ user, req });
      recordAudit(user, req, res.status);
      return res;
    } catch (err) {
      return handleError(err, user, req);
    }
  };
}

/** Require the caller's role to grant `permission`; throws ForbiddenError otherwise. */
export function requirePermission(
  ctx: AuthedContext,
  permission: Permission,
): void {
  if (!can(ctx.user.role, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`);
  }
}

// Page access is loaded from the database once per request and reused by
// every check in that request.
const accessCache = new WeakMap<AuthedContext, Promise<AccessMatrix>>();

/** The caller's effective page-access grid. */
export function getAccess(ctx: AuthedContext): Promise<AccessMatrix> {
  let access = accessCache.get(ctx);
  if (!access) {
    access = getUserAccess(ctx.user);
    accessCache.set(ctx, access);
  }
  return access;
}

/** Require the caller may add records on `page`. */
export async function requireCreate(
  ctx: AuthedContext,
  page: AccessPage,
): Promise<void> {
  const access = await getAccess(ctx);
  if (!access[page].create) {
    throw new ForbiddenError(`You can't add to ${ACCESS_PAGE_LABELS[page]}.`);
  }
}

/**
 * Require the caller may edit or delete a record on `page` created by
 * `ownerId` (resolve it with recordOwner.* first — that also 404s a record
 * outside the household).
 */
export async function requireModify(
  ctx: AuthedContext,
  page: AccessPage,
  kind: 'edit' | 'delete',
  ownerId: string | null,
): Promise<void> {
  const access = await getAccess(ctx);
  if (!canModify(access[page], kind, ownerId, ctx.user.id)) {
    const whose = ownerId === ctx.user.id ? 'your' : "other people's";
    throw new ForbiddenError(
      `You can't ${kind} ${whose} items on ${ACCESS_PAGE_LABELS[page]}.`,
    );
  }
}

/**
 * Require any access at all on `page`. Used for everyday actions that aren't
 * add/edit/delete: ticking off a shopping item, adjusting stock, an NFC scan.
 */
export async function requireAnyAccess(
  ctx: AuthedContext,
  page: AccessPage,
): Promise<void> {
  const access = await getAccess(ctx);
  if (!hasAnyAccess(access[page])) {
    throw new ForbiddenError(`You don't have access to ${ACCESS_PAGE_LABELS[page]}.`);
  }
}

/** Require the caller to hold one of `roles`; throws ForbiddenError otherwise. */
export function requireRole(ctx: AuthedContext, ...roles: UserRole[]): void {
  if (!isUserRole(ctx.user.role) || !roles.includes(ctx.user.role)) {
    throw new ForbiddenError(`Requires role: ${roles.join(' or ')}`);
  }
}

/** Parse and validate a JSON body, throwing ZodError on failure. */
export async function parseBody<T>(
  req: NextRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await req.json().catch(() => ({}));
  return schema.parse(raw);
}

/** Parse and validate the query string, throwing ZodError on failure. */
export function parseQuery<T>(req: NextRequest, schema: z.ZodType<T>): T {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  return schema.parse(params);
}

function handleError(err: unknown, user: AuthUser, req: NextRequest): Response {
  if (err instanceof ZodError) {
    return fail('Validation failed', 422, z.flattenError(err));
  }
  if (err instanceof NotFoundError) {
    return fail(err.message, 404);
  }
  if (err instanceof ForbiddenError) {
    return fail(err.message, 403);
  }
  if (err instanceof ConflictError) {
    return fail(err.message, 409);
  }
  console.error('[api] unhandled error', {
    path: new URL(req.url).pathname,
    user: user.id,
    err,
  });
  return fail('Internal server error', 500);
}

// --- Rate limiting (best-effort, in-memory) -------------------------------
// Single-instance fixed-window limiter. Swap for Redis/Upstash when running
// multiple instances behind a load balancer.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;
const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * The real client IP. Behind the Cloudflare Tunnel, `cf-connecting-ip` is set by
 * Cloudflare and is the only value a client can't forge. `x-forwarded-for` is
 * client-controlled on the first hop, so it is used only as a fallback for
 * non-Cloudflare access (e.g. local dev). Unknown IPs share a single bucket.
 */
export function clientIp(req: NextRequest): string {
  return (
    req.headers.get('cf-connecting-ip')?.trim() ||
    req.headers.get('x-real-ip')?.trim() ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

/**
 * Fixed-window limiter keyed by an arbitrary string. Returns false once more than
 * `max` calls land in the same `windowMs`. Public endpoints that don't use
 * `withAuth` (e.g. the contact form) reuse this with their own key + budget.
 */
export function rateLimit(key: string, windowMs: number, max: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

function allowRequest(req: NextRequest): boolean {
  const key = `${clientIp(req)}:${new URL(req.url).pathname}`;
  return rateLimit(key, WINDOW_MS, MAX_PER_WINDOW);
}

// --- Audit logging (hook) -------------------------------------------------
// Domain changes are recorded in the activity feed (ActivityEntry). This hook
// is the seam for security/audit logging of API access; wire to a sink later.
function recordAudit(user: AuthUser, req: NextRequest, status: number) {
  if (process.env.NODE_ENV === 'development') {
    console.debug(
      `[audit] ${req.method} ${new URL(req.url).pathname} -> ${status} (user ${user.id})`,
    );
  }
}
