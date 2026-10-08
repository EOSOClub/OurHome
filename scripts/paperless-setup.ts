import { loadSettings, readSettings } from '@/server/settings';
import { paperlessNames as names } from '@/server/paperless/names';
import {
  MATCH_NONE,
  MATCH_REGEX,
  PATTERN_LIMIT,
  PaperlessAdmin,
  READ_ONLY_PERMISSIONS,
  SETUP_NAMES,
  allBillsView,
  billerPatterns,
  billerRoom,
  correspondentBody,
  fieldsWorkflow,
  imapFromEnv,
  mailAccountBody,
  mailRuleBodies,
  parseBillers,
  paymentNotBillWorkflow,
  randomPassword,
  shareWorkflow,
  waitingView,
  type ImapSettings,
  type SavedViewBody,
  type WorkflowBody,
} from '@/server/paperless/setup';

// One-time Paperless setup for the bill import, with an admin login that is
// used for this run only and never stored. Creates what's missing (found by
// name, so re-running is safe):
//
//   - tags bill / bill-payment (visible to everyone), custom fields Amount,
//     Due date, Account number, Invoice number
//   - group "Our Home (read-only)" + user "ourhome" with view-only rights, and
//     that user's API token
//   - workflows: share new documents with the group; add the empty fields
//     when a document gets bill / bill-payment
//   - workflow: payments lose the bill tag (mail rules tag the folder `bill`)
//   - saved views on the dashboard: all bills & payments, and those waiting
//     for an Amount
//   - optional, from a list of billers: a correspondent each, and content
//     matching on the two tags
//   - optional, from PAPERLESS_SETUP_IMAP_* / _MAIL_FOLDER: a mail account on
//     the bills folder and its two rules (attachments, HTML-only emails)
//
// Progress goes to stderr; the token is the only thing on stdout, so the
// deploy scripts can capture it into .env:
//
//   PAPERLESS_ADMIN_USER=admin PAPERLESS_ADMIN_PASSWORD=… \
//   PAPERLESS_SETUP_BILLERS="City Water, Electric Co" npm run -s paperless:setup
//
// On the server the deploy walkthrough runs it inside the web container, where
// Paperless is reachable by its container name.

loadSettings();
// On your PC the dev overrides turn Paperless off; take the server address.
if (process.env.NODE_ENV !== 'production' && !process.env.PAPERLESS_URL) {
  process.env.PAPERLESS_URL = readSettings('server').PAPERLESS_URL ?? '';
}

const log = (line: string) => console.error(`[paperless-setup] ${line}`);
const ok = (line: string) => log(`✓ ${line}`);
const warn = (line: string) => log(`! ${line}`);

interface Named { id: number; name: string }
interface Tag extends Named { matching_algorithm: number; match: string; owner: number | null }
interface Field extends Named { data_type: string }
interface Group extends Named { permissions: string[] }
interface User { id: number; username: string; groups: number[] }

async function ensureTag(pl: PaperlessAdmin, name: string): Promise<Tag> {
  const found = await pl.findByName<Tag>('/api/tags/', name);
  if (!found) {
    const tag = await pl.post<Tag>('/api/tags/', { name, matching_algorithm: MATCH_NONE, match: '', owner: null });
    ok(`tag "${name}" created`);
    return tag;
  }
  if (found.owner != null) {
    // An owned tag is hidden from the import user.
    await pl.patch(`/api/tags/${found.id}/`, { owner: null });
    ok(`tag "${name}" exists; owner removed so every user can see it`);
  } else {
    ok(`tag "${name}" exists`);
  }
  return found;
}

