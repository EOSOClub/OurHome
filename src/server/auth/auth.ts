import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { username } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { activeProvider, prisma } from '@/server/db/prisma';
import { sendEmail } from '@/server/email/mailer';
import { APP_NAME } from '@/server/config';

const ONE_WEEK = 60 * 60 * 24 * 7;
const ONE_DAY = 60 * 60 * 24;

export const auth = betterAuth({
  appName: APP_NAME,
  // The app is reached over HTTPS at a single public origin (e.g. behind a
  // Cloudflare Tunnel). Better Auth's CSRF guard already trusts BETTER_AUTH_URL
  // plus the comma-separated BETTER_AUTH_TRUSTED_ORIGINS env var, so the
  // deployment sets both to its public URL — no origin reflection needed.
  database: prismaAdapter(prisma, {
    // The app runs on MongoDB (see src/server/db/prisma.ts).
    provider: activeProvider(),
  }),
  emailAndPassword: {
    enabled: true,
    // Two-member household — accounts are provisioned by the seed/admin, not by
    // public self-registration. The UI exposes sign-in only, and now that the
    // app is internet-reachable the sign-up endpoint is closed at the API too
    // (the seed creates users directly via Prisma, see scripts/seed.ts).
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
    // Force the Secure cookie flag + `__Secure-` prefix. Access is HTTPS-only via
    // the Cloudflare Tunnel, so cookies must never be sent over plain HTTP.
    useSecureCookies: true,
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
      // sign-up payload; they are assigned by the seed/admin via Prisma.
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
  // nextCookies() must be last — it bridges Better Auth cookie writes into
  // Next.js server actions.
  plugins: [username(), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
