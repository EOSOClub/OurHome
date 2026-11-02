// Client for OurHomeInbox's hand-off API, the email bill reader that replaces
// the Paperless email import. Three routes, with the household's `ohi_` token
// as a Bearer token: two reads (hello, documents) and, since contract v2, the
// change reports (POST /api/handoff/changes), the only thing OurHome sends
// it. The contract is in docs/ourhomeinbox-import.md.

import { isPublicFetchTarget } from '@/server/services/linkPreview';

const TIMEOUT_MS = 20_000;

export interface InboxConfig {
  /** How this server reaches OurHomeInbox, e.g., http://ourhome_inbox:8080 on the Docker network. */
  url: string;
  token: string;
  /** How people open OurHomeInbox in a browser; used only for links. */
  publicUrl: string | null;
  /**
   * Only public internet addresses may be reached (a household not allowed
   * on the server's private network): checked, DNS included, before every call.
   */
  publicOnly?: boolean;
}

export class InboxError extends Error {
  /** The HTTP status OurHomeInbox answered with, when it answered at all. */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The plain-language `error` OurHomeInbox sends with a failed request, if any. */
async function errorText(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error.trim() ? body.error.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

export class InboxClient {
  constructor(private readonly cfg: InboxConfig) {}

  get(pathAndQuery: string): Promise<unknown> {
    return this.send(pathAndQuery);
  }

  /** A JSON body to OurHomeInbox; the same checks and errors as `get`. */
  post(path: string, body: unknown): Promise<unknown> {
    return this.send(path, { method: 'POST', body: JSON.stringify(body) });
  }

  private async send(pathAndQuery: string, init?: { method: 'POST'; body: string }): Promise<unknown> {
    const url = `${this.cfg.url}${pathAndQuery}`;
    if (this.cfg.publicOnly && !(await isPublicFetchTarget(new URL(url)))) {
      throw new InboxError(
        `${this.cfg.url} isn't a public internet address. Ask the server admin to allow this household's bill imports on the server's network.`,
      );
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method: init?.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: 'application/json',
          ...(init ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init?.body,
        // Never follow a redirect: it could lead somewhere the check above
        // didn't allow (and OurHomeInbox's hand-off API doesn't redirect).
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new InboxError(`Can't reach OurHomeInbox at ${this.cfg.url} (${(err as Error).message}).`);
    }
    if (res.status === 401) {
      throw new InboxError(
        (await errorText(res)) ??
          'OurHomeInbox rejected the token. Make a new one in OurHomeInbox (Settings, OurHome connection) and enter it here.',
        401,
      );
    }
    if (!res.ok) {
      // The contract: OurHomeInbox's own words are shown to the household as they are.
      throw new InboxError(
        (await errorText(res)) ?? `OurHomeInbox answered ${res.status} for ${pathAndQuery.split('?')[0]}.`,
        res.status,
      );
    }
    if (init && res.status !== 200) {
      // The contract: a report is accepted only with a 200.
      throw new InboxError(`OurHomeInbox answered ${res.status} for ${pathAndQuery.split('?')[0]}.`, res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new InboxError(`OurHomeInbox sent something that isn't JSON for ${pathAndQuery.split('?')[0]}.`);
    }
  }

  /** `GET /api/handoff/hello`: used to test the connection when it's saved. */
  hello(): Promise<unknown> {
    return this.get('/api/handoff/hello');
  }

  /**
   * `GET /api/handoff/documents`: what is new or changed since document
   * number `after`. Careful: asking with `after=n` also tells OurHomeInbox
   * that OurHome has handled everything up to n.
   */
  documents(after: number, limit = 100): Promise<unknown> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return this.get(`/api/handoff/documents?${query}`);
  }

  /**
   * `POST /api/handoff/changes` (contract v2): what people did here to bills
   * from OurHomeInbox, 1 to 100 at a time. Resolves only on a success reply;
   * anything else throws, so the caller keeps the changes queued.
   */
  changes(changes: InboxChangeReport[]): Promise<unknown> {
    return this.post('/api/handoff/changes', { changes });
  }
}

/** One change as the contract sends it. */
export interface InboxChangeReport {
  /** The bill's sourceMessageId. */
  messageId: string;
  change: 'paid' | 'removed';
  /** A full ISO time. */
  at: string;
}
