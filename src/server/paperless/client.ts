// Read-only Paperless-ngx REST client for the bill import. Token auth, API
// version pinned to 9 (`created` is a plain date there; current Paperless
// serves 9 and 10), and list endpoints followed page by page.

const API_VERSION = 9;
const TIMEOUT_MS = 20_000;

export interface PaperlessConfig {
  /** How this server reaches Paperless, e.g. http://paperless:8000 on the Docker network. */
  url: string;
  token: string;
  /** How people open Paperless in a browser; used only for links. */
  publicUrl: string | null;
}

/** From `paperless.url` (settings.yml) and PAPERLESS_TOKEN (.env). Unset → import off. */
export function paperlessConfig(): PaperlessConfig | null {
  const url = process.env.PAPERLESS_URL?.trim().replace(/\/+$/, '');
  const token = process.env.PAPERLESS_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token, publicUrl: process.env.PAPERLESS_PUBLIC_URL?.trim() || null };
}

interface Page<T> {
  count: number;
  next: string | null;
  results: T[];
}

export class PaperlessError extends Error {}

export class PaperlessClient {
  constructor(private readonly cfg: PaperlessConfig) {}

  async get<T>(pathAndQuery: string): Promise<T> {
    const url = `${this.cfg.url}${pathAndQuery}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Token ${this.cfg.token}`,
          Accept: `application/json; version=${API_VERSION}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PaperlessError(`Can't reach Paperless at ${this.cfg.url} (${(err as Error).message}).`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new PaperlessError('Paperless rejected the API token (check PAPERLESS_TOKEN and that user’s permissions).');
    }
    if (res.status === 406) {
      throw new PaperlessError(`This Paperless doesn't support API version ${API_VERSION}; update Paperless.`);
    }
    if (!res.ok) {
      throw new PaperlessError(`Paperless answered ${res.status} for ${pathAndQuery.split('?')[0]}.`);
    }
    return (await res.json()) as T;
  }

  /** Every result of a list endpoint, following `next` links. */
  async listAll<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const query = new URLSearchParams({ page_size: '100', ...params });
    let next: string | null = `${path}?${query}`;
    const out: T[] = [];
    while (next) {
      const page: Page<T> = await this.get<Page<T>>(next);
      out.push(...page.results);
      // `next` is an absolute URL built from whatever host Paperless thinks it
      // is; keep only the path + query and stay on our configured address.
      next = page.next ? new URL(page.next).pathname + new URL(page.next).search : null;
    }
    return out;
  }
}
