// Step 10: run the reminder sweep, leave a mix of read/unread, and sanity-check.
import { BASE, clients, cronSecret, log, loadState } from './lib.mjs';
const st = loadState();
log('step 10: reminder sweep + checks');
const s = cronSecret();
let swept = null;
for (const [label, secret] of [['CRON_SECRET', s.main], ['DEV_CRON_SECRET', s.dev]]) {
  if (!secret) { log(`  ${label} empty, skipping`); continue; }
  const r = await fetch(BASE + '/api/cron/reminders', { method: 'POST', headers: { authorization: `Bearer ${secret}` } });
  const j = await r.json().catch(() => ({}));
  log(`  sweep with ${label}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  if (r.ok) { swept = label; break; }
}
const C = await clients();
for (const [k, c] of Object.entries(C)) {
  const n = await c.get('/api/notifications?limit=100');
  const list = Array.isArray(n) ? n : n.notifications ?? n.items ?? [];
  const unread = list.filter((x) => !(x.read ?? x.isRead ?? x.readAt));
  // Read about half (the older ones), keep the newest unread.
  const toRead = unread.slice(Math.ceil(unread.length / 2));
  for (const x of toRead) await c.post('/api/notifications/read', { id: x.id });
  log(`  ${k}: ${list.length} notifications, marked ${toRead.length} read, ${unread.length - toRead.length} left unread; types: ${[...new Set(list.map((x) => x.type))].join(',')}`);
}
const sum = await C.alex.get('/api/points/summary?period=month');
log('  points (month):', JSON.stringify(sum).slice(0, 400));
const act = await C.alex.get('/api/activity');
const rows = Array.isArray(act) ? act : act.entries ?? act.items ?? [];
log(`  activity rows returned: ${rows.length}; newest: ${rows.slice(0, 3).map((r) => (r.createdAt ?? '').slice(0, 10) + ' ' + r.message).join(' | ')}`);
const bill = await C.alex.get('/api/bills');
log('  bills:', bill.map((b) => `${b.name.split(' ')[0]} ${b.dueDate?.slice(0, 10)} ${b.status}`).join('; '));
log(`step 10 done (sweep via ${swept})`);
