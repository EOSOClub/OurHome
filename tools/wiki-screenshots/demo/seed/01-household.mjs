// Step 1: setup, members, passwords, profiles, timezone, places, categories.
import { Client, log, loadState, saveState, sleep } from './lib.mjs';

const PW = 'DemoHouse!2026';
const TEMP = 'TempSetup!2026';
const st = loadState();
log('step 1: household + members, system date is', new Date().toISOString());

const anon = new Client('anon');
const status = await anon.get('/api/setup');
log('setup required:', status.setupRequired);
if (status.setupRequired) {
  const r = await anon.post('/api/setup', { householdName: 'Maple House', username: 'alex', email: 'alex@maplehouse.example', password: PW });
  log('setup done:', JSON.stringify(r).slice(0, 200));
}

const alex = new Client('alex');
await alex.signIn('alex', PW);
const me = await alex.get('/api/profile');
log('alex profile keys:', Object.keys(me).join(','));
st.users = st.users ?? {};
st.users.alex = me.id ?? me.user?.id;

const members = [
  { key: 'sam', name: 'Sam Morgan', role: 'manager' },
  { key: 'jordan', name: 'Jordan Lee', role: 'adult' },
  { key: 'riley', name: 'Riley Morgan', role: 'teen' },
  { key: 'mia', name: 'Mia Morgan', role: 'child' },
];
let existing = await alex.get('/api/members');
const list = Array.isArray(existing) ? existing : existing.members ?? [];
log('existing members:', list.map((m) => m.username ?? m.name).join(','));
for (const m of members) {
  const found = list.find((x) => x.username === m.key);
  if (found) { st.users[m.key] = found.id; log(`member ${m.key} exists`); continue; }
  const r = await alex.post('/api/members', { name: m.name, username: m.key, role: m.role, password: TEMP });
  st.users[m.key] = r.id ?? r.user?.id;
  log(`created member ${m.key} (${m.role}) id=${st.users[m.key]}`);
}
saveState(st);

// Each new member changes the temp password (lifts mustChangePassword) and fills a profile.
const profiles = {
  alex: { avatarEmoji: '🌲', profileColor: 'green', bio: 'Keeps the bills paid and the gutters clear. Weekend pancake chef.', birthday: '03-14' },
  sam: { avatarEmoji: '🌻', profileColor: 'amber', bio: 'Runs the calendar and the grocery list. Ask me before buying more mugs.', birthday: '07-22' },
  jordan: { avatarEmoji: '🎸', profileColor: 'blue', bio: 'Housemate in the back room. Night owl, dish duty champion.', birthday: '11-05' },
  riley: { avatarEmoji: '🛹', profileColor: 'violet', bio: 'Grade 10. Will do chores for screen time.', birthday: '01-30' },
  mia: { avatarEmoji: '🦄', profileColor: 'pink', birthday: '09-02' },
};
st.clients = {};
for (const key of ['sam', 'jordan', 'riley', 'mia']) {
  const c = new Client(key);
  try {
    await c.signIn(key, TEMP);
    await c.call('POST', '/api/auth/change-password', { currentPassword: TEMP, newPassword: PW, revokeOtherSessions: false });
    log(`  ${key}: password changed to the demo password`);
  } catch (e) {
    log(`  ${key}: temp sign-in failed (${e.message.slice(0, 80)}), trying demo password`);
    await c.signIn(key, PW);
  }
  const flag = await c.post('/api/profile/clear-password-flag');
  log(`  ${key}: mustChangePassword now ${flag.mustChangePassword}`);
  await c.call('PATCH', '/api/profile', profiles[key]);
  log(`  ${key}: profile set`);
}
await alex.call('PATCH', '/api/profile', { name: 'Alex Morgan', ...profiles.alex });
log('alex profile set');

// Household time zone lives in points settings.
const ps = await alex.post('/api/points/settings', { timezone: 'America/Chicago', weekStartsOn: 0, minutesPerPoint: 5 });
log('points settings:', JSON.stringify(ps).slice(0, 200));

// Floors and rooms.
const places = await alex.get('/api/places');
log('places now:', JSON.stringify(places).slice(0, 200));
st.floors = st.floors ?? {}; st.rooms = st.rooms ?? {};
const layout = { 'Ground floor': ['Kitchen', 'Living room', 'Laundry', 'Entryway'], Upstairs: ['Bathroom', "Alex & Sam's room", "Riley's room"] };
for (const [floor, rooms] of Object.entries(layout)) {
  // Both endpoints answer with the whole { floors, rooms } list, so the new
  // record is found by name.
  if (!st.floors[floor]) {
    const f = await alex.post('/api/places/floors', { name: floor });
    st.floors[floor] = f.floors.find((x) => x.name === floor).id;
    log(`floor ${floor} id=${st.floors[floor]}`);
  }
  for (const room of rooms) {
    if (st.rooms[room]) continue;
    const r = await alex.post('/api/places/rooms', { name: room, floorId: st.floors[floor] });
    st.rooms[room] = r.rooms.find((x) => x.name === room).id;
    log(`  room ${room} id=${st.rooms[room]}`);
  }
  saveState(st);
}

// Categories. Setup already creates some defaults (Cleaning, for one), so
// start from what exists and only add the rest.
st.cats = st.cats ?? {};
for (const c of await alex.get('/api/categories')) st.cats[`${c.kind}:${c.name}`] ??= c.id;
const taskCats = [['Cleaning', '#38bdf8', '🧽'], ['Kitchen', '#f97316', '🍳'], ['Laundry', '#a78bfa', '🧺'], ['Outdoor', '#22c55e', '🌿'], ['Maintenance', '#ef4444', '🔧']];
for (const [name, color, icon] of taskCats) {
  const k = `task:${name}`;
  if (st.cats[k]) continue;
  const c = await alex.post('/api/categories', { name, kind: 'task', color, icon });
  st.cats[k] = c.id; log(`task category ${name}`);
}
const shopCats = [['Produce', '#84cc16'], ['Dairy', '#fde047'], ['Pantry', '#f59e0b'], ['Tools & hardware', '#64748b']];
for (const [name, color] of shopCats) {
  const k = `shopping:${name}`;
  if (st.cats[k]) continue;
  const c = await alex.post('/api/categories', { name, kind: 'shopping', color });
  st.cats[k] = c.id; log(`shopping category ${name}`);
}
const invCats = [['Pantry', '#f59e0b'], ['Fridge', '#38bdf8'], ['Cleaning supplies', '#14b8a6'], ['Paper goods', '#a8a29e'], ['Household', '#8b5cf6']];
for (const [name, color] of invCats) {
  const k = `inventory:${name}`;
  if (st.cats[k]) continue;
  const c = await alex.post('/api/inventory/categories', { name, color });
  st.cats[k] = c.id; log(`inventory category ${name}`);
}
saveState(st);
log('step 1 done');
