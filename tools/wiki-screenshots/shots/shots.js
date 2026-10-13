// Takes every web-app screenshot for the wiki. Only opens forms/dialogs, never submits.
const fs = require('fs'); const path = require('path');
const { open, go, card } = require('./lib');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
// The Prairie Power & Light bill, by the id the seed saved (changes on every reseed).
const BILL = `bills/${require('../demo/seed/state.json').bills.electric}`;
const only = process.argv.slice(2);

async function clipOf(page, locators, pad = 16) {
  const boxes = [];
  for (const l of locators) {
    await l.scrollIntoViewIfNeeded();
    boxes.push(await l.evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; }));
  }
  const x = Math.max(0, Math.min(...boxes.map(b => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map(b => b.y)) - pad);
  return { x, y, width: Math.max(...boxes.map(b => b.x + b.w)) + pad - x, height: Math.max(...boxes.map(b => b.y + b.h)) + pad - y };
}
// The app's dialog panel. (Plain [role=dialog] also matches hidden ones inside the Next.js dev overlay.)
const dialog = page => page.locator('div.fixed.inset-0[role=dialog] > div.relative').last();
const TALL = { width: 1280, height: 1200 }, NORMAL = { width: 1280, height: 860 };
const btn = (page, name) => page.getByRole('button', { name, exact: true }).first();
async function el(page, name, ...locs) {
  // A sticky top bar would otherwise sit on top of cards further down the page.
  await page.evaluate(() => document.querySelectorAll('body *').forEach(e => { if (getComputedStyle(e).position === 'sticky') e.style.position = 'relative'; }));
  await page.screenshot({ path: path.join(OUT, name), clip: await clipOf(page, locs), fullPage: true }); }
async function view(page, name) { await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(200); await page.screenshot({ path: path.join(OUT, name) }); }
async function openDialog(page, name) { await page.setViewportSize(TALL); await btn(page, name).click(); await dialog(page).waitFor({ state: 'visible', timeout: 10000 }); await page.waitForTimeout(400); }

async function sideBySide(page, files, out) {
  const b64 = f => fs.readFileSync(f).toString('base64');
  const c = await page.context().newPage();
  await c.setViewportSize({ width: 1290 * files.length, height: 880 });
  await c.setContent(`<body style="margin:0;background:#0b1120;display:flex;gap:10px;padding:10px">${files.map(f => `<img src="data:image/png;base64,${b64(f)}">`).join('')}</body>`);
  await c.screenshot({ path: out, fullPage: true }); await c.close();
  files.forEach(f => fs.unlinkSync(f));
}

