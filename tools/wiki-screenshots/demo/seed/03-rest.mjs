// Step 3: shopping, inventory (with adjustment history), bills (with payments),
// calendar, requests, NFC tags, Home Assistant token.
// Every call whose timestamps should be in the past is wrapped in `at(...)`,
// which records a time window so 09-backdate.mjs can move rows made in it.
import { clients, day, log, loadState, saveState, sleep } from './lib.mjs';

const st = loadState();
log('step 3: shopping, inventory, bills, calendar, requests, nfc, integrations');
const C = await clients();
const U = st.users, R = st.rooms, K = st.cats;
const TZ = 'America/Chicago';
st.windows = st.windows ?? [];
async function at(when, fn) {
  const t0 = new Date().toISOString();
  await sleep(30);
  const r = await fn();
  await sleep(30);
  st.windows.push({ t0, t1: new Date().toISOString(), at: when });
  return r;
}

async function asOrSam(who, p, body) {
  try { return await C[who].post(p, body); } catch (e) {
    log(`  ${who} refused on ${p} (${e.message.slice(0, 100)}), using sam`);
    return C.sam.post(p, body);
  }
}
// ---------------- Shopping ----------------
if (!st.lists) {
  st.lists = {};
  const existing = await C.sam.get('/api/shopping/lists');
  log('existing lists:', existing.map((l) => `${l.name}/${l.kind}`).join(', ') || 'none');
  for (const [name, kind] of [['Groceries', 'grocery'], ['Hardware store', 'hardware']]) {
    const same = existing.find((l) => l.kind === kind);
    if (same) {
      if (same.name !== name) await C.sam.post('/api/shopping/lists/update', { listId: same.id, name });
      st.lists[name] = same.id; log(`  reused list ${same.name} as ${name}`);
    } else {
      const l = await at(day(-9, 10), () => C.sam.post('/api/shopping/lists', { name, kind }));
      st.lists[name] = l.id; log(`  list ${name} created`);
    }
  }
  const items = [
    ['Groceries', 'sam', { name: 'Bananas', quantity: 1, priority: 'medium', categoryId: K['shopping:Produce'], estimatedPrice: 1.89, recurring: true }],
    ['Groceries', 'sam', { name: 'Oat milk', quantity: 2, priority: 'high', categoryId: K['shopping:Dairy'], estimatedPrice: 4.49, recurring: true }],
    ['Groceries', 'alex', { name: 'Sourdough bread', quantity: 1, priority: 'medium', categoryId: K['shopping:Grocery'], estimatedPrice: 5.99 }],
    ['Groceries', 'sam', { name: 'Eggs (dozen)', quantity: 1, priority: 'medium', categoryId: K['shopping:Dairy'], estimatedPrice: 3.79 }],
    ['Groceries', 'jordan', { name: 'Baby spinach', quantity: 1, priority: 'low', categoryId: K['shopping:Produce'], estimatedPrice: 3.49 }],
    ['Groceries', 'riley', { name: 'Frozen pizza', quantity: 2, priority: 'low', categoryId: K['shopping:Grocery'], notes: 'The pepperoni one, not the veggie one', estimatedPrice: 6.5 }],
    ['Groceries', 'sam', { name: 'Coffee beans', quantity: 1, priority: 'high', categoryId: K['shopping:Grocery'], notes: 'Medium roast, whole bean', estimatedPrice: 12.99, recurring: true }, true],
    ['Groceries', 'sam', { name: 'Tortillas', quantity: 1, priority: 'medium', categoryId: K['shopping:Grocery'], estimatedPrice: 3.29 }, true],
    ['Hardware store', 'alex', { name: 'Furnace filters 16x25x1 (2-pack)', quantity: 1, priority: 'high', categoryId: K['shopping:Tools & hardware'], estimatedPrice: 24.98 }],
    ['Hardware store', 'jordan', { name: 'WD-40', quantity: 1, priority: 'medium', categoryId: K['shopping:Tools & hardware'], notes: 'For the squeaky closet door', estimatedPrice: 6.98 }],
    ['Hardware store', 'alex', { name: 'LED bulbs, warm white (4-pack)', quantity: 1, priority: 'low', categoryId: K['shopping:Tools & hardware'], estimatedPrice: 9.97 }, true],
    ['Hardware store', 'alex', { name: 'Wall anchors and screws', quantity: 1, priority: 'medium', categoryId: K['shopping:Tools & hardware'], notes: "For Riley's new shelves", estimatedPrice: 7.48 }],
  ];
  st.shopItems = {};
  let n = 0;
  for (const [list, who, body, bought] of items) {
    const it = await at(day(-6 + (n % 5), 9 + n), () => C[who].post('/api/shopping/items', { listId: st.lists[list], ...body }));
    st.shopItems[body.name] = it.id;
    if (bought) await at(day(-2, 17), () => C.sam.post('/api/shopping/items/purchase', { itemId: it.id, purchased: true }));
    n++;
  }
  saveState(st);
  log(`shopping: ${n} items added`);
} else log('shopping exists, skipping');

