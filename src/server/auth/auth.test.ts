import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real Better Auth config (auth.ts) over a stand-in database: nobody is
// found, so a username that passes Better Auth's own check gets "wrong
// username or password", and one it refuses gets INVALID_USERNAME.

const update = vi.fn(async () => ({}));
const model = () => ({
  findFirst: vi.fn(async () => null),
  findUnique: vi.fn(async () => null),
  findMany: vi.fn(async () => []),
  count: vi.fn(async () => 0),
  update,
});
const prisma = new Proxy({} as Record<string, unknown>, {
  get: (target, key: string) => (target[key] ??= model()),
});
vi.mock('@/server/db/prisma', () => ({ prisma, activeProvider: () => 'mongodb' }));
vi.mock('@/server/email/mailer', () => ({ sendEmail: vi.fn() }));

const { auth } = await import('@/server/auth/auth');
const { usernameSchema } = await import('@/lib/validation/user');

/** The error code Better Auth answers a sign-in with. */
async function signInCode(username: string): Promise<string | undefined> {
  try {
    await auth.api.signInUsername({ body: { username, password: 'password1' } });
    return 'signed in';
  } catch (err) {
    return (err as { body?: { code?: string } }).body?.code;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('signing in by username', () => {
  it('takes every username the app lets you create, hyphens included', async () => {
    for (const name of ['mary-jo', 'the-smiths', 'jane.d', 'sam_1', 'Alex-B']) {
      expect(usernameSchema.safeParse(name).success).toBe(true);
      expect(await signInCode(name)).toBe('INVALID_USERNAME_OR_PASSWORD');
    }
  });

  it('refuses what the app refuses', async () => {
    for (const name of ['mary jo', 'mary+jo', 'jo!', 'ab']) {
      expect(usernameSchema.safeParse(name).success).toBe(false);
      expect(await signInCode(name)).not.toBe('INVALID_USERNAME_OR_PASSWORD');
    }
  });
});

/** What Better Auth answers a call with: the error's status and message, or 'ok'. */
async function answer(call: () => Promise<unknown>): Promise<{ status?: string; message?: string; code?: string } | 'ok'> {
  try {
    await call();
    return 'ok';
  } catch (err) {
    const e = err as { status?: string; body?: { message?: string; code?: string } };
    return { status: e.status, message: e.body?.message, code: e.body?.code };
  }
}

// Nobody is signed in here, so a body the app's own check lets through is
// answered UNAUTHORIZED by the route; one it refuses never gets that far.
describe('Better Auth’s update-user route', () => {
  const updateUser = (body: Record<string, unknown>) =>
    answer(() => auth.api.updateUser({ body: body as never, headers: new Headers() }));

  it('lets a name through to the route', async () => {
    expect(await updateUser({ name: 'Sam' })).toMatchObject({ status: 'UNAUTHORIZED' });
  });

  it('refuses a username or display username (they go through the profile)', async () => {
    for (const body of [{ username: 'dad' }, { displayUsername: 'dad' }, { name: 'Sam', displayUsername: 'dad' }]) {
      expect(await updateUser(body)).toMatchObject({
        status: 'BAD_REQUEST',
        message: 'Change your username in your profile.',
      });
    }
  });

  it('refuses a blank or overlong name', async () => {
    expect(await updateUser({ name: '   ' })).toMatchObject({ status: 'BAD_REQUEST', message: 'Enter a name.' });
    expect(await updateUser({ name: 'x'.repeat(81) })).toMatchObject({ status: 'BAD_REQUEST' });
  });
});

describe('changing a password', () => {
  const change = (newPassword: string, currentPassword: string) =>
    answer(() => auth.api.changePassword({ body: { newPassword, currentPassword }, headers: new Headers() }));

  it('refuses the same password again, so a temporary one cannot be kept', async () => {
    expect(await change('temp-pass-1', 'temp-pass-1')).toMatchObject({
      status: 'BAD_REQUEST',
      code: 'PASSWORD_UNCHANGED',
    });
    // The forced change is not lifted.
    expect(update).not.toHaveBeenCalled();
  });

  it('lets a different one through to the route', async () => {
    expect(await change('new-pass-22', 'temp-pass-1')).toMatchObject({ status: 'UNAUTHORIZED' });
  });
});

describe('a password chosen through Forgot password', () => {
  it('lifts the forced change and ends the phone setup link, as a password change does', async () => {
    const onPasswordReset = auth.options.emailAndPassword?.onPasswordReset;
    expect(onPasswordReset).toBeTypeOf('function');
    await onPasswordReset!({ user: { id: 'cmkid000000000000000000001' } as never });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'cmkid000000000000000000001' },
      data: { mustChangePassword: false, setupLinkHash: null, setupLinkExpiresAt: null },
    });
  });
});