const shots = {
  'install-setup-wizard-security.png': async p => { await go(p, 'bills', { keepSecurity: true }); await el(p, 'install-setup-wizard-security.png', dialog(p)); },
  'bills-overview.png': async p => { await go(p, 'bills'); await view(p, 'bills-overview.png'); },
  'bill-create-modal.png': async p => { await go(p, 'bills'); await openDialog(p, 'New bill'); await el(p, 'bill-create-modal.png', dialog(p)); },
  'bill-detail-page.png': async p => { await go(p, BILL); await view(p, 'bill-detail-page.png'); },
  'bill-payment-modal.png': async p => { await go(p, BILL); await openDialog(p, 'Record payment'); await el(p, 'bill-payment-modal.png', dialog(p)); },
  'calendar-month-view.png': async p => { await go(p, 'calendar'); await view(p, 'calendar-month-view.png'); },
  'calendar-week-agenda-views.png': async p => {
    await go(p, 'calendar');
    const w = path.join(OUT, '_week.png'), a = path.join(OUT, '_agenda.png');
    await btn(p, 'Week').click(); await p.waitForTimeout(600); await p.screenshot({ path: w });
    await btn(p, 'Agenda').click(); await p.waitForTimeout(600); await p.screenshot({ path: a });
    await sideBySide(p, [w, a], path.join(OUT, 'calendar-week-agenda-views.png'));
  },
  'calendar-event-modal.png': async p => { await go(p, 'calendar'); await openDialog(p, 'New event'); await el(p, 'calendar-event-modal.png', dialog(p)); },
  'settings-overview.png': async p => { await go(p, 'settings'); await view(p, 'settings-overview.png'); },
  'settings-points-timezone.png': async p => { await go(p, 'settings'); await el(p, 'settings-points-timezone.png', card(p, 'Task points')); },
  'settings-categories-card.png': async p => { await go(p, 'settings'); await el(p, 'settings-categories-card.png', card(p, 'Categories')); },
  'settings-integrations-nfc.png': async p => { await go(p, 'settings'); await el(p, 'settings-integrations-nfc.png', card(p, 'Home Assistant connection'), card(p, 'NFC tags')); },
  'rooms-settings-card.png': async p => { await go(p, 'settings'); await el(p, 'rooms-settings-card.png', card(p, 'Rooms & floors')); },
  'room-edit-modal.png': async p => { await go(p, 'settings'); await openDialog(p, 'Edit Kitchen'); await el(p, 'room-edit-modal.png', dialog(p)); },
  'nfc-web-admin-tag-registry.png': async p => { await go(p, 'settings'); await el(p, 'nfc-web-admin-tag-registry.png', card(p, 'NFC tags')); },
  'inventory-overview.png': async p => { await go(p, 'inventory'); await view(p, 'inventory-overview.png'); },
  'inventory-adjusters.png': async p => {
    await go(p, 'inventory');
    const row = btn(p, 'Remove one Dish soap').locator('xpath=ancestor::*[contains(@class,"border")][1]');
    await el(p, 'inventory-adjusters.png', row);
  },
  'inventory-add-item.png': async p => {
    await go(p, 'inventory'); await btn(p, 'More options').click(); await p.waitForTimeout(500);
    const form = p.locator('form').filter({ has: p.getByRole('button', { name: 'Add item', exact: true }) }).first();
    await el(p, 'inventory-add-item.png', form);
  },
  'inventory-shopping-handoff.png': async p => {
    await go(p, 'inventory'); await btn(p, 'Add Dish soap to shopping list').click(); await p.waitForTimeout(800);
    if (await dialog(p).isVisible().catch(() => false)) await el(p, 'inventory-shopping-handoff.png', dialog(p));
    else await view(p, 'inventory-shopping-handoff.png');
  },
  'members-overview.png': async p => { await go(p, 'members'); await view(p, 'members-overview.png'); },
  'members-add-card.png': async p => { await go(p, 'members'); await btn(p, 'New member').click(); await p.waitForTimeout(500); await el(p, 'members-add-card.png', card(p, 'Add a member')); },
  'members-permissions-grid.png': async p => { await go(p, 'members'); await el(p, 'members-permissions-grid.png', card(p, 'Permissions')); },
  // Needs demo/seed/12-supervision.mjs, and push set up (dummy Firebase) for the Ring buttons.
  // Its own page since 2026-10-12 (it was a card on the Map).
  'location-look-after.png': async p => { await go(p, 'look-after'); await view(p, 'location-look-after.png'); },
  // Needs demo/seed/12-supervision.mjs.
  'members-supervision.png': async p => { await go(p, 'members'); await el(p, 'members-supervision.png', card(p, 'Supervision')); },
  'notifications-page-view.png': async p => { await go(p, 'notifications'); await view(p, 'notifications-page-view.png'); },
  'profile-overview.png': async p => { await go(p, 'profile'); await view(p, 'profile-overview.png'); },
  'profile-about-me-card.png': async p => { await go(p, 'profile'); await el(p, 'profile-about-me-card.png', card(p, 'About me')); },
  'profile-edit-security.png': async p => { await go(p, 'profile'); await el(p, 'profile-edit-security.png', card(p, 'Account'), card(p, 'Edit profile'), card(p, 'Change password')); },
  'requests-overview.png': async p => { await go(p, 'requests'); await view(p, 'requests-overview.png'); },
  'request-create-form.png': async p => {
    await go(p, 'requests');
    const sel = card(p, 'New request').locator('select').first();
    const opts = await sel.locator('option').evaluateAll(os => os.map(o => ({ v: o.value, t: o.textContent })));
    console.log('  request types:', opts.map(o => o.t).join(' | '));
    const pick = opts.find(o => /movie|media|tv/i.test(o.t)) || opts.find(o => o.v);
    await sel.selectOption(pick.v); await p.waitForTimeout(500);
    const type = card(p, 'New request').locator('select').nth(1);
    if (await type.count()) {
      const t = await type.locator('option').evaluateAll(os => os.map(o => ({ v: o.value, t: o.textContent })));
      const tv = t.find(o => /tv|show/i.test(o.t)) || t.find(o => o.v);
      if (tv) { await type.selectOption(tv.v); await p.waitForTimeout(500); }
    }
    await el(p, 'request-create-form.png', card(p, 'New request')); },
  'request-media-list.png': async p => { await go(p, 'requests'); await el(p, 'request-media-list.png', p.locator('main section').filter({ has: p.locator('h1,h2,h3', { hasText: 'Media' }) }).last()); },
  'request-maintenance-accept.png': async p => { await go(p, 'requests'); await openDialog(p, 'Accept'); await el(p, 'request-maintenance-accept.png', dialog(p)); },
  'home-dashboard.png': async p => { await p.setViewportSize({ width: 1280, height: 1000 }); await go(p, 'dashboard'); await view(p, 'home-dashboard.png'); },
  'home-account-menu.png': async p => {
    await go(p, 'dashboard'); await btn(p, 'Account menu').click(); await p.waitForTimeout(500);
    const menu = p.locator('[role=menu]').first();
    if (await menu.isVisible().catch(() => false)) await el(p, 'home-account-menu.png', menu);
    else await p.screenshot({ path: path.join(OUT, 'home-account-menu.png'), clip: { x: 760, y: 0, width: 520, height: 640 } });
  },
  'home-phone.png': async p => { await p.setViewportSize({ width: 390, height: 844 }); await go(p, 'dashboard'); await view(p, 'home-phone.png'); },
  'tasks-overview.png': async p => { await go(p, 'tasks'); await view(p, 'tasks-overview.png'); },
  'task-details-checklist.png': async p => {
    await go(p, 'tasks'); await btn(p, '0/5').click(); await p.waitForTimeout(500);
    const taskCard = btn(p, '0/5').locator('xpath=ancestor::div[contains(@class,"bg-card")][1]');
    await taskCard.getByRole('button', { name: 'History' }).click(); await p.waitForTimeout(1200);
    await el(p, 'task-details-checklist.png', taskCard);
  },
  'task-create-form.png': async p => {
    await p.setViewportSize(TALL); await go(p, 'tasks'); await btn(p, 'New task').click(); await p.waitForTimeout(500);
    await p.fill('#title', 'Mow the lawn'); await p.selectOption('#type', { label: 'Recurring' }); await p.waitForTimeout(500);
    await el(p, 'task-create-form.png', p.locator('form').filter({ has: btn(p, 'Add task') }).first());
  },
  'shopping-overview.png': async p => { await p.setViewportSize({ width: 1280, height: 1100 }); await go(p, 'shopping'); await view(p, 'shopping-overview.png'); },
  'shopping-add-options.png': async p => {
    await go(p, 'shopping'); await btn(p, 'More options').click(); await p.waitForTimeout(500);
    await el(p, 'shopping-add-options.png', p.locator('form').filter({ has: p.getByPlaceholder('Add an item…') }).first());
  },
  'rooms-grouped-view.png': async p => {
    await go(p, 'tasks'); await p.selectOption('#f-sort', 'room'); await p.waitForTimeout(600);
    await view(p, 'rooms-grouped-view.png');
  },
  // Location (demo/seed/11-location.mjs first: places, presence, a running live check).
  'location-map-places-card.png': async p => { await go(p, 'settings'); await el(p, 'location-map-places-card.png', card(p, 'Map places')); },
  'location-map-place-dialog.png': async p => {
    await go(p, 'settings'); await openDialog(p, 'Edit Prairie Market'); await tiles(p);
    await el(p, 'location-map-place-dialog.png', dialog(p));
  },
  'location-live-check-limits.png': async p => { await go(p, 'settings'); await el(p, 'location-live-check-limits.png', card(p, 'Live location checks')); },
  // Sam has no check running, so the map fits every place and person.
  'location-map-page.png': { as: 'sam', run: async p => { await go(p, 'map'); await tiles(p); await view(p, 'location-map-page.png'); } },
  // Alex's check on Riley: the map zooms to Riley's live dot.
  'location-live-check.png': async p => { await go(p, 'map'); await tiles(p); await view(p, 'location-live-check.png'); },
  'location-start-check.png': async p => {
    await go(p, 'map'); await openDialog(p, 'Check location'); await el(p, 'location-start-check.png', dialog(p));
  },
  'location-whos-where.png': async p => { await go(p, 'dashboard'); await el(p, 'location-whos-where.png', card(p, 'Who’s where')); },
  // Riley (a teen) is being checked by Alex right now and has two older checks in the log.
  'location-profile-card.png': { as: 'riley', run: async p => { await go(p, 'profile'); await el(p, 'location-profile-card.png', card(p, 'Location')); } },
};

/** Map tiles come from OpenStreetMap: give them time to arrive. */
async function tiles(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2500);
}

(async () => {
  console.log('taking web screenshots into', OUT);
  // Most shots are Alex's; a shot can say { as: 'riley', run } to be someone else's.
  const sessions = {};
  const pageFor = async (user) => (sessions[user] ??= await open(user)).page;
  let ok = 0; const failed = [];
  for (const [name, shot] of Object.entries(shots)) {
    if (only.length && !only.includes(name)) continue;
    const { as = 'alex', run } = typeof shot === 'function' ? { run: shot } : shot;
    try { const page = await pageFor(as); await page.setViewportSize(NORMAL); await run(page); ok++; console.log(`ok   ${name}`); }
    catch (e) { failed.push(name); console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); }
  }
  for (const s of Object.values(sessions)) await s.browser.close();
  console.log(`done: ${ok} ok, ${failed.length} failed${failed.length ? ' (' + failed.join(', ') + ')' : ''}`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