// ---------------- Inventory ----------------
{
  st.inv = st.inv ?? {};
  delete st.inv['Coffee beans']; delete st.inv['Milk'];
  // [name, unit, startQty, low, reorderDays, category, room, adjustments [dayOffset, delta, who, note]]
  const inv = [
    ['Coffee beans', 'bags', 3, 1, 14, 'Pantry', 'Kitchen', [[-38, -1, 'sam'], [-27, -1, 'alex'], [-20, 2, 'sam', 'Costco run'], [-12, -1, 'sam'], [-4, -1, 'alex']]],
    ['Milk', 'gallons', 2, 1, 5, 'Fridge', 'Kitchen', [[-30, -1, 'sam'], [-28, 2, 'sam'], [-22, -2, 'jordan'], [-21, 2, 'sam'], [-14, -1, 'riley'], [-9, 1, 'sam'], [-3, -2, 'mia']]],
    ['Paper towels', 'rolls', 8, 2, 30, 'Paper goods', 'Kitchen', [[-35, -2, 'sam'], [-21, -2, 'jordan'], [-8, -1, 'sam']]],
    ['Dish soap', 'bottles', 2, 1, 30, 'Cleaning supplies', 'Kitchen', [[-33, -1, 'jordan'], [-6, -0.5, 'jordan', 'Last one is half empty']]],
    ['Laundry detergent', 'loads', 64, 10, 45, 'Cleaning supplies', 'Laundry', [[-37, -8, 'jordan'], [-30, -6, 'sam'], [-23, -8, 'jordan'], [-16, -7, 'jordan'], [-9, -8, 'sam']]],
    ['AA batteries', 'batteries', 16, 4, null, 'Household', 'Entryway', [[-25, -4, 'alex', 'Smoke alarm + remote'], [-10, -2, 'riley', 'Game controller']]],
    ['Toilet paper', 'rolls', 12, 4, 21, 'Paper goods', 'Bathroom', [[-34, -4, 'sam'], [-25, -3, 'alex'], [-18, 12, 'sam', 'Big pack'], [-11, -6, 'sam'], [-4, -8, 'jordan']]],
    ['Trash bags', 'bags', 40, 10, 60, 'Household', 'Kitchen', [[-28, -7, 'riley'], [-14, -6, 'riley']]],
    ['Eggs', 'eggs', 12, 4, 7, 'Fridge', 'Kitchen', [[-20, -6, 'alex', 'Pancake Sunday'], [-18, 12, 'sam'], [-6, -8, 'alex'], [-3, 6, 'sam']]],
    ['Olive oil', 'bottles', 2, 0.5, 60, 'Pantry', 'Kitchen', [[-26, -1, 'alex']]],
    ['Cat food', 'lbs', 12, 3, 28, 'Pantry', 'Laundry', [[-30, -3, 'mia'], [-20, -3, 'mia'], [-10, -2, 'mia']]],
    ['Dishwasher pods', 'pods', 60, 10, 45, 'Cleaning supplies', 'Kitchen', [[-35, -14, 'jordan'], [-21, -12, 'jordan'], [-7, -13, 'riley']]],
    ['Sponges', 'sponges', 6, 2, 30, 'Cleaning supplies', 'Kitchen', [[-24, -2, 'jordan']]],
    ['Light bulbs', 'bulbs', 6, 2, null, 'Household', 'Laundry', [[-15, -1, 'alex', 'Porch light']]],
    ['Hand soap refill', 'bottles', 3, 1, 40, 'Cleaning supplies', 'Bathroom', [[-19, -1, 'sam']]],
  ];
  for (const [name, unit, q, low, reorder, cat, room, adj] of inv) {
    if (st.inv[name]) { log(`  inventory ${name} exists`); continue; }
    const it = await at(day(-42, 10), () => C.alex.post('/api/inventory/items', {
      name, unit, quantity: q, lowThreshold: low, reorderIntervalDays: reorder,
      categoryId: K[`inventory:${cat}`], roomId: R[room],
    }));
    st.inv[name] = it.id;
    let last;
    for (const [off, delta, who, note] of adj) {
      last = await at(day(off, 8 + Math.abs(off % 10)), () => asOrSam(who, '/api/inventory/items/adjust', { itemId: it.id, delta, note: note ?? null }));
    }
    log(`  inventory ${name}: ${adj.length} adjustments, now ${last?.quantity ?? q} ${unit}${last?.isLow ? ' (LOW)' : ''}`);
    saveState(st);
  }
}

