// First-run setup page on a blank database. Fills sample values for the picture, never submits.
const path = require('path');
const { chromium } = require('playwright-core');
(async () => {
  console.log('waiting for blank server');
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = 'nextjs-portal{display:none!important}'; document.head.appendChild(s); }));
  const page = await ctx.newPage();
  for (let i = 1; i <= 30; i++) {
    try { const r = await page.goto('http://localhost:3100/setup', { waitUntil: 'networkidle', timeout: 60000 }); if (r && r.ok() && page.url().includes('/setup')) break; console.log(`${new Date().toLocaleTimeString()} not ready (${i}/30), at ${page.url()}`); }
    catch (e) { console.log(`${new Date().toLocaleTimeString()} not up yet (${i}/30)`); }
    await page.waitForTimeout(4000);
  }
  if (!page.url().includes('/setup')) throw new Error('setup page not shown; is the DB really blank? at ' + page.url());
  const inputs = await page.$$eval('input', is => is.map(i => `${i.id || i.name}:${i.type}`));
  console.log('fields:', inputs.join(', '));
  const fill = async (re, v) => { const i = page.locator('input').filter({ has: page.locator('xpath=.') }); for (const h of await page.locator('input').all()) { const id = (await h.getAttribute('id')) || (await h.getAttribute('name')) || ''; if (re.test(id) && (await h.getAttribute('type')) !== 'password') { await h.fill(v); return; } } };
  await fill(/house/i, 'Maple House'); await fill(/^name|display/i, 'Alex Morgan'); await fill(/user/i, 'alex'); await fill(/mail/i, 'alex@maplehouse.example');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'out', 'install-setup-wizard-admin.png'), fullPage: true });
  console.log('ok install-setup-wizard-admin.png'); await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
