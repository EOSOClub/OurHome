// Step 9: move history back in time inside the demo DB (ourhome_demo on the
// ourhome_demo_mongo container ONLY), and fill fields the API can't set.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HERE, day, log, loadState } from './lib.mjs';

const st = loadState();
log('step 9: building backdate script');
const data = {
  completions: st.completions,
  windows: st.windows,
  billExtra: st.billExtra,
  taskIds: Object.values(st.tasks),
  invIds: Object.values(st.inv),
  longAgo: day(-60, 10),
  setupDay: day(-45, 10),
  tasksCreated: day(-42, 9),
  now: new Date().toISOString(),
};

const script = `
const D = ${JSON.stringify(data)};
const ms = (s) => new Date(s).getTime();
const at = (s, plus = 0) => new Date(ms(s) + plus);
function out(...a) { print(new Date().toISOString().slice(11, 19), ...a); }

// 1. Drop noise made by the seeding itself (due-date resets, renames).
for (const [verb, subject] of [['updated', 'task'], ['updated', 'bill'], ['updated', 'room'], ['updated', 'category']]) {
  const r = db.ActivityEntry.deleteMany({ verb, subjectType: subject });
  out('removed', r.deletedCount, verb + '/' + subject, 'activity rows');
}

// 2. Task completions, their points and their activity rows.
let moved = 0;
for (const c of D.completions) {
  const tc = db.TaskCompletion.findOne({ _id: c.id });
  if (!tc) continue;
  const orig = tc.completedAt;
  const when = at(c.at);
  db.TaskCompletion.updateOne({ _id: c.id }, { $set: { completedAt: when } });
  db.PointAward.updateMany({ completionId: c.id }, { $set: { earnedAt: when, awardedAt: when } });
  db.ActivityEntry.updateOne(
    { verb: 'completed', subjectType: 'task', subjectId: c.taskId, createdAt: { $gte: new Date(orig.getTime() - 3000), $lte: new Date(orig.getTime() + 3000) } },
    { $set: { createdAt: when } });
  moved++;
}
out('moved', moved, 'task completions (with awards + activity)');

// 3. Things made inside recorded time windows.
const cols = ['ActivityEntry', 'ShoppingList', 'ShoppingItem', 'InventoryItem', 'Bill', 'BillPayment', 'Event', 'EventAttendee', 'Request', 'NfcTag', 'HomeAssistantIntegration', 'EventLog', 'Notification'];
const extraFields = { ShoppingItem: ['purchasedAt'], InventoryItem: ['lastRestockedAt'], Request: ['acceptedAt', 'completedAt'], BillPayment: [] };
let wn = 0;
for (const w of D.windows) {
  const range = { $gte: new Date(w.t0), $lte: new Date(w.t1) };
  for (const col of cols) {
    let i = 0;
    for (const doc of db.getCollection(col).find({ createdAt: range }).sort({ createdAt: 1 }).toArray()) {
      db.getCollection(col).updateOne({ _id: doc._id }, { $set: { createdAt: at(w.at, i++ * 1000) } });
    }
    for (const f of extraFields[col] || []) {
      db.getCollection(col).updateMany({ [f]: range }, { $set: { [f]: at(w.at) } });
    }
  }
  wn++;
}
out('applied', wn, 'time windows');

// 4. Before-the-story rows: household, people, places, categories, setup activity.
const hh = db.Household.findOne();
db.Household.updateMany({}, { $set: { createdAt: at(D.longAgo) } });
db.User.updateMany({}, { $set: { createdAt: at(D.longAgo) } });
for (const col of ['Floor', 'Room', 'Category']) db.getCollection(col).updateMany({}, { $set: { createdAt: at(D.longAgo) } });
const early = db.ActivityEntry.updateMany({ subjectType: { $in: ['household', 'member', 'room', 'floor', 'category'] } }, { $set: { createdAt: at(D.setupDay) } });
out('setup-era activity rows moved:', early.modifiedCount);
db.Task.updateMany({ _id: { $in: D.taskIds } }, { $set: { createdAt: at(D.tasksCreated) } });
db.ActivityEntry.updateMany({ verb: 'created', subjectType: 'task' }, { $set: { createdAt: at(D.tasksCreated) } });

// 4b. A completed request's done-by date sits a day after it was accepted.
for (const r of db.Request.find({ completedAt: { $ne: null }, acceptedAt: { $ne: null } }).toArray()) {
  db.Request.updateOne({ _id: r._id }, { $set: { dueAt: new Date(r.acceptedAt.getTime() + 2 * 86400000) } });
}

// 5. Recurrence rules: next run = the task's / bill's current due date.
let rr = 0;
for (const col of ['Task', 'Bill']) for (const d of db.getCollection(col).find({ recurrenceId: { $ne: null }, dueDate: { $ne: null } }).toArray()) {
  db.RecurrenceRule.updateOne({ _id: d.recurrenceId }, { $set: { nextRunAt: d.dueDate } }); rr++;
}
out('recurrence rules aligned:', rr);

// 6. One-off "gutters" task: its completedAt matches its (backdated) completion.
for (const t of db.Task.find({ _id: { $in: D.taskIds }, status: 'completed' }).toArray()) {
  const last = db.TaskCompletion.find({ taskId: t._id }).sort({ completedAt: -1 }).limit(1).toArray()[0];
  if (last) db.Task.updateOne({ _id: t._id }, { $set: { completedAt: last.completedAt } });
}

// 7. Inventory forecasts: last restock + reorder interval. Items never
// restocked get a plausible last restock part-way through their interval.
const now = new Date(D.now).getTime();
let inv = 0;
for (const it of db.InventoryItem.find({ _id: { $in: D.invIds } }).toArray()) {
  const n = it.reorderIntervalDays;
  let last = it.lastRestockedAt;
  if (!last && n) last = new Date(now - Math.round(n * 0.7) * 86400000);
  if (!last) last = new Date(now - 30 * 86400000);
  db.InventoryItem.updateOne({ _id: it._id }, { $set: { lastRestockedAt: last, predictedDepletionAt: n ? new Date(last.getTime() + n * 86400000) : null } });
  inv++;
}
out('inventory forecasts refreshed:', inv);

// 8. Bill details the form doesn't take: account and invoice numbers.
let bx = 0;
for (const [id, extra] of Object.entries(D.billExtra)) {
  if (Object.keys(extra).length) { db.Bill.updateOne({ _id: id }, { $set: extra }); bx++; }
}
out('bills with account/invoice numbers:', bx);
// A payment's createdAt follows its paidAt.
db.BillPayment.updateMany({}, [{ $set: { createdAt: '$paidAt' } }]);
out('done; household', hh && hh.name);
`;

const file = path.join(HERE, 'backdate.mongo.js');
fs.writeFileSync(file, script);
log('script written:', file, `(${script.length} bytes)`);
const target = 'ourhome_demo_mongo';
execFileSync('docker', ['cp', file, `${target}:/tmp/backdate.mongo.js`], { stdio: 'inherit' });
log('copied into', target, '- running against ourhome_demo');
const res = execFileSync('docker', ['exec', target, 'mongosh', 'ourhome_demo', '--quiet', '--file', '/tmp/backdate.mongo.js'], { encoding: 'utf8' });
console.log(res.trim());
log('step 9 done');