async function ensureField(pl: PaperlessAdmin, name: string, dataType: string): Promise<Field> {
  const found = await pl.findByName<Field>('/api/custom_fields/', name);
  if (found) {
    if (found.data_type !== dataType) {
      warn(`custom field "${name}" exists as ${found.data_type}, expected ${dataType}; left as it is`);
    } else {
      ok(`custom field "${name}" exists`);
    }
    return found;
  }
  const field = await pl.post<Field>('/api/custom_fields/', { name, data_type: dataType });
  ok(`custom field "${name}" (${dataType}) created`);
  return field;
}

async function ensureGroup(pl: PaperlessAdmin): Promise<Group> {
  const found = await pl.findByName<Group>('/api/groups/', SETUP_NAMES.group);
  if (!found) {
    const group = await pl.post<Group>('/api/groups/', { name: SETUP_NAMES.group, permissions: READ_ONLY_PERMISSIONS });
    ok(`group "${SETUP_NAMES.group}" created (view only: documents, tags, correspondents, custom fields)`);
    return group;
  }
  const missing = READ_ONLY_PERMISSIONS.filter((p) => !found.permissions.includes(p));
  if (missing.length) {
    await pl.patch(`/api/groups/${found.id}/`, { permissions: [...found.permissions, ...missing] });
    ok(`group "${SETUP_NAMES.group}" exists; added ${missing.join(', ')}`);
  } else {
    ok(`group "${SETUP_NAMES.group}" exists`);
  }
  return found;
}

/** The import user with a fresh random password (it only signs in with its token). */
async function ensureUser(pl: PaperlessAdmin, username: string, groupId: number): Promise<{ user: User; password: string }> {
  const password = randomPassword();
  const found = await pl.findByName<User>('/api/users/', username);
  if (!found) {
    const user = await pl.post<User>('/api/users/', {
      username,
      password,
      groups: [groupId],
      user_permissions: [],
      is_active: true,
      is_staff: false,
      is_superuser: false,
    });
    ok(`user "${username}" created (in "${SETUP_NAMES.group}" only)`);
    return { user, password };
  }
  const groups = found.groups.includes(groupId) ? found.groups : [...found.groups, groupId];
  await pl.patch(`/api/users/${found.id}/`, { password, groups });
  ok(`user "${username}" exists; password reset (it signs in with its token only)`);
  return { user: found, password };
}

/** Creates a workflow unless one with its name exists. Returns false if Paperless refused it. */
async function ensureWorkflow(pl: PaperlessAdmin, body: WorkflowBody, fallback?: WorkflowBody): Promise<boolean> {
  if (await pl.findByName<Named>('/api/workflows/', body.name)) {
    ok(`workflow "${body.name}" exists`);
    return true;
  }
  try {
    await pl.post('/api/workflows/', body);
    ok(`workflow "${body.name}" created`);
    return true;
  } catch (err) {
    if (fallback) {
      await pl.post('/api/workflows/', fallback);
      ok(`workflow "${body.name}" created (on arrival only; this Paperless can't trigger on updates)`);
      return true;
    }
    warn(`workflow "${body.name}" not created: ${(err as Error).message}`);
    return false;
  }
}

async function ensureView(pl: PaperlessAdmin, body: SavedViewBody, fallback?: SavedViewBody): Promise<void> {
  if (await pl.findByName<Named>('/api/saved_views/', body.name)) {
    ok(`saved view "${body.name}" exists`);
    return;
  }
  try {
    await pl.post('/api/saved_views/', body);
    ok(`saved view "${body.name}" created (dashboard + sidebar)`);
  } catch (err) {
    if (fallback) {
      await ensureView(pl, fallback);
      return;
    }
    warn(`saved view "${body.name}" not created: ${(err as Error).message}`);
  }
}

