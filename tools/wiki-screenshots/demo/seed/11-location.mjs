// Step 11: location for the Map, Profile and Settings screenshots. Map places
// (Alex, the head), each member's sharing choice, and phone reports of
// arriving and leaving, all through the API like a real phone. Live checks
// can't start on the demo (no Firebase to reach a phone), so one running
// check and a short log are written straight into the demo database
// (ourhome_demo on the ourhome_demo_mongo container ONLY), like step 9.
// Safe to run again: places are reused by name, the checks are replaced.
// Times are relative to now (presence and checks are about the present).
import { execFileSync } from 'node:child_process';
import { clients, log, loadState, saveState } from './lib.mjs';

const st = loadState();
log('step 11: map places, sharing, presence, live checks');
const C = await clients();

// Real places in Brookfield, Wisconsin, found with the app's own address
// search: "Home" sits on a park so it's nobody's actual house; the store's
// name is made up.
async function find(q) {
  const [hit] = await C.alex.get(`/api/map-places/search?q=${encodeURIComponent(q)}`);
  if (!hit) throw new Error(`no address match for ${q}`);
  log(`  found ${q}: ${hit.lat.toFixed(4)}, ${hit.lng.toFixed(4)}`);
  await new Promise((r) => setTimeout(r, 1100)); // the server allows one search a second
  return hit;
}
const wanted = [
  { name: 'Home', kind: 'home', q: 'Mitchell Park, Brookfield, Wisconsin', radiusM: 150, lists: [] },
  { name: 'Prairie Market', kind: 'store', q: 'Brookfield Square, Brookfield, Wisconsin', radiusM: 250, lists: ['Groceries'] },
  { name: 'School', kind: 'other', q: 'Brookfield East High School, Brookfield, Wisconsin', radiusM: 250, lists: [] },
];
const existing = await C.alex.get('/api/map-places');
st.mapPlaces = {};
for (const w of wanted) {
  const same = existing.find((p) => p.name === w.name);
  if (same) {
    if (same.radiusM !== w.radiusM) {
      await C.alex.post('/api/map-places', { ...same, radiusM: w.radiusM });
      log(`  map place ${w.name}: radius now ${w.radiusM} m`);
    } else log(`  reused map place ${w.name}`);
    continue;
  }
  const at = await find(w.q);
  await C.alex.post('/api/map-places', {
    name: w.name, kind: w.kind, lat: at.lat, lng: at.lng, radiusM: w.radiusM,
    shoppingListIds: w.lists.map((l) => st.lists[l]),
  });
  log(`  map place ${w.name} added`);
}
for (const p of await C.alex.get('/api/map-places')) st.mapPlaces[p.name] = p;
saveState(st);

// Who shares (Mia, the child, doesn't), and who allows live checks.
const consent = { alex: [true, false], sam: [true, true], jordan: [true, true], riley: [true, true], mia: [false, false] };
for (const [k, [sharing, liveChecks]] of Object.entries(consent)) {
  // Off first: that forgets where they were, so a rerun's reports (dated
  // relative to now) aren't ignored as older than what an earlier run left.
  await C[k].call('PATCH', '/api/location/consent', { sharing: 'off' });
  await C[k].call('PATCH', '/api/location/consent', { sharing: sharing ? 'on' : 'off' });
  if (sharing) await C[k].call('PATCH', '/api/location/consent', { liveChecks });
  log(`  ${k}: sharing ${sharing ? 'on' : 'off'}${sharing ? `, live checks ${liveChecks ? 'allowed' : 'off'}` : ''}`);
}

