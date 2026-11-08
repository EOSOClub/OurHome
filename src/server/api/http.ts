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
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  TooManyRequestsError,
  UnprocessableError,
} from '@/server/services/errors';
import {
  HOUSEHOLD_DISABLED_MESSAGE,
  isFeatureEnabled,
  isHouseholdDisabled,
  isServerAdmin,
} from '@/server/services/serverAdminService';
import { FEATURE_LABELS, featureForPath, type Feature } from '@/lib/features';
import { fieldErrors, validationMessage } from '@/lib/validation/messages';

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
    if (isCrossSiteWrite(req)) return fail('Refused: this request came from another site.', 403);

    const session = await getServerSession();
    if (!session?.user) return fail('Unauthorized', 401);

    const user = session.user as unknown as AuthUser;
    if (!allowUser(user, req)) return fail('Too many requests', 429);
    if (!user.householdId) return fail('No household assigned', 403);
    // A household the server admin turned off: refused until it's back on.
    // `code` lets the app sign out with this message instead of erroring everywhere.
    if (await isHouseholdDisabled(user.householdId)) {
      return fail(HOUSEHOLD_DISABLED_MESSAGE, 403, { code: 'household_disabled' });
    }
    // A feature the server admin turned off for this household: its whole API
    // is refused, whatever the page-access grid says.
    const feature = featureForPath(new URL(req.url).pathname);
    if (feature && !(await isFeatureEnabled(user.householdId, feature))) {
      return fail(`${FEATURE_LABELS[feature]} is turned off for this household.`, 403, {
        code: 'feature_disabled',
        feature,
      });
    }

    try {
      const res = await handler({ user, req });
      recordAudit(user, req, res.status);
      return res;
    } catch (err) {
      return handleError(err, user, req);
    }
  };
}

/**
 * A change (anything but GET/HEAD/OPTIONS) that a browser says was started by
 * another site. The session cookie is SameSite=Lax, which stops other sites
 * but not a sibling subdomain ("same-site"), and parseBody accepts a body
 * sent as plain text, which a form on another page can send. Browsers set
 * Sec-Fetch-Site themselves and pages can't change it; the Android app and
 * other non-browser callers don't send it, so they are unaffected. Not the
 * Host/Origin comparison: behind a reverse proxy the Host this server sees
 * can differ from the address the browser used.
 */
export function isCrossSiteWrite(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
  const site = req.headers.get('sec-fetch-site');
  return site === 'cross-site' || site === 'same-site';
}

/**
 * Like withAuth, for the server admin's endpoints (households, HTTPS only,
 * contact messages): the caller needn't belong to a household - a server
 * admin may have none - but must be the server admin.
 */
export function withServerAdmin(handler: Handler) {
  return async (req: NextRequest): Promise<Response> => {
    if (!allowRequest(req)) {
      return fail('Too many requests', 429);
    }
    if (isCrossSiteWrite(req)) return fail('Refused: this request came from another site.', 403);
    const session = await getServerSession();
    if (!session?.user) return fail('Unauthorized', 401);
    const user = session.user as unknown as AuthUser;
    if (!allowUser(user, req)) return fail('Too many requests', 429);
    try {
      if (!(await isServerAdmin(user.id))) return fail('Only the server admin can do that.', 403);
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
 * `ownerId` (resolve it with recordOwner.* first - that also 404s a record
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
  if (!hasAnyAccess(access[page], page)) {
    throw new ForbiddenError(`You don't have access to ${ACCESS_PAGE_LABELS[page]}.`);
  }
}

/**
 * Require a feature other than the one the route's path belongs to (a bill
 * put on the calendar also needs Calendar on).
 */
export async function requireFeatureOn(ctx: AuthedContext, feature: Feature): Promise<void> {
  if (!(await isFeatureEnabled(ctx.user.householdId!, feature))) {
    throw new ForbiddenError(`${FEATURE_LABELS[feature]} is turned off for this household.`);
  }
}

/**
 * Most bytes an ordinary JSON body may have. The largest everyday one is a
 * phone's batch of app icons (20 at up to 44,000 characters, about 0.9 MB);
 * everything else is a small form. The proxy doesn't cover /api, so without a
 * cap one huge POST could fill the server's memory.
 */
export const BODY_MAX_BYTES = 2 * 1024 * 1024;
/** Most bytes a public form (contact, setup, webhooks) may send. */
export const PUBLIC_BODY_MAX_BYTES = 64 * 1024;

/**
 * Parse and validate a JSON body, throwing ZodError on failure, and
 * PayloadTooLargeError (413) when it is bigger than [maxBytes].
 */
export async function parseBody<T>(
  req: NextRequest,
  schema: z.ZodType<T>,
  maxBytes: number = BODY_MAX_BYTES,
): Promise<T> {
  const raw = await readJsonCapped(req, maxBytes);
  return schema.parse(raw);
}

/**
 * Read a JSON body of at most [maxBytes] bytes, for a route that takes more
 * than a form (a photo sent with a check). Refused with 413 as soon as it's
 * known to be too big: from Content-Length before anything is read, or while
 * reading when the header is missing or wrong, so memory stays bounded.
 * parseBody is built on it. A body that isn't JSON (or a dropped connection)
 * reads as {}, so the route's schema says what's missing.
 */
export async function readJsonCapped(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError();
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      return {};
    }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError();
    }
    chunks.push(chunk.value);
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return {};
  }
}