/** Content matching on both tags, unless a tag already matches some other way. */
async function applyMatching(pl: PaperlessAdmin, billers: string[], bill: Tag, payment: Tag): Promise<void> {
  const patterns = billerPatterns(billers);
  const longest = Math.max(patterns.bill.length, patterns.payment.length);
  if (longest > PATTERN_LIMIT) {
    warn(
      `biller names are too long for Paperless's ${PATTERN_LIMIT}-character pattern limit ` +
        `(room for about ${billerRoom()} characters, including the | between names). ` +
        'Shorten them (e.g. "City Water" → "water") and run setup again. Tags left as they were.',
    );
    return;
  }
  for (const [tag, pattern] of [[bill, patterns.bill], [payment, patterns.payment]] as const) {
    if (tag.matching_algorithm !== MATCH_NONE && tag.matching_algorithm !== MATCH_REGEX) {
      warn(`tag "${tag.name}" already uses another matching rule; left as it is`);
      continue;
    }
    await pl.patch(`/api/tags/${tag.id}/`, { matching_algorithm: MATCH_REGEX, match: pattern, is_insensitive: true });
    ok(`tag "${tag.name}" now matches documents from: ${billers.join(', ')}`);
  }
  log('  (matching runs on newly added documents; existing ones keep their tags)');
}

async function ensureCorrespondent(pl: PaperlessAdmin, name: string): Promise<void> {
  if (await pl.findByName<Named>('/api/correspondents/', name)) {
    ok(`correspondent "${name}" exists`);
    return;
  }
  await pl.post('/api/correspondents/', correspondentBody(name));
  ok(`correspondent "${name}" created (matches documents naming it)`);
}

/**
 * The mail account and its two rules. A new account needs the password; an
 * existing one gets the new connection details only when a password was given
 * (e.g. a Bridge reset made a new one). The connection is tested first, but a
 * failed test only warns, so the account can be fixed in Paperless's UI.
 */
async function ensureMail(pl: PaperlessAdmin, imap: ImapSettings, billTagId: number): Promise<void> {
  const body = mailAccountBody(imap);
  if (imap.password) {
    try {
      const res = await pl.post<{ success?: boolean }>('/api/mail_accounts/test/', body);
      if (res.success) ok(`signed in to ${imap.host} as ${imap.user}`);
      else warn(`couldn't sign in to ${imap.host}; check it in Paperless under Mail → Mail accounts`);
    } catch (err) {
      warn(`couldn't sign in to ${imap.host} (${(err as Error).message}); check it in Paperless under Mail → Mail accounts`);
    }
  }
  let account = await pl.findByName<Named>('/api/mail_accounts/', SETUP_NAMES.mailAccount);
  if (account) {
    if (imap.password) {
      await pl.patch(`/api/mail_accounts/${account.id}/`, body);
      ok(`mail account "${SETUP_NAMES.mailAccount}" updated`);
    } else {
      ok(`mail account "${SETUP_NAMES.mailAccount}" exists`);
    }
  } else if (!imap.password) {
    warn('mail account not created: no mail password this run (run the setup again and give it)');
    return;
  } else {
    account = await pl.post<Named>('/api/mail_accounts/', body);
    ok(`mail account "${SETUP_NAMES.mailAccount}" created`);
  }
  for (const rule of mailRuleBodies(account.id, imap.folder, billTagId)) {
    if (await pl.findByName<Named>('/api/mail_rules/', rule.name)) {
      ok(`mail rule "${rule.name}" exists`);
      continue;
    }
    await pl.post('/api/mail_rules/', rule);
    ok(`mail rule "${rule.name}" created (folder "${imap.folder}" → tag bill)`);
  }
  log('  (mail is checked every 10 minutes; Mail → Process mail in Paperless runs it now)');
}

