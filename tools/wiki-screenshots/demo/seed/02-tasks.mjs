// Step 2: tasks with history. Completions are made through the API now and
// their timestamps are moved back later by 09-backdate.mjs (state.completions).
import { clients, day, log, loadState, saveState, sleep } from './lib.mjs';

const st = loadState();
log('step 2: tasks');
const C = await clients();
const U = st.users, R = st.rooms, K = st.cats;
const TZ = 'America/Chicago';

// Deterministic pseudo-random so reruns look the same.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const tasks = [
  { key: 'dishes', title: 'Do the dishes', notes: 'Load the dishwasher, hand-wash the pans, wipe the sink.', type: 'recurring', priority: 'medium', categoryId: K['task:Kitchen'], roomId: R.Kitchen, assigneeId: U.jordan, rotationUserIds: [U.jordan, U.riley], estimatedMinutes: 20, recurrence: { kind: 'daily', interval: 1, timezone: TZ }, due: day(0, 20), history: { everyDays: 1, from: -41, users: ['jordan', 'riley', 'jordan', 'riley', 'sam'], skip: 0.25, hour: 20 } },
  { key: 'counters', title: 'Wipe kitchen counters', type: 'recurring', priority: 'low', categoryId: K['task:Kitchen'], roomId: R.Kitchen, assigneeId: U.sam, estimatedMinutes: 10, recurrence: { kind: 'daily', interval: 1, timezone: TZ }, due: day(0, 21), history: { everyDays: 2, from: -40, users: ['sam', 'alex', 'sam'], skip: 0.2, hour: 21 } },
  { key: 'cat', title: 'Feed Biscuit', notes: 'Half a cup of dry food morning and evening. Fresh water too.', type: 'recurring', priority: 'high', categoryId: K['task:Pets'], roomId: R.Kitchen, assigneeId: U.mia, estimatedMinutes: 5, recurrence: { kind: 'daily', interval: 1, timezone: TZ }, due: day(0, 18), history: { everyDays: 1, from: -35, users: ['mia', 'mia', 'riley', 'mia', 'sam'], skip: 0.15, hour: 18 } },
  { key: 'bins', title: 'Take out the bins', notes: 'Trash and recycling to the curb Wednesday night. Pickup is Thursday morning.', type: 'recurring', priority: 'high', categoryId: K['task:Cleaning'], roomId: R.Entryway, assigneeId: U.riley, estimatedMinutes: 10, recurrence: { kind: 'weekly', interval: 1, byWeekday: [3], timezone: TZ }, due: day(3, 20), history: { everyDays: 7, from: -39, users: ['riley', 'riley', 'jordan', 'riley', 'riley', 'riley'], skip: 0, hour: 20 } },
  { key: 'vacuum', title: 'Vacuum the living room', notes: 'Under the couch cushions too. Empty the canister after.', type: 'recurring', priority: 'medium', categoryId: K['task:Cleaning'], roomId: R['Living room'], assigneeId: U.sam, estimatedMinutes: 30, recurrence: { kind: 'weekly', interval: 1, byWeekday: [6], timezone: TZ }, due: day(-1, 12), history: { everyDays: 7, from: -36, users: ['sam', 'alex', 'sam', 'sam'], skip: 0, hour: 11 } },
  { key: 'laundry', title: 'Laundry day', type: 'recurring', priority: 'medium', categoryId: K['task:Laundry'], roomId: R.Laundry, assigneeId: U.jordan, estimatedMinutes: 60, recurrence: { kind: 'weekly', interval: 1, byWeekday: [0, 3], timezone: TZ }, due: day(0, 12), subtasks: [{ title: 'Wash darks and lights' }, { title: 'Move to the dryer' }, { title: 'Fold everything' }, { title: 'Put it all away' }], history: { everyDays: 3.5, from: -38, users: ['jordan', 'sam', 'jordan', 'alex'], skip: 0.1, hour: 15 } },
  { key: 'bathroom', title: 'Clean the bathroom', type: 'recurring', priority: 'medium', categoryId: K['task:Cleaning'], roomId: R.Bathroom, assigneeId: U.alex, estimatedMinutes: 45, recurrence: { kind: 'weekly', interval: 1, byWeekday: [2], timezone: TZ }, due: day(2, 12), subtasks: [{ title: 'Scrub the toilet' }, { title: 'Wipe the mirror and sink' }, { title: 'Scrub the shower' }, { title: 'Mop the floor' }, { title: 'Swap in fresh towels' }], history: { everyDays: 7, from: -40, users: ['alex', 'sam', 'alex', 'alex', 'sam'], skip: 0, hour: 10 } },
  { key: 'plants', title: 'Water the plants', notes: 'Fern by the window likes a little extra. Skip the cactus.', type: 'recurring', priority: 'low', categoryId: K['task:Yard'], roomId: R['Living room'], assigneeId: U.mia, estimatedMinutes: 10, recurrence: { kind: 'interval', interval: 3, timezone: TZ }, due: day(1, 12), history: { everyDays: 3, from: -38, users: ['mia', 'mia', 'sam'], skip: 0.1, hour: 17 } },
  { key: 'lawn', title: 'Mow the lawn', type: 'recurring', priority: 'medium', categoryId: K['task:Yard'], floorId: st.floors['Ground floor'], assigneeId: U.riley, estimatedMinutes: 50, recurrence: { kind: 'weekly', interval: 1, byWeekday: [6], timezone: TZ }, due: day(-1, 13), history: { everyDays: 7, from: -38, users: ['riley', 'alex', 'riley', 'riley'], skip: 0.2, hour: 14 } },
  { key: 'tidy', title: 'Tidy your room', type: 'recurring', priority: 'low', categoryId: K['task:Cleaning'], roomId: R["Riley's room"], assigneeId: U.riley, estimatedMinutes: 20, recurrence: { kind: 'weekly', interval: 1, byWeekday: [0], timezone: TZ }, due: day(0, 18), history: { everyDays: 7, from: -35, users: ['riley'], skip: 0.25, hour: 19 } },
  { key: 'fridge', title: 'Clean out the fridge', notes: 'Toss anything expired, wipe the shelves, check the water filter light.', type: 'recurring', priority: 'medium', categoryId: K['task:Kitchen'], roomId: R.Kitchen, assigneeId: U.sam, estimatedMinutes: 30, recurrence: { kind: 'monthly', interval: 1, byMonthday: [18], timezone: TZ }, due: day(7, 12), history: { dates: [[-23, 'sam']], hour: 16 } },
  { key: 'filter', title: 'Replace the furnace filter', notes: '16x25x1 MERV 8. Spare filters are on the shelf above the dryer.', type: 'maintenance', priority: 'high', categoryId: K['task:Maintenance'], roomId: R.Laundry, assigneeId: U.alex, estimatedMinutes: 15, due: day(-5, 12) },
  { key: 'door', title: 'Fix the squeaky closet door', notes: 'Hinge needs WD-40 or a new pin.', type: 'one_time', priority: 'low', categoryId: K['task:Maintenance'], roomId: R["Alex & Sam's room"], assigneeId: U.jordan, estimatedMinutes: 20, due: day(3, 12) },
  { key: 'smoke', title: 'Test the smoke alarms', type: 'one_time', priority: 'urgent', categoryId: K['task:Maintenance'], floorId: st.floors.Upstairs, assigneeId: U.alex, estimatedMinutes: 15, due: day(-2, 12), subtasks: [{ title: 'Upstairs hallway' }, { title: "Riley's room" }, { title: 'Main bedroom' }, { title: 'Kitchen (ground floor)' }] },
  { key: 'gutters', title: 'Book the gutter cleaning', type: 'one_time', priority: 'medium', categoryId: K['task:Yard'], assigneeId: U.sam, estimatedMinutes: 10, due: day(-12, 12), history: { dates: [[-13, 'sam']], hour: 13 }, oneOff: true },
];

