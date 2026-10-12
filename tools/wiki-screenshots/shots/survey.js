// Survey: sign in as alex, full-page capture of each page, and list its buttons.
const { chromium } = require('playwright-core');
const fs = require('fs'); const path = require('path');
const BASE = 'http://localhost:3100', OUT = path.join(__dirname, 'survey');
fs.mkdirSync(OUT, { recursive: true });
const pages = ['dashboard','tasks','shopping','inventory','bills',`bills/${require('../demo/seed/state.json').bills.electric}`,'calendar','requests','notifications','profile','members','settings','activity','points'];
(async () => {
  console.log('launching chrome', new Date().toLocaleTimeString());
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/login'); await page.fill('#username', 'alex'); await page.fill('#password', 'DemoHouse!2026');
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 60000 }), page.click('button[type=submit]')]);
  console.log('signed in, now at', page.url());
  const report = [];
  for (const p of pages) {
    const t = Date.now();
    await page.goto(`${BASE}/${p}`, { waitUntil: 'networkidle', timeout: 120000 });
    const file = p.replace(/\//g, '_') + '.png';
    await page.screenshot({ path: path.join(OUT, file), fullPage: true });
    const buttons = await page.$$eval('button, [role=tab], a[role=button]', els => [...new Set(els.map(e => (e.getAttribute('aria-label') || e.innerText || '').trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 60));
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    report.push(`## ${p} (height ${h})\n${buttons.join(' | ')}`);
    console.log(`${p}: ${file}, ${buttons.length} buttons, ${Date.now() - t}ms`);
  }
  fs.writeFileSync(path.join(OUT, 'buttons.md'), report.join('\n\n'));
  await browser.close(); console.log('done');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