async function main() {
  const url = process.env.PAPERLESS_URL?.trim().replace(/\/+$/, '');
  const adminUser = process.env.PAPERLESS_ADMIN_USER?.trim();
  const adminPassword = process.env.PAPERLESS_ADMIN_PASSWORD ?? '';
  if (!url) throw new Error('Set paperless.url in settings.yml first.');
  if (!adminUser || !adminPassword) throw new Error('Set PAPERLESS_ADMIN_USER and PAPERLESS_ADMIN_PASSWORD (used for this run only).');
  const importUser = process.env.PAPERLESS_SETUP_USER?.trim() || SETUP_NAMES.user;
  const billers = parseBillers(process.env.PAPERLESS_SETUP_BILLERS ?? '');

  const pl = new PaperlessAdmin(url, adminUser, adminPassword);
  log(`connecting to ${url} as ${adminUser}…`);
  await pl.get('/api/users/?page_size=1'); // checks the login and admin rights up front
  ok(`signed in (Paperless ${pl.version || 'version unknown'})`);

  log('tags and custom fields…');
  const billTag = await ensureTag(pl, names.billTag());
  const paymentTag = await ensureTag(pl, names.paymentTag());
  const amount = await ensureField(pl, names.amountField(), 'monetary');
  const due = await ensureField(pl, names.dueDateField(), 'date');
  const account = await ensureField(pl, names.accountField(), 'string');
  const invoice = await ensureField(pl, names.invoiceField(), 'string');

  log('read-only user for Our Home…');
  const group = await ensureGroup(pl);
  const { password } = await ensureUser(pl, importUser, group.id);
  const token = await pl.tokenFor(importUser, password);
  ok(`API token for "${importUser}" ready`);

  log('documents visible to Our Home…');
  const sources = await pl.triggerSources();
  await ensureWorkflow(pl, shareWorkflow(group.id, sources));
  // Documents tagged before this run: give the group view on them too (merged
  // with whatever permissions they have).
  const tagged = await pl.listAll<{ id: number }>('/api/documents/', {
    tags__id__in: `${billTag.id},${paymentTag.id}`,
    fields: 'id',
  });
  if (tagged.length) {
    await pl.post('/api/documents/bulk_edit/', {
      documents: tagged.map((d) => d.id),
      method: 'set_permissions',
      parameters: { set_permissions: { view: { users: [], groups: [group.id] }, change: { users: [], groups: [] } }, merge: true },
    });
    ok(`${tagged.length} already-tagged document(s) shared with the group`);
  } else {
    ok('no tagged documents yet');
  }

  log('starter workflows and views…');
  const billFields = [amount.id, due.id, account.id, invoice.id];
  const paymentFields = [amount.id, account.id, invoice.id];
  await ensureWorkflow(
    pl,
    fieldsWorkflow(SETUP_NAMES.billFieldsWorkflow, billTag.id, billFields, true, sources),
    fieldsWorkflow(SETUP_NAMES.billFieldsWorkflow, billTag.id, billFields, false, sources),
  );
  await ensureWorkflow(
    pl,
    fieldsWorkflow(SETUP_NAMES.paymentFieldsWorkflow, paymentTag.id, paymentFields, true, sources),
    fieldsWorkflow(SETUP_NAMES.paymentFieldsWorkflow, paymentTag.id, paymentFields, false, sources),
  );
  await ensureWorkflow(
    pl,
    paymentNotBillWorkflow(billTag.id, paymentTag.id, true, sources),
    paymentNotBillWorkflow(billTag.id, paymentTag.id, false, sources),
  );
  await ensureView(pl, allBillsView([billTag.id, paymentTag.id]));
  await ensureView(pl, waitingView([billTag.id, paymentTag.id], amount.id));

  if (billers.length) {
    log('billers…');
    for (const name of billers) await ensureCorrespondent(pl, name);
    await applyMatching(pl, billers, billTag, paymentTag);
  } else {
    log('no billers given: tag bills by hand, by mail rule, or run setup again with billers');
  }

  const imap = imapFromEnv(process.env);
  if (imap) {
    log(`bill mailbox (${imap.host}, folder "${imap.folder}")…`);
    await ensureMail(pl, imap, billTag.id);
  }

  log('done. The token is saved by the deploy script; Our Home only ever reads with it.');
  console.log(token);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[paperless-setup] ✗ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
