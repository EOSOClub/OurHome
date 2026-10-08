import { describe, expect, it } from 'vitest';
import {
  ACTION_REMOVAL,
  FILTER_CUSTOM_FIELD_QUERY,
  FILTER_HAS_TAGS_ANY,
  IMAP_SECURITY,
  MAIL_SCOPE_ATTACHMENTS,
  MAIL_SCOPE_EML,
  MATCH_LITERAL,
  PATTERN_LIMIT,
  TRIGGER_ADDED,
  TRIGGER_UPDATED,
  billerPatterns,
  billerRoom,
  correspondentBody,
  fieldsWorkflow,
  imapFromEnv,
  mailAccountBody,
  mailRuleBodies,
  parseBillers,
  paymentNotBillWorkflow,
  shareWorkflow,
  waitingView,
} from './setup';

/** Paperless runs Python regexes; (?s) and \A have JS equivalents for testing. */
function py(pattern: string): RegExp {
  return new RegExp(pattern.replace('(?s)', '').replace(String.raw`\A`, '^'), 'is');
}

describe('parseBillers', () => {
  it('trims, collapses spaces and drops duplicates and blanks', () => {
    expect(parseBillers(' City  Water, Electric Co,, city water ,')).toEqual(['City Water', 'Electric Co']);
    expect(parseBillers('')).toEqual([]);
  });
});

describe('billerPatterns', () => {
  const { bill, payment } = billerPatterns(['City Water', 'AT&T (Mobile)']);

  it('tags a statement from a biller as a bill only', () => {
    const text = 'City Water\nYour statement. Amount due by Oct 20.';
    expect(py(bill).test(text)).toBe(true);
    expect(py(payment).test(text)).toBe(false);
  });

  it('tags payment wording from a biller as a payment only', () => {
    for (const text of ['City Water: thank you for your payment', 'CITY WATER\nYour payment has been processed.']) {
      expect(py(payment).test(text)).toBe(true);
      expect(py(bill).test(text)).toBe(false);
    }
  });

  it('keeps "to be processed" on a bill a bill', () => {
    const text = 'City Water bill: schedule your payment to be processed by the due date';
    expect(py(bill).test(text)).toBe(true);
    expect(py(payment).test(text)).toBe(false);
  });

  it('ignores other senders and escapes regex characters in names', () => {
    expect(py(bill).test('Grocery store invoice due')).toBe(false);
    expect(py(bill).test('AT&T (Mobile) statement')).toBe(true);
    expect(py(bill).test('ATXT Mobile statement')).toBe(false);
  });

  it('fits the limit with a few short names, and says how much room there is', () => {
    expect(billerRoom()).toBeGreaterThan(40);
    expect(billerRoom()).toBeLessThan(PATTERN_LIMIT);
    const short = billerPatterns(['water', 'electric', 'gas']);
    expect(Math.max(short.bill.length, short.payment.length)).toBeLessThanOrEqual(PATTERN_LIMIT);
  });
});

describe('workflow bodies', () => {
  it('adds fields on arrival and, when supported, on later tagging', () => {
    const both = fieldsWorkflow('w', 7, [1, 2], true, [1, 2, 3, 4]);
    expect(both.triggers.map((t) => t.type)).toEqual([TRIGGER_ADDED, TRIGGER_UPDATED]);
    expect(both.triggers.every((t) => JSON.stringify(t.filter_has_tags) === '[7]')).toBe(true);
    expect(both.triggers[0].sources).toEqual([1, 2, 3, 4]);
    expect(both.actions[0].assign_custom_fields).toEqual([1, 2]);
    expect(fieldsWorkflow('w', 7, [1], false).triggers).toHaveLength(1);
    expect(fieldsWorkflow('w', 7, [1], false).triggers[0]).not.toHaveProperty('sources');
  });

  it('takes the bill tag off payments', () => {
    const wf = paymentNotBillWorkflow(1, 2, true);
    expect(wf.triggers.map((t) => t.type)).toEqual([TRIGGER_ADDED, TRIGGER_UPDATED]);
    expect(wf.triggers[0].filter_has_tags).toEqual([2]);
    expect(wf.actions[0]).toEqual({ type: ACTION_REMOVAL, remove_tags: [1] });
  });

  it('shares new documents with the group', () => {
    const wf = shareWorkflow(3);
    expect(wf.triggers[0].type).toBe(TRIGGER_ADDED);
    expect(wf.actions[0].assign_view_groups).toEqual([3]);
  });
});