st.tasks = st.tasks ?? {};
st.completions = st.completions ?? [];
for (const t of tasks) {
  const { key, due, history, oneOff, ...body } = t;
  if (!st.tasks[key]) {
    const created = await C.alex.post('/api/tasks', { ...body, dueDate: due, pointsFollowTime: true });
    st.tasks[key] = created.id;
    log(`task ${key} created id=${created.id} points=${created.points ?? created.pointsCenti ?? '?'}`);
    saveState(st);
  } else log(`task ${key} exists`);
  if (!history || st.completions.some((c) => c.taskId === st.tasks[key])) continue;

  // Build the list of past completion moments.
  const moments = [];
  if (history.dates) for (const [off, u] of history.dates) moments.push([off, u]);
  else {
    let i = 0;
    for (let off = history.from; off <= -1; off += history.everyDays, i++) {
      if (rnd() < history.skip) continue;
      moments.push([Math.round(off), history.users[i % history.users.length]]);
    }
  }
  let n = 0;
  for (const [off, u] of moments) {
    const at = day(off, history.hour, Math.floor(rnd() * 50));
    if (!oneOff) await C.alex.post('/api/tasks/update', { taskId: st.tasks[key], dueDate: day(off, history.hour + 1) });
    let who = u;
    let res;
    try {
      res = await C[who].post('/api/tasks/complete', { taskId: st.tasks[key] });
    } catch (e) {
      log(`  ${who} could not complete (${e.message.slice(0, 120)}), using sam`);
      who = 'sam';
      res = await C.sam.post('/api/tasks/complete', { taskId: st.tasks[key] });
    }
    st.completions.push({ id: res.completionId, taskId: st.tasks[key], user: who, at });
    n++;
    await sleep(250);
  }
  saveState(st);
  log(`  ${key}: ${n} past completions recorded`);
  if (!oneOff) {
    await C.alex.post('/api/tasks/update', { taskId: st.tasks[key], dueDate: due });
    log(`  ${key}: due date reset to ${due}`);
  }
}

// Partly done checklist on today's laundry so the screenshot shows progress.
const laundry = (await C.alex.get('/api/tasks')).find((t) => t.id === st.tasks.laundry);
const steps = laundry?.subtasks ?? [];
for (const s of steps.slice(0, 2)) {
  await C.jordan.post('/api/subtasks/update', { subtaskId: s.id, done: true });
}
log(`laundry: checked ${Math.min(2, steps.length)} of ${steps.length} steps`);
const smoke = (await C.alex.get('/api/tasks')).find((t) => t.id === st.tasks.smoke);
if (smoke?.subtasks?.[0]) await C.alex.post('/api/subtasks/update', { subtaskId: smoke.subtasks[0].id, done: true });
log('smoke alarms: first step checked');
saveState(st);
log(`step 2 done: ${Object.keys(st.tasks).length} tasks, ${st.completions.length} completions`);