/** Parse and validate the query string, throwing ZodError on failure. */
export function parseQuery<T>(req: NextRequest, schema: z.ZodType<T>): T {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  return schema.parse(params);
}

/**
 * A form that didn't pass validation: a message saying what's wrong with
 * which field (shown as is in the toast), and in details, Zod's per-field
 * errors so a form can mark the fields (fieldErrors in lib/api.ts).
 */
export function validationFailed(err: ZodError): Response {
  // Zod's flattened shape, with each field's message saying where inside it a nested problem is.
  const fields = Object.fromEntries(Object.entries(fieldErrors(err.issues)).map(([key, message]) => [key, [message]]));
  return fail(validationMessage(err.issues), 422, { formErrors: z.flattenError(err).formErrors, fieldErrors: fields });
}

/** A refusal that names the field it's about: the same shape as a validation failure, so the form marks it. */
function fieldDetails(field: string | undefined, message: string) {
  return field ? { fieldErrors: { [field]: [message] } } : undefined;
}

/** A refusal's details: its machine code (as `household_disabled` above) alongside any field. */
function codedDetails(code: string | undefined, field: string | undefined, message: string) {
  const fields = fieldDetails(field, message);
  return code ? { code, ...fields } : fields;
}

function handleError(err: unknown, user: AuthUser, req: NextRequest): Response {
  if (err instanceof ZodError) {
    return validationFailed(err);
  }
  if (err instanceof NotFoundError) {
    return fail(err.message, 404);
  }
  if (err instanceof ForbiddenError) {
    return fail(err.message, 403, fieldDetails(err.field, err.message));
  }
  if (err instanceof ConflictError) {
    return fail(err.message, 409, codedDetails(err.code, err.field, err.message));
  }
  if (err instanceof UnprocessableError) {
    return fail(err.message, 422, fieldDetails(err.field, err.message));
  }
  if (err instanceof PayloadTooLargeError) {
    return fail(err.message, 413);
  }
  if (err instanceof TooManyRequestsError) {
    return fail(err.message, 429);
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
 * non-Cloudflare access (e.g., local dev). Unknown IPs share a single bucket.
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
 * `withAuth` (e.g., the contact form) reuse this with their own key and budget.
 */
export function rateLimit(key: string, windowMs: number, max: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    if (buckets.size >= PRUNE_AT) pruneBuckets(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

/**
 * Keys carry the path, and paths carry record ids, so without pruning the map
 * would grow for as long as the server runs. Past [PRUNE_AT] buckets, the
 * expired ones are dropped before a new one is added.
 */
const PRUNE_AT = 5_000;
function pruneBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}

/** For tests: how many buckets are held. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}

/**
 * Before the session is read: by address and path. On the home network,
 * without a proxy in front, there is no address header at all, so every
 * device shares the "unknown" bucket; it gets a bigger budget, and the real
 * per-person limit is [allowUser], once we know who is asking.
 */
const UNKNOWN_IP_MULTIPLIER = 10;
function allowRequest(req: NextRequest): boolean {
  const ip = clientIp(req);
  const key = `${ip}:${new URL(req.url).pathname}`;
  return rateLimit(key, WINDOW_MS, ip === 'unknown' ? MAX_PER_WINDOW * UNKNOWN_IP_MULTIPLIER : MAX_PER_WINDOW);
}

/** After the session is read: per member and path, whatever the address. */
function allowUser(user: AuthUser, req: NextRequest): boolean {
  return rateLimit(`user:${user.id}:${new URL(req.url).pathname}`, WINDOW_MS, MAX_PER_WINDOW);
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