describe('imapFromEnv', () => {
  it('is off without a server or folder', () => {
    expect(imapFromEnv({})).toBeNull();
    expect(imapFromEnv({ PAPERLESS_SETUP_IMAP_HOST: 'imap.example.com' })).toBeNull();
  });

  it('reads the mailbox, defaulting the port from the security', () => {
    const base = { PAPERLESS_SETUP_IMAP_HOST: 'imap.example.com', PAPERLESS_SETUP_MAIL_FOLDER: 'Bills', PAPERLESS_SETUP_IMAP_USER: 'me' };
    expect(imapFromEnv(base)).toMatchObject({ host: 'imap.example.com', port: 993, security: 'ssl', user: 'me', password: '', folder: 'Bills' });
    expect(imapFromEnv({ ...base, PAPERLESS_SETUP_IMAP_SECURITY: 'none' })?.port).toBe(143);
    expect(imapFromEnv({ ...base, PAPERLESS_SETUP_IMAP_SECURITY: 'NONE', PAPERLESS_SETUP_IMAP_PORT: '3143' })).toMatchObject({ security: 'none', port: 3143 });
  });

  it('rejects an unknown security or a bad port', () => {
    const base = { PAPERLESS_SETUP_IMAP_HOST: 'h', PAPERLESS_SETUP_MAIL_FOLDER: 'Bills' };
    expect(() => imapFromEnv({ ...base, PAPERLESS_SETUP_IMAP_SECURITY: 'tls' })).toThrow(/none, ssl or starttls/);
    expect(() => imapFromEnv({ ...base, PAPERLESS_SETUP_IMAP_PORT: 'abc' })).toThrow(/port/);
  });
});

describe('mail bodies', () => {
  it('maps security to Paperless numbers', () => {
    const imap = { host: 'protonmail-bridge', port: 143, security: 'none' as const, user: 'u', password: 'p', folder: 'Folders/Bills' };
    expect(mailAccountBody(imap)).toMatchObject({ imap_server: 'protonmail-bridge', imap_port: 143, imap_security: IMAP_SECURITY.none });
  });

  it('makes an attachments rule and an email-body rule on the folder, both tagging bill', () => {
    const [attachments, email] = mailRuleBodies(5, 'Folders/Bills', 7);
    expect(attachments).toMatchObject({ account: 5, folder: 'Folders/Bills', assign_tags: [7], consumption_scope: MAIL_SCOPE_ATTACHMENTS });
    expect(email).toMatchObject({ account: 5, folder: 'Folders/Bills', assign_tags: [7], consumption_scope: MAIL_SCOPE_EML });
  });

  it('matches a biller correspondent by its exact name', () => {
    expect(correspondentBody('City Water')).toMatchObject({ match: 'City Water', matching_algorithm: MATCH_LITERAL, is_insensitive: true });
  });
});

describe('waitingView', () => {
  it('filters both tags and an Amount that is missing or empty', () => {
    const view = waitingView([1, 2], 9);
    expect(view.filter_rules.slice(0, 2)).toEqual([
      { rule_type: FILTER_HAS_TAGS_ANY, value: '1' },
      { rule_type: FILTER_HAS_TAGS_ANY, value: '2' },
    ]);
    expect(view.filter_rules[2].rule_type).toBe(FILTER_CUSTOM_FIELD_QUERY);
    expect(JSON.parse(view.filter_rules[2].value)).toEqual(['OR', [[9, 'exists', false], [9, 'isnull', true]]]);
  });
});
