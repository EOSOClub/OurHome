// One-time Paperless-ngx setup for the bill import (`npm run paperless:setup`):
// the tags, custom fields, a read-only user + group and its API token, plus
// starter workflows, saved views and optional content matching. Everything is
// found by name first and only created when missing, so it is safe to run again.
//
// This is the only code that writes to Paperless, and only when a person runs
// it with an admin login. The import itself stays read-only (client.ts).
//
// Pure helpers here are unit-tested; the HTTP calls are in PaperlessAdmin.

const API_VERSION = 9; // same as the import's client
const TIMEOUT_MS = 20_000;

// Paperless enums (documents/models.py, paperless_mail/models.py and the web
// UI's filter rules).
export const MATCH_NONE = 0;
export const MATCH_LITERAL = 3;
export const MATCH_REGEX = 4;
export const IMAP_SECURITY = { none: 1, ssl: 2, starttls: 3 } as const;
export const MAIL_SCOPE_ATTACHMENTS = 1;
export const MAIL_SCOPE_EML = 2;
export const MAIL_ATTACHMENTS_ONLY = 1;
export const MAIL_ACTION_MARK_READ = 3;
export const MAIL_TITLE_FROM_SUBJECT = 1;
export const MAIL_CORRESPONDENT_NONE = 1;
export const TRIGGER_ADDED = 2;
export const TRIGGER_UPDATED = 3;
export const ACTION_ASSIGNMENT = 1;
export const ACTION_REMOVAL = 2;
export const FILTER_HAS_TAGS_ANY = 22;
export const FILTER_CUSTOM_FIELD_QUERY = 42;

/** Paperless rejects longer match patterns. */
export const PATTERN_LIMIT = 256;

/** What the read-only import user may see: nothing else, and no changes. */
export const READ_ONLY_PERMISSIONS = ['view_document', 'view_tag', 'view_correspondent', 'view_customfield'];

/** Names of what setup creates, so a re-run finds them again. */
export const SETUP_NAMES = {
  group: 'Our Home (read-only)',
  user: 'ourhome',
  viewWorkflow: 'Our Home: share new documents',
  billFieldsWorkflow: 'Our Home: bill fields',
  paymentFieldsWorkflow: 'Our Home: payment fields',
  paymentNotBillWorkflow: 'Our Home: payments are not bills',
  allView: 'Our Home: bills & payments',
  waitingView: 'Our Home: waiting for an Amount',
  mailAccount: 'Our Home: bills',
  attachmentsRule: 'Our Home: bill attachments',
  emailRule: 'Our Home: bill emails',
};

// ---------------------------------------------------------------------------
// Content matching (docs/paperless-import.md, "tag bills automatically")
// ---------------------------------------------------------------------------

// "Payment was processed" etc. Bills often say a payment is "to be processed",
// so only "was" / "has been" may come before the verb.
const PAYMENT_WORDING =
  String.raw`payment (was |has been )?(\w+ )?(processed|posted|confirm|received)|thank you for your payment`;

