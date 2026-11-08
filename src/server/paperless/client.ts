// Read-only Paperless-ngx REST client for the bill import. Token auth, API
// version pinned to 9 (`created` is a plain date there; current Paperless
// serves 9 and 10), and list endpoints followed page by page.

import { isPublicFetchTarget } from '@/server/services/linkPreview';

const API_VERSION = 9;
const TIMEOUT_MS = 20_000;
/** How many times a list that changed while it was read is read again (listAll). */
const LIST_ATTEMPTS = 3;

export interface PaperlessConfig {
  /** How this server reaches Paperless, e.g., http://paperless:8000 on the Docker network. */
  url: string;
  token: string;
  /** How people open Paperless in a browser; used only for links. */
  publicUrl: string | null;
  /**
   * Only public internet addresses may be reached (a household not allowed
   * on the server's private network): checked, DNS included, before every call.
   */
  publicOnly?: boolean;
}

/**
 * The server-wide connection from `paperless.url` (settings.yml) and
 * PAPERLESS_TOKEN (.env), for the household it's assigned to (paperlessSync).
 * Households can save their own instead. Unset → none.
 */
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
    if (this.cfg.publicOnly && !(await isPublicFetchTarget(new URL(url)))) {
      throw new PaperlessError(
        `${this.cfg.url} isn't a public internet address. Ask the server admin to allow this household's Paperless on the server's network.`,
      );
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Token ${this.cfg.token}`,
          Accept: `application/json; version=${API_VERSION}`,
        },
        // Never follow a redirect: it could lead somewhere the check above
        // didn't allow (and Paperless's API doesn't redirect).
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PaperlessError(`Can't reach Paperless at ${this.cfg.url} (${(err as Error).message}).`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new PaperlessError('Paperless rejected the API token (check the token and that user’s permissions).');
    }
    if (res.status === 406) {
      throw new PaperlessError(`This Paperless doesn't support API version ${API_VERSION}; update Paperless.`);
    }
    if (!res.ok) {
      throw new PaperlessError(`Paperless answered ${res.status} for ${pathAndQuery.split('?')[0]}.`);
    }
    return (await res.json()) as T;
  }

  /**
   * Every result of a list endpoint, following `next` links. Pages are by
   * number, so a list that changes while it's read (a document edited in
   * Paperless drops out of the import's window) moves the rest up a place and
   * one would be missed between two pages. Its total then differs from one
   * page to the next, and the list is read again from the start.
   */
  async listAll<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const query = new URLSearchParams({ page_size: '100', ...params });
    for (let attempt = 0; attempt < LIST_ATTEMPTS; attempt++) {
      let next: string | null = `${path}?${query}`;
      let total: number | null = null;
      let changed = false;
      const out: T[] = [];
      while (next) {
        const page: Page<T> = await this.get<Page<T>>(next);
        if (total !== null && page.count !== total) {
          changed = true;
          break;
        }
        total = page.count;
        out.push(...page.results);
        next = page.next ? this.pathOf(page.next) : null;
      }
      if (!changed) return out;
    }
    throw new PaperlessError('The list from Paperless kept changing while it was read. The import tries again next time.');
  }

  /**
   * `next` is an absolute URL built from whatever host Paperless thinks it
   * is; keep only the path + query and stay on our configured address. A
   * Paperless served under a path (PAPERLESS_FORCE_SCRIPT_NAME) puts that path
   * in its links too, and our address already ends in it.
   */
  private pathOf(link: string): string {
    const u = new URL(link);
    const base = new URL(this.cfg.url).pathname.replace(/\/+$/, '');
    const path = base && u.pathname.startsWith(`${base}/`) ? u.pathname.slice(base.length) : u.pathname;
    return path + u.search;
  }
}
