import 'dotenv/config';
import { previewPaperless } from '@/server/services/paperlessSync';

// Read-only dry run of the Paperless bill import: shows which tags and fields
// were found, and what would happen to each bill / bill-payment document
// changed in the last N days. Writes nothing to Paperless or the database.
//
//   npm run paperless:preview            # last 30 days
//   npm run paperless:preview -- 90      # last 90 days
//
// On the server, run it inside the web container, where Paperless is reachable:
//   docker compose exec web npm run paperless:preview

const days = Number(process.argv[2] ?? 30);

// Local dev keeps the server's values under SERVER_* (see .env.example).
process.env.PAPERLESS_URL ||= process.env.SERVER_PAPERLESS_URL;
process.env.PAPERLESS_TOKEN ||= process.env.SERVER_PAPERLESS_TOKEN;

const money = (n: number | null | undefined, cur: string | null | undefined) =>
  n == null ? '—' : `${cur ?? ''}${n.toFixed(2)}`;
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '—');

async function main() {
  console.log(`[preview] asking ${process.env.PAPERLESS_URL ?? '(PAPERLESS_URL unset)'} for documents changed in the last ${days} days…`);
  const { found, rows } = await previewPaperless(days);

  console.log('\n[preview] setup in Paperless:');
  for (const [what, value] of Object.entries(found)) console.log(`  ${what.padEnd(36)} ${value}`);

  console.log(`\n[preview] ${rows.length} tagged document(s):`);
  if (rows.length === 0) console.log('  (none: tag a bill "bill" or a payment "bill-payment" in Paperless)');
  for (const r of rows) {
    const head = `  #${String(r.id).padEnd(5)} ${r.title.slice(0, 48).padEnd(48)}`;
    if (!r.evaluation.ready) {
      console.log(`${head} WAIT  ${r.evaluation.reason}`);
      continue;
    }
    const i = r.evaluation.input;
    const kind = i.kind === 'bill' ? 'BILL ' : 'PAID ';
    const when = i.kind === 'bill' ? `due ${day(i.dueDate)}` : `paid ${day(i.paidDate)}`;
    console.log(`${head} ${kind} ${money(i.amount, i.currency).padStart(11)}  ${when}  ${i.biller ?? '(no correspondent)'}${i.accountNo ? `  acct ${i.accountNo}` : ''}`);
  }
  const ready = rows.filter((r) => r.evaluation.ready).length;
  console.log(`\n[preview] done: ${ready} ready to import, ${rows.length - ready} waiting. Nothing was written.`);
  console.log('[preview] note: PAID rows still need a matching unpaid bill in Our Home, or they are skipped.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[preview] failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
