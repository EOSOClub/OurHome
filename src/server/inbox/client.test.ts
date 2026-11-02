import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxClient, InboxError } from '@/server/inbox/client';

afterEach(() => vi.restoreAllMocks());

const TOKEN = `ohi_${'a'.repeat(43)}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('InboxClient', () => {
  it('refuses private addresses for a public-only household, without sending anything', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const url of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://10.0.0.5', 'http://169.254.169.254']) {
      const client = new InboxClient({ url, token: TOKEN, publicUrl: null, publicOnly: true });
      await expect(client.hello()).rejects.toBeInstanceOf(InboxError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the token as a Bearer token, never follows a redirect, and asks with after and limit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ documents: [], next: 5, more: false }));
    const client = new InboxClient({ url: 'http://ourhome_inbox:8080', token: TOKEN, publicUrl: null });
    await client.documents(5, 100);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://ourhome_inbox:8080/api/handoff/documents?after=5&limit=100');
    expect((init as RequestInit).redirect).toBe('error');
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reports changes with a POST of { changes } as JSON, with the token and no redirects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ accepted: 1, unknown: 0 }));
    const client = new InboxClient({ url: 'http://ourhome_inbox:8080', token: TOKEN, publicUrl: null });
    const change = { messageId: '<abc@x>', change: 'paid' as const, at: '2026-11-03T15:20:00.000Z' };
    await expect(client.changes([change])).resolves.toEqual({ accepted: 1, unknown: 0 });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ourhome_inbox:8080/api/handoff/changes');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ changes: [change] });
  });

  it('counts a change report as accepted only on a 200', async () => {
    const client = new InboxClient({ url: 'http://ourhome_inbox:8080', token: TOKEN, publicUrl: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ accepted: 1, unknown: 0 }, 202));
    await expect(client.changes([])).rejects.toThrow('OurHomeInbox answered 202 for /api/handoff/changes.');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: 'changes: 1 to 100 changes per request.' }, 400));
    await expect(client.changes([])).rejects.toThrow('changes: 1 to 100 changes per request.');
  });

  it('refuses to report to a private address for a public-only household', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new InboxClient({ url: 'http://127.0.0.1:8080', token: TOKEN, publicUrl: null, publicOnly: true });
    await expect(client.changes([])).rejects.toBeInstanceOf(InboxError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows OurHomeInbox’s own words for a failed request, as the contract says', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'This token was revoked.' }, 401));
    const client = new InboxClient({ url: 'http://ourhome_inbox:8080', token: TOKEN, publicUrl: null });
    await expect(client.hello()).rejects.toThrow('This token was revoked.');
  });

  it('says plainly when the token is refused without a reason, or the reply is not JSON', async () => {
    const client = new InboxClient({ url: 'http://ourhome_inbox:8080', token: TOKEN, publicUrl: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(client.hello()).rejects.toThrow(/rejected the token/);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    await expect(client.hello()).rejects.toThrow(/isn't JSON/);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('oops', { status: 500 }));
    await expect(client.hello()).rejects.toThrow('OurHomeInbox answered 500 for /api/handoff/hello.');
  });
});
