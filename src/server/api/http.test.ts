import { describe, expect, it, vi } from 'vitest';

const session = { getServerSession: vi.fn() };
vi.mock('@/server/auth/session', () => session);
vi.mock('@/server/services/permissionService', () => ({ getUserAccess: vi.fn() }));
vi.mock('@/server/services/serverAdminService', () => ({
  HOUSEHOLD_DISABLED_MESSAGE: 'off',
  isFeatureEnabled: vi.fn(async () => true),
  isHouseholdDisabled: vi.fn(async () => false),
  isServerAdmin: vi.fn(async () => false),
}));

const { readJsonCapped, withAuth } = await import('./http');
const { PayloadTooLargeError } = await import('@/server/services/errors');

const CAP = 1000;

/** A body streamed in [chunks] chunks of [size] bytes; counts how many were pulled. */
function streamed(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === chunks) return controller.close();
      state.pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

/** A request as the route sees it; [length] is the Content-Length header, if any. */
function request(body: ReadableStream<Uint8Array> | string | null, length?: number): Request {
  const headers = new Headers(length === undefined ? {} : { 'content-length': String(length) });
  const stream = typeof body === 'string' ? new Response(body).body : body;
  return { headers, body: stream, url: 'http://home.test/api/tasks/complete' } as unknown as Request;
}

describe('readJsonCapped', () => {
  it('reads a body under the cap as JSON', async () => {
    const json = JSON.stringify({ taskId: 'abc', note: 'Done', photo: 'x'.repeat(500) });
    expect(await readJsonCapped(request(json, json.length), CAP)).toEqual(JSON.parse(json));
    // No Content-Length (chunked): read all the same.
    expect(await readJsonCapped(request(json), CAP)).toEqual(JSON.parse(json));
  });

  it('refuses from Content-Length before reading anything', async () => {
    const { body } = streamed(5, 10);
    await expect(readJsonCapped(request(body, CAP + 1), CAP)).rejects.toBeInstanceOf(PayloadTooLargeError);
    // Nobody ever took a reader on it.
    expect(body.locked).toBe(false);
  });

  it('refuses while reading once the body passes the cap, without reading the rest', async () => {
    const { body, state } = streamed(50, 300);
    await expect(readJsonCapped(request(body), CAP)).rejects.toBeInstanceOf(PayloadTooLargeError);
    // 4 chunks of 300 bytes pass 1000; the other 46 are never pulled.
    expect(state.pulled).toBeLessThanOrEqual(5);
    expect(state.cancelled).toBe(true);
  });

  it('refuses a body bigger than its Content-Length says', async () => {
    const { body } = streamed(50, 300);
    await expect(readJsonCapped(request(body, 10), CAP)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('reads a body that is exactly the cap', async () => {
    const json = JSON.stringify({ a: 'x'.repeat(CAP - 8) });
    expect(json.length).toBe(CAP);
    expect(await readJsonCapped(request(json, CAP), CAP)).toEqual({ a: 'x'.repeat(CAP - 8) });
  });

  it('reads what is not JSON, or no body, as {} for the schema to refuse', async () => {
    expect(await readJsonCapped(request('not json'), CAP)).toEqual({});
    expect(await readJsonCapped(request(null), CAP)).toEqual({});
  });

  it('is answered 413 by the API layer', async () => {
    session.getServerSession.mockResolvedValueOnce({ user: { id: 'u1', role: 'child', householdId: 'hh' } });
    const { body } = streamed(50, 300);
    const route = withAuth(async ({ req }) => {
      await readJsonCapped(req, CAP);
      return new Response('read');
    });
    const res = await route(request(body) as never);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: { message: 'That’s too big to send.' } });
  });
});
