// Step 12: the supervision list (parental controls) for the Members
// screenshots. Alex (the head) picks who supervises the kids: Alex and Sam
// look after Riley and Mia; Jordan, the roommate, supervises nobody. Then
// Riley's phone checks in like the app does hourly (Mia's never has), for the
// Map's "People you look after" card. Through the API like the head and the
// app would. Safe to run again: it sets the list, the check-in is "now".
import zlib from 'node:zlib';
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
const report = await C.riley.post('/api/phone/usage', {
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

// The server asks for the icons it doesn't have, and the phone sends them.
// Made-up icons (a plain colored tile), so no real app's logo is shown.
const TILE_COLORS = {
  'com.google.android.youtube': [214, 69, 65],
  'com.minecraft.pocket': [92, 160, 72],
  'com.example.chat': [66, 133, 214],
  'com.android.chrome': [230, 180, 50],
};
const icons = (report.missingIcons ?? [])
  .filter((app) => TILE_COLORS[app])
  .map((app) => ({ app, png: tilePng(96, TILE_COLORS[app]).toString('base64') }));
if (icons.length > 0) {
  const { saved } = await C.riley.post('/api/phone/usage/icons', { icons });
  log(`  riley: ${saved} app icon(s) sent`);
} else {
  log('  riley: no app icons wanted');
}
log('done');

/** A [size] px square PNG: a rounded tile of [rgb] on transparent. */
function tilePng(size, [r, g, b]) {
  const radius = size * 0.22;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0, then RGBA
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x - 0.5, x + 0.5 - (size - radius), 0);
      const dy = Math.max(radius - y - 0.5, y + 0.5 - (size - radius), 0);
      const inside = dx * dx + dy * dy <= radius * radius;
      row.set(inside ? [r, g, b, 255] : [0, 0, 0, 0], 1 + x * 4);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
