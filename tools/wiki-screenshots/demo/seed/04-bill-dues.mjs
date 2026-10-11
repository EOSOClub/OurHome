// Step 4: put each recurring bill's next due date where the story wants it.
import { clients, day, log, loadState } from './lib.mjs';
const st = loadState();
log('step 4: bill due dates');
const { alex } = await clients(['alex']);
const due = { mortgage: day(21, 12), electric: day(4, 12), water: day(-5, 12), internet: day(9, 12), phone: day(2, 12), car: day(13, 12), streaming: day(13, 12) };
for (const [k, d] of Object.entries(due)) {
  const b = await alex.post('/api/bills/update', { id: st.bills[k], dueDate: d });
  log(`  ${k}: due ${b.dueDate?.slice(0, 10)} status ${b.status} recurrence next ${b.recurrence?.nextRunAt?.slice(0, 10) ?? '-'}`);
}
log('step 4 done');