// ---------------- Bills ----------------
if (!st.bills) {
  st.bills = {};
  st.billExtra = {};
  const monthly = (dom) => ({ kind: 'monthly', interval: 1, byMonthday: [dom], timezone: TZ });
  // [key, body, firstDue, payments [[paidAtOffset, amount, fee, note, who]], extra]
  const bills = [
    ['mortgage', { name: 'Mortgage - Lakeshore Home Loans', amount: 1842.16, category: 'Housing', autoPay: true, notes: '30-yr fixed. Escrow covers property tax and homeowners insurance.', assignedUserId: U.alex, recurrence: monthly(1) },
      day(-71, 12), [[-72, 1842.16, 0, 'Autopay', 'alex'], [-41, 1842.16, 0, 'Autopay', 'alex'], [-11, 1842.16, 0, 'Autopay', 'alex']], { accountNo: 'LHL-0048 2291 7735' }],
    ['electric', { name: 'Prairie Power & Light', amount: 118.42, category: 'Utilities', autoPay: false, notes: 'Budget billing is off. Summer AC bumps it up.', assignedUserId: U.alex, recurrence: monthly(15) },
      day(-57, 12), [[-58, 142.87, 0, 'Paid online', 'alex'], [-29, 131.05, 2.95, 'Paid by card online (card fee)', 'sam']], { accountNo: '7781-204-3398', invoiceNo: 'PPL-2026-10-55812' }],
    ['water', { name: 'Brookfield City Water & Sewer', amount: 64.3, category: 'Utilities', autoPay: false, notes: 'Bills every month. Pay at brookfield-water.example or by phone.', assignedUserId: U.sam, recurrence: monthly(6) },
      day(-35, 12), [[-36, 58.75, 0, 'Paid by phone', 'sam']], { accountNo: 'BW-118302', invoiceNo: 'W-2026-09-11830' }],
    ['internet', { name: 'Northwind Fiber 500', amount: 70.0, category: 'Internet & phone', autoPay: true, assignedUserId: U.alex, recurrence: monthly(20) },
      day(-52, 12), [[-51, 70, 0, 'Autopay', 'alex'], [-21, 70, 0, 'Autopay', 'alex']], { accountNo: 'NWF-5520-0193' }],
    ['phone', { name: 'Bluebird Mobile - family plan', amount: 96.5, category: 'Internet & phone', autoPay: true, notes: '4 lines. Riley’s line is on the teen plan.', assignedUserId: U.sam, recurrence: monthly(13) },
      day(-59, 12), [[-58, 96.5, 0, 'Autopay', 'sam'], [-28, 96.5, 0, 'Autopay', 'sam']], { accountNo: 'BBM 312-555-0147' }],
    ['car', { name: 'Harborline Auto Insurance', amount: 108.75, category: 'Insurance', autoPay: false, notes: 'Two cars. Policy renews in March.', assignedUserId: U.alex, recurrence: monthly(24) },
      day(-48, 12), [[-48, 108.75, 0, 'Paid online', 'alex'], [-18, 108.75, 0, 'Paid online', 'alex']], { accountNo: 'HAI-PA-77120934', invoiceNo: 'INV-HAI-0926-4471' }],
    ['streaming', { name: 'StreamBox Premium', amount: 17.99, category: 'Subscriptions', autoPay: true, assignedUserId: U.sam, recurrence: monthly(24) },
      day(-48, 12), [[-47, 17.99, 0, 'Autopay', 'sam'], [-17, 17.99, 0, 'Autopay', 'sam']], {}],
    ['plumber', { name: 'Rivera Plumbing - kitchen sink repair', amount: 185.0, category: 'Home repairs', autoPay: false, notes: 'Replaced the P-trap and garbage disposal seal.', assignedUserId: U.alex },
      day(-16, 12), [[-15, 185, 0, 'Paid by check #1043', 'alex']], { invoiceNo: 'RP-20260925-118' }],
  ];
  for (const [key, body, firstDue, pays, extra] of bills) {
    const b = await at(day(-60, 9), () => C.alex.post('/api/bills', { ...body, dueDate: firstDue }));
    st.bills[key] = b.id;
    st.billExtra[b.id] = extra;
    for (const [off, amount, fee, note, who] of pays) {
      await at(day(off, 19), () => C[who].post('/api/bills/pay', { id: b.id, amount, ...(fee ? { fee } : {}), note, paidAt: day(off, 19) }));
    }
    const list = await C.alex.get('/api/bills');
    const now = list.find((x) => x.id === b.id);
    log(`  bill ${key}: ${pays.length} payments, next due ${now?.dueDate?.slice(0, 10)} status ${now?.status}`);
    saveState(st);
  }
} else log('bills exist, skipping');

