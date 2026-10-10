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
