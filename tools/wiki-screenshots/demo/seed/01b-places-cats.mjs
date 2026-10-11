// Step 1b: put rooms on floors, then create/reuse categories by name.
import { Client, log, loadState, saveState } from './lib.mjs';
const st = loadState();
log('step 1b: places + categories');
const alex = new Client('alex'); await alex.signIn('alex', 'DemoHouse!2026');
const layout = { 'Ground floor': ['Kitchen', 'Living room', 'Laundry', 'Entryway'], Upstairs: ['Bathroom', "Alex & Sam's room", "Riley's room"] };
let places = await alex.get('/api/places');
st.floors = Object.fromEntries(places.floors.map((f) => [f.name, f.id]));
st.rooms = Object.fromEntries(places.rooms.map((r) => [r.name, r.id]));
for (const [floor, rooms] of Object.entries(layout)) for (const room of rooms) {
  const r = places.rooms.find((x) => x.name === room);
  if (r.floorId === st.floors[floor]) continue;
  await alex.post('/api/places/rooms', { id: r.id, name: room, floorId: st.floors[floor] });
  log(`  ${room} -> ${floor}`);
}
places = await alex.get('/api/places');
log('rooms on floors:', places.rooms.map((r) => `${r.name}:${r.floorId ? 'ok' : 'NONE'}`).join(', '));

const all = await alex.get('/api/categories');
st.cats = {};
for (const c of all) st.cats[`${c.kind}:${c.name}`] = c.id;
const want = {
  task: [['Cleaning', '#38bdf8', '🧽'], ['Kitchen', '#f97316', '🍳'], ['Laundry', '#a78bfa', '🧺'], ['Yard', '#34d399', '🌿'], ['Maintenance', '#ef4444', '🔧'], ['Pets', '#f472b6', '🐾']],
  shopping: [['Grocery', '#a78bfa'], ['Produce', '#84cc16'], ['Dairy', '#facc15'], ['Supplies', '#f87171'], ['Tools & hardware', '#64748b']],
  inventory: [['Pantry', '#fb923c'], ['Fridge', '#38bdf8'], ['Cleaning supplies', '#14b8a6'], ['Paper goods', '#a8a29e'], ['Household', '#8b5cf6']],
};
for (const [kind, rows] of Object.entries(want)) for (const [name, color, icon] of rows) {
  const k = `${kind}:${name}`;
  if (st.cats[k]) {
    await alex.post('/api/categories/update', { id: st.cats[k], color, icon: icon ?? null });
    log(`  updated ${k}`);
  } else {
    const c = await alex.post('/api/categories', { name, kind, color, icon: icon ?? null });
    st.cats[k] = c.id; log(`  created ${k}`);
  }
}
saveState(st);
log('step 1b done; categories:', Object.keys(st.cats).length);