// ---------------- Calendar ----------------
if (!st.events) {
  st.events = {};
  const all = [U.alex, U.sam, U.jordan, U.riley, U.mia];
  const ev = [
    ['soccer', 'sam', { title: 'Riley - soccer practice', location: 'Brookfield Park, field 3', startAt: day(-12, 17, 30), endAt: day(-12, 19), attendeeIds: [U.riley, U.sam], recurrence: { kind: 'weekly', interval: 1, byWeekday: [2, 4], timezone: TZ }, description: 'Bring shin guards and a full water bottle.' }],
    ['movie', 'sam', { title: 'Family movie night', location: 'Living room', startAt: day(-9, 19, 30), endAt: day(-9, 21, 30), attendeeIds: all, recurrence: { kind: 'weekly', interval: 1, byWeekday: [5], timezone: TZ }, description: 'Whoever picks the movie does not have to make popcorn.' }],
    ['dentist', 'alex', { title: 'Mia - dentist checkup', location: 'Smile Bright Family Dental, 220 Oak Ave', startAt: day(3, 15, 30), endAt: day(3, 16, 15), attendeeIds: [U.mia, U.alex] }],
    ['conference', 'sam', { title: 'Parent-teacher conferences', location: 'Lincoln Middle School', startAt: day(5, 18), endAt: day(5, 19, 30), attendeeIds: [U.alex, U.sam] }],
    ['market', 'sam', { title: 'Farmers market', location: 'Town square', startAt: day(6, 9), endAt: day(6, 11), attendeeIds: [U.sam, U.mia] }],
    ['picture', 'sam', { title: 'School picture day', startAt: day(8, 0), allDay: true, attendeeIds: [U.riley, U.mia], description: 'Riley wants the blue shirt ironed.' }],
    ['bookclub', 'sam', { title: 'Book club', location: 'Pages & Pours Café', startAt: day(9, 19), endAt: day(9, 21), attendeeIds: [U.sam] }],
    ['hvac', 'alex', { title: 'Furnace tune-up (Comfort Air HVAC)', location: 'Home', startAt: day(11, 9), endAt: day(11, 11), attendeeIds: [U.alex], description: 'Technician needs access to the laundry room.' }],
    ['halloween', 'sam', { title: 'Trick-or-treating', location: 'Maple Street loop', startAt: day(20, 17, 30), endAt: day(20, 20), attendeeIds: [U.mia, U.riley, U.sam] }],
    ['dst', 'alex', { title: 'Clocks go back (DST ends)', startAt: day(21, 0), allDay: true, attendeeIds: [] }],
    ['jordanbday', 'jordan', { title: "Jordan's birthday", startAt: day(25, 0), allDay: true, attendeeIds: all, recurrence: { kind: 'monthly', interval: 12, timezone: TZ } }],
    ['thanksgiving', 'alex', { title: "Thanksgiving at Grandma Jo's", location: 'Grandma Jo’s, Cedar Falls', startAt: day(46, 0), endAt: day(47, 0), allDay: true, attendeeIds: all, description: 'We are bringing the pies and the folding chairs.' }],
  ];
  for (const [key, who, body] of ev) {
    const e = await at(day(-14, 20), () => C[who].post('/api/calendar/events', body));
    st.events[key] = e.id; log(`  event ${key}`);
  }
  saveState(st);
} else log('events exist, skipping');