// What their phones reported. Each "at" is earlier than now.
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const P = st.mapPlaces;
const near = (p, dLat, dLng) => ({ lat: p.lat + dLat, lng: p.lng + dLng });
// Each report carries the phone's battery at that moment, as the app sends it.
const reports = [
  ['alex', P.Home, 'enter', 180, near(P.Home, 0, 0), 12, { pct: 52, charging: false }],
  ['sam', P.Home, 'enter', 50, near(P.Home, 0.0004, -0.0003), 15, { pct: 64, charging: false }],
  ['jordan', P['Prairie Market'], 'enter', 12, near(P['Prairie Market'], 0.0005, 0.0004), 20, { pct: 15, charging: false }],
  ['riley', P.School, 'enter', 400, near(P.School, 0, 0), 15, { pct: 88, charging: false }],
  ['riley', P.School, 'exit', 40, near(P.School, 0.0032, 0.0021), 35, { pct: 41, charging: false }],
];
for (const [k, place, transition, minAgo, pt, acc, battery] of reports) {
  await C[k].post('/api/location/presence', { placeId: place.id, transition, at: ago(minAgo), ...pt, accuracyM: acc, battery });
  log(`  ${k} ${transition === 'enter' ? 'arrived at' : 'left'} ${place.name} ${minAgo} min ago, battery ${battery.pct}%`);
}
// Alex's phone has since been put on charge: its hourly reading is newer.
await C.alex.post('/api/location/battery', { pct: 78, charging: true, at: ago(20) });
log('  alex: hourly battery 78%, charging');

// Live checks, written straight into the demo database.
const members = await C.alex.get('/api/members');
const id = (name) => members.find((m) => m.name.startsWith(name)).id;
const householdId = (await C.alex.get('/api/auth/get-session')).user.householdId;
const school = P.School;
const now = Date.now();
const iso = (ms) => ({ $date: new Date(ms).toISOString() });
const checks = [
  // Alex is checking on Riley right now: started 3 minutes ago, 7 to go.
  {
    // Ids in the app's cuid shape, so Stop and the status call accept them.
    _id: 'cdemocheckrunning00000001', householdId, requesterId: id('Alex'), targetId: id('Riley'), intervalSec: 30,
    startedAt: iso(now - 3 * 60_000), endsAt: iso(now + 7 * 60_000),
    lat: school.lat + 0.0041, lng: school.lng + 0.0029, accuracyM: 18,
    fixAt: iso(now - 20_000), answeredAt: iso(now - 2.5 * 60_000),
  },
  // Riley's log: Sam last week (ran its 5 minutes), Alex two days ago (Riley stopped it).
  {
    _id: 'cdemocheckbysam0000000001', householdId, requesterId: id('Sam'), targetId: id('Riley'), intervalSec: 30,
    startedAt: iso(now - 6 * 86_400_000), endsAt: iso(now - 6 * 86_400_000 + 5 * 60_000),
    endedAt: iso(now - 6 * 86_400_000 + 5 * 60_000), answeredAt: iso(now - 6 * 86_400_000 + 20_000),
  },
  {
    _id: 'cdemocheckstopped00000001', householdId, requesterId: id('Alex'), targetId: id('Riley'), intervalSec: 60,
    startedAt: iso(now - 2 * 86_400_000), endsAt: iso(now - 2 * 86_400_000 + 15 * 60_000),
    endedAt: iso(now - 2 * 86_400_000 + 4 * 60_000), endedById: id('Riley'), answeredAt: iso(now - 2 * 86_400_000 + 30_000),
  },
];
const script = `
const docs = EJSON.parse(${JSON.stringify(JSON.stringify(checks))});
const r = db.LocationCheck.deleteMany({ householdId: ${JSON.stringify(householdId)} });
print('removed', r.deletedCount, 'old live checks');
db.LocationCheck.insertMany(docs);
print('inserted', docs.length, 'live checks');
`;
const out = execFileSync('docker', ['exec', 'ourhome_demo_mongo', 'mongosh', 'ourhome_demo', '--quiet', '--eval', script], { encoding: 'utf8' });
console.log(out.trim());

const presence = await C.alex.get('/api/location/presence');
log('  who is where:', presence.map((p) => `${p.name.split(' ')[0]} ${p.place ? 'at ' + p.place.name : 'away'}${p.battery ? ` (${p.battery.pct}%${p.battery.charging ? ', charging' : ''})` : ''}`).join('; '));
const ov = await C.alex.get('/api/location/checks');
log(`  Alex's live checks: ${ov.started.length} running, may check ${ov.checkable.map((m) => m.name.split(' ')[0]).join(', ')}`);
log('step 11 done');
