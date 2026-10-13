// Step 12: the supervision list (parental controls) for the Members
// screenshots. Alex (the head) picks who supervises the kids: Alex and Sam
// look after Riley and Mia; Jordan, the roommate, supervises nobody. Then
// Riley's phone checks in like the app does hourly (Mia's never has), for the
// Map's "People you look after" card. Through the API like the head and the
// app would. Safe to run again: it sets the list, the check-in is "now".
import { clients, log } from './lib.mjs';

log('step 12: supervision list');
const C = await clients(['alex', 'riley']);

const list = await C.alex.get('/api/supervision');
const byName = (name) => {
  const person = [...list.supervisors, ...list.supervised].find((p) => p.name.startsWith(name));
  if (!person) throw new Error(`no member called ${name}`);
  return person.id;
};
const parents = [byName('Alex'), byName('Sam')];
for (const kid of ['Riley', 'Mia']) {
  await C.alex.post('/api/supervision', { supervisedId: byName(kid), supervisorIds: parents });
  log(`  ${kid}: supervised by Alex and Sam`);
}
await C.riley.post('/api/phone/checkin', {
  installId: 'demo-riley-phone',
  appVersion: '0.1.0',
  deviceName: 'Pixel 7a',
  locationAlways: true,
  notifications: true,
});
log('  riley: phone checked in');

// Alex shares Riley's app usage, and Riley's phone reports today (the phone's
// own date) the way the app does. Apps and times are made up.
await C.alex.post('/api/supervision/usage', { supervisedId: byName('Riley'), share: true });
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
await C.riley.post('/api/phone/checkin', {
  installId: 'demo-riley-phone',
  appVersion: '0.1.0',
  deviceName: 'Pixel 7a',
  locationAlways: true,
  notifications: true,
  usageAccess: true,
});
await C.riley.post('/api/phone/usage', {
  days: [
    {
      day: today,
      totalMinutes: 134,
      apps: [
        { app: 'com.google.android.youtube', label: 'YouTube', minutes: 62 },
        { app: 'com.minecraft.pocket', label: 'Block Builder', minutes: 38 },
        { app: 'com.example.chat', label: 'Messages', minutes: 21 },
        { app: 'com.android.chrome', label: 'Chrome', minutes: 13 },
      ],
    },
  ],
});
log(`  riley: app usage shared, ${today} reported`);
log('done');
