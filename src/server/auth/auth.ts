import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { username } from 'better-auth/plugins';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { activeProvider, prisma } from '@/server/db/prisma';
import { sendEmail } from '@/server/email/mailer';
import { APP_NAME } from '@/server/config';
import { isLocalHostname } from '@/server/security/network';
import { isPlaceholderEmail } from '@/lib/placeholderEmail';
import { USERNAME_PATTERN, nameSchema } from '@/lib/validation/user';

const ONE_WEEK = 60 * 60 * 24 * 7;
const ONE_DAY = 60 * 60 * 24;

/**
 * The app is reached at its public URL (BETTER_AUTH_URL, trusted automatically,
 * plus BETTER_AUTH_TRUSTED_ORIGINS) and also by IP or hostname on the home
 * network, which no config can list ahead of time. A home-network origin is
 * trusted only when it is the very host the request was sent to, i.e., a
 * same-origin request, so another site still can't forge a sign-in.
 */
function sameOriginOnHomeNetwork(request?: Request): string[] {
  const origin = request?.headers.get('origin');
  const host = request?.headers.get('host');
  if (!origin || !host) return [];
  try {
    const url = new URL(origin);
    return url.host === host && isLocalHostname(url.hostname) ? [url.origin] : [];
  } catch {
    return [];
  }
}

// Better Auth calls the callbacks in here (sendResetPassword) itself.
// noinspection JSUnusedGlobalSymbols
export const auth = betterAuth({
  appName: APP_NAME,
  // No baseURL: Better Auth uses BETTER_AUTH_URL when set (the public URL, for
  // links in emails) and otherwise the address each request came in on.
  trustedOrigins: sameOriginOnHomeNetwork,
  database: prismaAdapter(prisma, {
    // The app runs on MongoDB (see src/server/db/prisma.ts).
    provider: activeProvider(),
  }),
  emailAndPassword: {
    enabled: true,
    // Accounts are provisioned by the first-run setup and the Head of House, not
    // by public self-registration, so the sign-up endpoint is closed at the API
    // too (both create users directly via Prisma, see setupService/userService).
    disableSignUp: true,
    // Members sign in by username, but their real email backs password recovery.
    resetPasswordTokenExpiresIn: 60 * 60, // 1 hour
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      // A member added without an email has a stand-in address nobody reads
      // (placeholderEmail.ts); the Head of House resets theirs in Members.
      if (isPlaceholderEmail(user.email)) {
        console.warn(`[auth] password reset asked for ${user.id}, who has no real email; nothing sent.`);
        return;
      }
      await sendEmail({
        to: user.email,
        subject: `Reset your ${APP_NAME} password`,
        text: `Hi ${user.name || 'there'},

Someone requested a password reset for your ${APP_NAME} account. Use the link below to set a new password. It expires in 1 hour.

${url}

If you didn't request this, you can safely ignore this email.`,
      });
    },
    // A password chosen through Forgot password is their own too: lift the
    // forced change and end the setup link, as after change-password below.
    // Better Auth calls this only once the reset has succeeded.
    onPasswordReset: async ({ user }) => {
      await prisma.user.update({
        where: { id: user.id },
        data: { mustChangePassword: false, setupLinkHash: null, setupLinkExpiresAt: null },
      });
    },
  },
  session: {
    expiresIn: ONE_WEEK,
    updateAge: ONE_DAY,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
  // Rate limiting. Better Auth's built-in limiter ships strict per-IP defaults
  // (sign-in: 3/10s, password-reset: 3/60s) but is production-only by default;
  // enable it explicitly so the protection never silently depends on NODE_ENV.
  rateLimit: {
    enabled: true,
  },
  advanced: {
    // One cookie name for both ways in: browsers drop Secure cookies on plain
    // HTTP, which would make LAN sign-in impossible. The auth route adds the
    // Secure flag back on HTTPS responses (app/api/auth/[...all]/route.ts), and
    // HSTS keeps browsers off plain HTTP at the public URL.
    useSecureCookies: false,
    // Behind Cloudflare, the only trustworthy client IP is CF-Connecting-IP.
    // Without this, Better Auth keys rate limiting + session IP off the
    // client-spoofable X-Forwarded-For, and an unresolved IP collapses every
    // user into one shared bucket (one attacker could lock everyone out).
    ipAddress: {
      ipAddressHeaders: ['cf-connecting-ip'],
    },
  },
  user: {
    additionalFields: {
      // Application-managed fields. `input: false` keeps them out of the public
      // sign-up payload; they are assigned by setup/the admin via Prisma.
      role: {
        type: 'string',
        required: false,
        defaultValue: 'adult',
        input: false,
      },
      householdId: {
        type: 'string',
        required: false,
        input: false,
      },
      // Forces a password change on next sign-in for admin-provisioned accounts.
      mustChangePassword: {
        type: 'boolean',
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },
  // A temporary password is gone only once the user really changed it: the
  // forced-change flag is lifted here, after Better Auth's change-password
  // succeeded, and not on the client's word (that route could be called
  // without changing anything). Their setup link ends with it: the phone it
  // was for is signed in.
  hooks: {
    // Better Auth's own routes are open to every signed-in member, so the
    // app's rules for them are checked here, before the route runs.
    before: createAuthMiddleware(async (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      if (ctx.path === '/update-user') {
        // The profile form changes the name through this route. A username is
        // changed through /api/profile (profileService), which keeps the
        // stand-in email in step; here it skipped that, and `displayUsername`
        // (what Members shows) was not checked at all, so a member could show
        // up under someone else's username.
        if ('username' in body || 'displayUsername' in body) {
          throw new APIError('BAD_REQUEST', { message: 'Change your username in your profile.' });
        }
        if ('name' in body) {
          const name = nameSchema.safeParse(body.name);
          if (!name.success) {
            throw new APIError('BAD_REQUEST', { message: name.error.issues[0]?.message ?? 'Enter a name.' });
          }
        }
      }
      // "Changing" a password to the same one would lift the forced change
      // below and leave the temporary password, which someone else chose, working.
      if (
        ctx.path === '/change-password' &&
        typeof body.newPassword === 'string' &&
        body.newPassword === body.currentPassword
      ) {
        throw new APIError('BAD_REQUEST', {
          code: 'PASSWORD_UNCHANGED',
          message: 'Choose a password different from the current one.',
        });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/change-password' || isAPIError(ctx.context.returned)) return;
      const userId = ctx.context.session?.user.id;
      if (userId) {
        await prisma.user.update({
          where: { id: userId },
          data: { mustChangePassword: false, setupLinkHash: null, setupLinkExpiresAt: null },
        });
      }
    }),
  },
  // nextCookies() must be last - it bridges Better Auth cookie writes into
  // Next.js server actions. Usernames are checked with the app's own pattern
  // (usernameSchema): Better Auth's default refuses a hyphen, so a member
  // the app created as "mary-jo" could never sign in. Its 3-30 length
  // defaults already match.
  plugins: [username({ usernameValidator: (name) => USERNAME_PATTERN.test(name) }), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
