import { InboxClient } from '@/server/inbox/client';
import { helloSchema, parseDocumentsReply } from '@/server/inbox/mapping';
import { DEFAULT_TIMEZONE } from '@/lib/taskCycles';

// Dry run of the OurHomeInbox bill import: tests the connection and shows
// what Our Home would do with the documents OurHomeInbox has ready. It writes
// nothing in Our Home, sends no change reports, and needs no database: the
// address and token come from the environment, not from a household's saved
// connection.
//
//   INBOX_URL=http://ourhome_inbox:8080 INBOX_TOKEN=ohi_... npm run inbox:preview
//   ... npm run inbox:preview -- 40        # what comes after document 40
//
// Optional INBOX_PUBLIC_URL shows the "Open the email" links. On the server,
// run it inside the web container, where OurHomeInbox is reachable:
//   docker compose exec -e INBOX_URL=... -e INBOX_TOKEN=... web npm run inbox:preview
//
// Asking is not without effect in OurHomeInbox (contract):
//  - asking with a number (after=n) tells OurHomeInbox that Our Home has
//    handled everything up to n. So only give a number Our Home really has
//    handled (Settings shows it); the default 0 claims nothing.
//  - every ask makes OurHomeInbox work out what to offer: it numbers the
//    documents, and the payment pairings it offers are locked from then on
//    (it never changes which bill an offered payment pays).
// It asks once, for up to 200 documents, and never for the next page.

const url = process.env.INBOX_URL?.trim().replace(/\/+$/, '');
const token = process.env.INBOX_TOKEN?.trim();
const publicUrl = process.env.INBOX_PUBLIC_URL?.trim() || null;
const after = Number(process.argv[2] ?? 0);

const money = (n: number | null | undefined) => (n == null ? '-' : n.toFixed(2));
const day = (d: Date | null | undefined) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '-';

async function main() {
  if (!url || !token) throw new Error('Set INBOX_URL and INBOX_TOKEN first.');
  if (!Number.isInteger(after) || after < 0) throw new Error('The number to start after must be a whole number, 0 or more.');
  const client = new InboxClient({ url, token, publicUrl });

  console.log(`[preview] asking ${url} who it is...`);
  const hello = helloSchema.parse(await client.hello());
  console.log(`[preview] OurHomeInbox household "${hello.household}", newest document ${hello.newest}, start date ${hello.startDate ?? '-'}`);

  console.log(`[preview] asking for up to 200 documents after ${after}...`);
  // No household (no database), so days are pinned to noon in the app's default zone.
  const page = parseDocumentsReply(await client.documents(after, 200), after, publicUrl, DEFAULT_TIMEZONE);
  console.log(`[preview] ${page.entries.length} document(s):`);
  if (page.entries.length === 0) console.log('  (none: nothing is ready in OurHomeInbox after that number)');
  for (const e of page.entries) {
    const head = `  #${String(e.number).padEnd(5)}`;
    if (e.status === 'withdrawn') {
      console.log(`${head} WITHDRAWN  ${e.messageId}  ${e.reason}`);
      continue;
    }
    if (!e.input) {
      console.log(`${head} SKIP  ${e.title.slice(0, 48).padEnd(48)}  ${e.problem}`);
      continue;
    }
    const i = e.input;
    const kind = i.kind === 'bill' ? 'BILL ' : 'PAID ';
    const when = i.kind === 'bill' ? `due ${day(i.dueDate)}` : `paid ${day(i.paidDate)}`;
    // Contract v2: a bill's reference, or for a payment the reference of the bill it pays
    // ("on its own" without one), its fee as sent, and whether OurHomeInbox judged it late.
    const pairing =
      i.kind === 'bill'
        ? i.reference ? `  ref ${i.reference}` : ''
        : `  ${i.reference ? `pays ${i.reference}` : 'on its own'}${i.fee ? `  fee ${money(i.fee)}` : ''}${i.paidLate ? '  late' : ''}`;
    console.log(
      `${head} ${kind} ${e.title.slice(0, 48).padEnd(48)} ${money(i.amount).padStart(10)}  ${when}  ${i.biller ?? '(no biller)'}${i.accountNo ? `  acct ${i.accountNo}` : ''}${pairing}`,
    );
    if (e.url) console.log(`         ${e.url}`);
  }
  if (page.more) console.log('[preview] more after these; run again with the last number shown to see them.');
  console.log(
    `[preview] done. Nothing was written in Our Home. OurHomeInbox has now numbered these documents and locked the payment pairings it offered` +
      `${after > 0 ? `, and takes it that Our Home handled everything up to ${after}` : ''}.`,
  );
  console.log(
    "[preview] note: a PAID row with \"pays <ref>\" goes on the bill with that reference; it is skipped if that bill isn't in Our Home or is already paid. \"on its own\" becomes a paid bill.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[preview] failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