// ---------------- Requests ----------------
if (!st.requests) {
  st.requests = {};
  const r1 = await at(day(-2, 8), () => C.sam.post('/api/requests', { category: 'maintenance', title: 'Upstairs bathroom faucet is dripping', details: 'Hot side drips even when closed tight. Probably the cartridge.', assigneeId: U.alex }));
  st.requests.faucet = r1.id;
  const r2 = await at(day(-5, 19), () => asOrSam('riley', '/api/requests', { category: 'maintenance', title: "Hang the new shelves in Riley's room", details: 'Two floating shelves from the closet. Anchors are on the hardware list.', assigneeId: U.alex }));
  st.requests.shelves = r2.id;
  await at(day(-4, 9), () => C.alex.post('/api/requests/accept', { id: r2.id, dueAt: day(7, 12) }));
  const r3 = await at(day(-10, 18), () => C.sam.post('/api/requests', { category: 'maintenance', title: 'Porch light is out', details: 'Bulb or the sensor, not sure which.', assigneeId: U.jordan }));
  st.requests.porch = r3.id;
  await at(day(-9, 8), () => C.jordan.post('/api/requests/accept', { id: r3.id, dueAt: new Date(Date.now() + 3600e3).toISOString() }));
  await at(day(-8, 20), () => C.jordan.post('/api/requests/complete', { id: r3.id }));
  log('  maintenance requests: open, accepted, completed');
  const m1 = await at(day(-12, 20), () => asOrSam('mia', '/api/requests', { category: 'media', mediaType: 'movie', title: 'The Lighthouse Fox', year: 2024 }));
  await at(day(-11, 9), () => C.alex.post('/api/requests/complete', { id: m1.id }));
  const m2 = await at(day(-6, 21), () => asOrSam('riley', '/api/requests', { category: 'media', mediaType: 'movie', title: 'Robo Rangers: The Big Fix', year: 2026 }));
  const m3 = await at(day(-3, 22), () => C.jordan.post('/api/requests', { category: 'media', mediaType: 'movie', title: 'Starlight Over Juniper', year: 2025 }));
  const m4 = await at(day(-1, 20), () => C.sam.post('/api/requests', { category: 'media', mediaType: 'tv', title: 'Cedar Hollow', year: 2025, season: 2 }));
  Object.assign(st.requests, { lighthouse: m1.id, robo: m2.id, starlight: m3.id, cedar: m4.id });
  log('  media requests: 4 (one added)');
  saveState(st);
} else log('requests exist, skipping');

// ---------------- NFC tags ----------------
if (!st.nfc) {
  st.nfc = {};
  const t1 = await at(day(-30, 18), () => C.alex.post('/api/nfc/tags', { tagId: 'pantry_coffee', label: 'Pantry: coffee beans', itemId: st.inv['Coffee beans'], represents: 'consumable', scanAction: 'notify', shoppingListId: st.lists.Groceries }));
  const t2 = await at(day(-30, 18, 5), () => C.alex.post('/api/nfc/tags', { tagId: 'laundry_detergent', label: 'Laundry shelf: detergent', itemId: st.inv['Laundry detergent'], represents: 'consumable', scanAction: 'open' }));
  const t3 = await at(day(-30, 18, 10), () => C.alex.post('/api/nfc/tags', { tagId: 'room_laundry', label: 'Laundry room door', roomId: R.Laundry, represents: 'location' }));
  Object.assign(st.nfc, { coffee: t1.id, detergent: t2.id, laundry: t3.id });
  log('  nfc tags: 3 registered');
  try {
    await at(day(-1, 9, 40), () => C.jordan.post('/api/nfc/scans', { tagId: 'laundry_detergent', amount: -2, note: 'Two loads of towels' }));
    log('  nfc scan recorded on laundry_detergent');
  } catch (e) { log('  nfc scan failed:', e.message.slice(0, 160)); }
  saveState(st);
} else log('nfc exists, skipping');

// ---------------- Home Assistant ----------------
if (!st.integration) {
  const i = await at(day(-30, 17), () => C.alex.post('/api/integrations', { name: 'Home Assistant (LAN)' }));
  st.integration = { id: i.id ?? i.integration?.id, keys: Object.keys(i) };
  log('  home assistant integration created, response keys:', Object.keys(i).join(','));
  saveState(st);
}
saveState(st);
log(`step 3 done; ${st.windows.length} time windows recorded`);