/** Biller names from "City Water, Electric Co" — trimmed, de-duplicated. */
export function parseBillers(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The two tag patterns: a payment names a biller and payment wording; a bill
 * names a biller, has no payment wording, and reads like a bill. They exclude
 * each other, since a document tagged both is skipped by the import. Matching
 * is case-insensitive (set on the tag), so no (?i).
 */
export function billerPatterns(billers: string[]): { bill: string; payment: string } {
  // \b only works next to a letter or digit ("AT&T (Mobile)" ends in ")"), so
  // names that start or end otherwise get their boundaries one by one. The
  // shared form is shorter, which matters under the 256-character limit.
  const plain = billers.every((b) => /^\w/.test(b) && /\w$/.test(b));
  const who = plain
    ? String.raw`\b(${billers.map(escapeRegex).join('|')})\b`
    : `(${billers.map((b) => `${/^\w/.test(b) ? String.raw`\b` : ''}${escapeRegex(b)}${/\w$/.test(b) ? String.raw`\b` : ''}`).join('|')})`;
  const named = String.raw`(?s)\A(?=.*${who})`;
  return {
    payment: `${named}.*(${PAYMENT_WORDING})`,
    bill: `${named}(?!.*(${PAYMENT_WORDING})).*(due|statement|invoice|bill)`,
  };
}

/** How many characters of biller names fit, given the longer pattern's overhead. */
export function billerRoom(): number {
  const { bill } = billerPatterns([]);
  return PATTERN_LIMIT - bill.length;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export interface WorkflowBody {
  name: string;
  order: number;
  enabled: boolean;
  triggers: Record<string, unknown>[];
  actions: Record<string, unknown>[];
}

/**
 * New documents become visible to the import group. Only matters when
 * documents have owners (then a token user sees nothing it isn't given).
 */
export function shareWorkflow(groupId: number, sources?: number[]): WorkflowBody {
  return {
    name: SETUP_NAMES.viewWorkflow,
    order: 90,
    enabled: true,
    triggers: [{ type: TRIGGER_ADDED, matching_algorithm: MATCH_NONE, ...(sources ? { sources } : {}) }],
    actions: [{ type: ACTION_ASSIGNMENT, assign_view_groups: [groupId] }],
  };
}

/**
 * When a document gets the tag (on arrival or later), add the empty custom
 * fields the import reads, so they're ready to fill in. Existing values are
 * kept: Paperless only adds fields a document doesn't have.
 */
export function fieldsWorkflow(
  name: string,
  tagId: number,
  fieldIds: number[],
  withUpdated: boolean,
  sources?: number[],
): WorkflowBody {
  const base = { matching_algorithm: MATCH_NONE, filter_has_tags: [tagId], ...(sources ? { sources } : {}) };
  const triggers: Record<string, unknown>[] = [{ type: TRIGGER_ADDED, ...base }];
  if (withUpdated) triggers.push({ type: TRIGGER_UPDATED, ...base });
  return {
    name,
    order: 91,
    enabled: true,
    triggers,
    actions: [{ type: ACTION_ASSIGNMENT, assign_custom_fields: fieldIds }],
  };
}

/**
 * A document tagged bill-payment loses the bill tag. The mail rules tag
 * everything in the bill folder `bill`, and content matching then adds
 * `bill-payment` to payment confirmations; the import skips a document that
 * has both, so the payment would never be recorded.
 */
export function paymentNotBillWorkflow(billTagId: number, paymentTagId: number, withUpdated: boolean, sources?: number[]): WorkflowBody {
  const base = { matching_algorithm: MATCH_NONE, filter_has_tags: [paymentTagId], ...(sources ? { sources } : {}) };
  const triggers: Record<string, unknown>[] = [{ type: TRIGGER_ADDED, ...base }];
  if (withUpdated) triggers.push({ type: TRIGGER_UPDATED, ...base });
  return {
    name: SETUP_NAMES.paymentNotBillWorkflow,
    order: 95,
    enabled: true,
    triggers,
    actions: [{ type: ACTION_REMOVAL, remove_tags: [billTagId] }],
  };
}

export interface SavedViewBody {
  name: string;
  show_on_dashboard: boolean;
  show_in_sidebar: boolean;
  sort_field: string;
  sort_reverse: boolean;
  filter_rules: { rule_type: number; value: string }[];
}

function savedView(name: string, rules: { rule_type: number; value: string }[]): SavedViewBody {
  return { name, show_on_dashboard: true, show_in_sidebar: true, sort_field: 'modified', sort_reverse: true, filter_rules: rules };
}

/** Everything tagged bill or bill-payment, newest change first. */
export function allBillsView(tagIds: number[]): SavedViewBody {
  return savedView(
    SETUP_NAMES.allView,
    tagIds.map((id) => ({ rule_type: FILTER_HAS_TAGS_ANY, value: String(id) })),
  );
}

/** Tagged documents the import is waiting on: Amount missing or empty. */
export function waitingView(tagIds: number[], amountFieldId: number): SavedViewBody {
  const query = ['OR', [[amountFieldId, 'exists', false], [amountFieldId, 'isnull', true]]];
  return savedView(SETUP_NAMES.waitingView, [
    ...tagIds.map((id) => ({ rule_type: FILTER_HAS_TAGS_ANY, value: String(id) })),
    { rule_type: FILTER_CUSTOM_FIELD_QUERY, value: JSON.stringify(query) },
  ]);
}

/**
 * A correspondent per biller, matched by its exact name anywhere in a
 * document (case-insensitive). Our Home matches a payment to its bill by
 * correspondent, so this also helps payments find their bills.
 */
export function correspondentBody(name: string) {
  return { name, matching_algorithm: MATCH_LITERAL, match: name, is_insensitive: true, owner: null };
}

export interface ImapSettings {
  host: string;
  port: number;
  security: keyof typeof IMAP_SECURITY;
  user: string;
  /** Empty when not given this run: an existing account is then kept as it is. */
  password: string;
  folder: string;
}

/** The bill mailbox from PAPERLESS_SETUP_IMAP_* / _MAIL_FOLDER, or null when not set. */
export function imapFromEnv(env: Record<string, string | undefined>): ImapSettings | null {
  const host = env.PAPERLESS_SETUP_IMAP_HOST?.trim();
  const folder = env.PAPERLESS_SETUP_MAIL_FOLDER?.trim();
  if (!host || !folder) return null;
  const security = (env.PAPERLESS_SETUP_IMAP_SECURITY?.trim().toLowerCase() || 'ssl') as ImapSettings['security'];
  if (!(security in IMAP_SECURITY)) throw new Error(`PAPERLESS_SETUP_IMAP_SECURITY must be none, ssl or starttls (got "${security}").`);
  const port = Number(env.PAPERLESS_SETUP_IMAP_PORT?.trim() || (security === 'ssl' ? 993 : 143));
  if (!Number.isInteger(port) || port <= 0) throw new Error('PAPERLESS_SETUP_IMAP_PORT must be a port number.');
  return { host, port, security, user: env.PAPERLESS_SETUP_IMAP_USER?.trim() ?? '', password: env.PAPERLESS_SETUP_IMAP_PASSWORD ?? '', folder };
}

/** The mail account's connection fields (also what Paperless's "test" takes). */
export function mailAccountBody(imap: ImapSettings) {
  return {
    name: SETUP_NAMES.mailAccount,
    imap_server: imap.host,
    imap_port: imap.port,
    imap_security: IMAP_SECURITY[imap.security],
    username: imap.user,
    password: imap.password,
    character_set: 'UTF-8',
  };
}

/**
 * The two rules on the bill folder, as in OurHomeServices' Paperless guide:
 * PDF attachments, and HTML-only emails saved as PDF. Both tag `bill`, title
 * from the subject, and mark the mail read. No correspondent from the sender,
 * so the biller correspondents' matching decides.
 */
export function mailRuleBodies(accountId: number, folder: string, billTagId: number) {
  const common = {
    account: accountId,
    enabled: true,
    folder,
    maximum_age: 30,
    action: MAIL_ACTION_MARK_READ,
    assign_title_from: MAIL_TITLE_FROM_SUBJECT,
    assign_correspondent_from: MAIL_CORRESPONDENT_NONE,
    assign_tags: [billTagId],
  };
  return [
    { ...common, name: SETUP_NAMES.attachmentsRule, order: 1, consumption_scope: MAIL_SCOPE_ATTACHMENTS, attachment_type: MAIL_ATTACHMENTS_ONLY },
    { ...common, name: SETUP_NAMES.emailRule, order: 2, consumption_scope: MAIL_SCOPE_EML, attachment_type: MAIL_ATTACHMENTS_ONLY },
  ];
}

/** A random password for the import user; it only ever signs in with its token. */
export function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

// ---------------------------------------------------------------------------
// Admin client
// ---------------------------------------------------------------------------

export class PaperlessSetupError extends Error {}

interface Page<T> {
  next: string | null;
  results: T[];
}

/** Paperless REST calls as an admin (HTTP Basic), for setup only. */
export class PaperlessAdmin {
  /** Paperless's own version, from the X-Version header (e.g. "2.18.4"). */
  version = '';

  constructor(
    private readonly url: string,
    private readonly user: string,
    private readonly password: string,
  ) {}

  async request<T>(method: string, pathAndQuery: string, body?: unknown, auth = true): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${pathAndQuery}`, {
        method,
        headers: {
          ...(auth ? { Authorization: `Basic ${Buffer.from(`${this.user}:${this.password}`).toString('base64')}` } : {}),
          Accept: `application/json; version=${API_VERSION}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PaperlessSetupError(`Can't reach Paperless at ${this.url} (${(err as Error).message}).`);
    }
    this.version = res.headers.get('x-version') ?? this.version;
    const text = await res.text();
    if (res.status === 401) throw new PaperlessSetupError('Paperless rejected the admin username or password.');
    if (res.status === 403) {
      throw new PaperlessSetupError(`Not allowed: ${method} ${pathAndQuery.split('?')[0]} needs a Paperless superuser.`);
    }
    if (!res.ok) {
      throw new PaperlessSetupError(`Paperless answered ${res.status} for ${method} ${pathAndQuery.split('?')[0]}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  get<T>(path: string) { return this.request<T>('GET', path); }
  post<T>(path: string, body: unknown) { return this.request<T>('POST', path, body); }
  patch<T>(path: string, body: unknown) { return this.request<T>('PATCH', path, body); }

  /** Every result of a list endpoint, following `next` links on our address. */
  async listAll<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    let next: string | null = `${path}?${new URLSearchParams({ page_size: '100', ...params })}`;
    const out: T[] = [];
    while (next) {
      const page: Page<T> = await this.get<Page<T>>(next);
      out.push(...page.results);
      next = page.next ? new URL(page.next).pathname + new URL(page.next).search : null;
    }
    return out;
  }

  /** The first object of a list endpoint with this name (case-insensitive). */
  async findByName<T extends { name?: string; username?: string }>(path: string, name: string): Promise<T | null> {
    const key = path.includes('/users/') ? 'username' : 'name';
    const hits = await this.listAll<T>(path, { [`${key}__iexact`]: name });
    return hits.find((h) => (h[key] ?? '').toLowerCase() === name.toLowerCase()) ?? null;
  }

  /**
   * Every document source a workflow trigger accepts (consume folder, API,
   * mail, web UI…). Paperless's default leaves newer ones out, e.g. browser
   * uploads, so triggers list them all. Undefined = use Paperless's default.
   */
  async triggerSources(): Promise<number[] | undefined> {
    try {
      const meta = await this.request<{ actions?: { POST?: { sources?: { choices?: { value: number }[] } } } }>(
        'OPTIONS',
        '/api/workflow_triggers/',
      );
      const values = meta.actions?.POST?.sources?.choices?.map((c) => c.value);
      return values?.length ? values : undefined;
    } catch {
      return undefined;
    }
  }

  /** A user's API token, via its username and password (DRF obtain_auth_token). */
  async tokenFor(username: string, password: string): Promise<string> {
    const { token } = await this.request<{ token?: string }>('POST', '/api/token/', { username, password }, false);
    if (!token) throw new PaperlessSetupError('Paperless gave no token for the import user.');
    return token;
  }
}
