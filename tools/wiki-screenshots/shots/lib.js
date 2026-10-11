// Shared helpers: signed-in context, hide dev overlay, dismiss the security prompt.
const { chromium } = require('playwright-core');
const BASE = 'http://localhost:3100';
const HIDE = 'nextjs-portal{display:none!important}';
async function open(user = 'alex', viewport = { width: 1280, height: 860 }) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(css => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); }); }, HIDE);
  const page = await ctx.newPage();
  await page.goto(BASE + '/login'); await page.fill('#username', user); await page.fill('#password', 'DemoHouse!2026');
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 60000 }), page.click('button[type=submit]')]);
  console.log(`signed in as ${user}`);
  return { browser, ctx, page };
}
async function go(page, p, { keepSecurity = false } = {}) {
  await page.goto(BASE + '/' + p, { waitUntil: 'networkidle', timeout: 120000 });
  if (!keepSecurity) {
    const later = page.getByRole('button', { name: 'Decide later' });
    if (await later.isVisible().catch(() => false)) { await later.click(); await page.waitForTimeout(300); }
  }
  await page.waitForTimeout(400);
}
function card(page, title) {
  return page.locator('div.bg-card.rounded-lg').filter({ has: page.locator('h1,h2,h3,h4', { hasText: title }) }).last();
}
module.exports = { open, go, card, BASE };
