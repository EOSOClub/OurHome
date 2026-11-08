import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaperlessClient, PaperlessError } from '@/server/paperless/client';

afterEach(() => vi.restoreAllMocks());

describe('PaperlessClient address guard', () => {
  it('refuses private addresses for a public-only household, without sending anything', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const url of ['http://127.0.0.1:8000', 'http://localhost:8000', 'http://10.0.0.5', 'http://169.254.169.254']) {
      const client = new PaperlessClient({ url, token: 'secret-token', publicUrl: null, publicOnly: true });
      await expect(client.get('/api/tags/')).rejects.toBeInstanceOf(PaperlessError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets a trusted household reach its local Paperless', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ count: 0, next: null, results: [] }), { status: 200 }));
    const client = new PaperlessClient({ url: 'http://paperless:8000', token: 't', publicUrl: null });
    await expect(client.listAll('/api/tags/')).resolves.toEqual([]);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).redirect).toBe('error');
  });
});

describe('PaperlessClient paging', () => {
  const page = (count: number, results: number[], next: string | null) =>
    new Response(JSON.stringify({ count, next, results }), { status: 200 });
  const urls = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([u]) => String(u));

  it('follows next links on a Paperless served under a path', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // Under PAPERLESS_FORCE_SCRIPT_NAME its links carry the path...
      .mockResolvedValueOnce(page(3, [1], 'https://host.example/paperless/api/tags/?page=2&page_size=100'))
      // ...behind a proxy that strips it, they don't.
      .mockResolvedValueOnce(page(3, [2], 'http://paperless:8000/api/tags/?page=3&page_size=100'))
      .mockResolvedValueOnce(page(3, [3], null));
    const client = new PaperlessClient({ url: 'https://host.example/paperless', token: 't', publicUrl: null });
    await expect(client.listAll<number>('/api/tags/')).resolves.toEqual([1, 2, 3]);
    expect(urls(fetchSpy).slice(1)).toEqual([
      'https://host.example/paperless/api/tags/?page=2&page_size=100',
      'https://host.example/paperless/api/tags/?page=3&page_size=100',
    ]);
  });

  it('reads the list again when it changed while being read, so nothing is skipped', async () => {
    const next = 'http://paperless:8000/api/documents/?page=2&page_size=100';
    vi.spyOn(globalThis, 'fetch')
      // A document on page 1 is edited (leaves the list) before page 2 is read:
      // what was the first of page 2 moved onto page 1.
      .mockResolvedValueOnce(page(4, [1, 2], next))
      .mockResolvedValueOnce(page(3, [4], null))
      .mockResolvedValueOnce(page(3, [1, 3], next))
      .mockResolvedValueOnce(page(3, [4], null));
    const client = new PaperlessClient({ url: 'http://paperless:8000', token: 't', publicUrl: null });
    await expect(client.listAll<number>('/api/documents/')).resolves.toEqual([1, 3, 4]);
  });

  it('gives up for this run when the list keeps changing', async () => {
    // Two pages, one fewer document on every read.
    let count = 100;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      page(count, [count], count-- % 2 === 0 ? 'http://paperless:8000/api/documents/?page=2&page_size=100' : null),
    );
    const client = new PaperlessClient({ url: 'http://paperless:8000', token: 't', publicUrl: null });
    await expect(client.listAll('/api/documents/')).rejects.toBeInstanceOf(PaperlessError);
  });
});
