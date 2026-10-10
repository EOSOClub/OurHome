import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { username } from 'better-auth/plugins';
import { createAuthMiddleware, isAPIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { activeProvider, prisma } from '@/server/db/prisma';
import { sendEmail } from '@/server/email/mailer';
import { APP_NAME } from '@/server/config';
import { isLocalHostname } from '@/server/security/network';

const ONE_WEEK = 60 * 60 * 24 * 7;
const ONE_DAY = 60 * 60 * 24;

/**
 * The app is reached at its public URL (BETTER_AUTH_URL, trusted automatically,
 * plus BETTER_AUTH_TRUSTED_ORIGINS) and also by IP or hostname on the home
 * network, which no config can list ahead of time. A home-network origin is
 * trusted only when it is the very host the request was sent to, i.e. a
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
      await sendEmail({
        to: user.email,
        subject: `Reset your ${APP_NAME} password`,
        text: `Hi ${user.name || 'there'},

Someone requested a password reset for your ${APP_NAME} account. Use the link below to set a new password. It expires in 1 hour.

${url}

If you didn't request this, you can safely ignore this email.`,
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
        defaultValue: 'member',
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
  // succeeded — never on the client's word (that route could be called
  // without changing anything).
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/change-password' || isAPIError(ctx.context.returned)) return;
      const userId = ctx.context.session?.user.id;
      if (userId) {
        await prisma.user.update({ where: { id: userId }, data: { mustChangePassword: false } });
      }
    }),
  },
  // nextCookies() must be last — it bridges Better Auth cookie writes into
  // Next.js server actions.
  plugins: [username(), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
