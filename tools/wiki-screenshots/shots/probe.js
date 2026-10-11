// Lists button names on a page (and after clicking one), to write shot definitions against.
//   node probe.js <path> [button to click first]
const { open, go } = require('./lib');
(async () => {
  const [p = '', click] = process.argv.slice(2);
  console.log(`probing /${p}${click ? ` after clicking "${click}"` : ''}`);
  const { browser, page } = await open();
  await go(page, p);
  if (click) { await page.getByRole('button', { name: click }).first().click(); await page.waitForTimeout(800); }
  const names = await page.getByRole('button').evaluateAll(bs => bs.map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean));
  console.log(`${names.length} buttons:`, [...new Set(names)].slice(0, 80).join(' | '));
  const inputs = await page.locator('input,select,textarea').evaluateAll(es => es.map(e => e.id || e.name || e.getAttribute('aria-label') || e.tagName));
  console.log(`${inputs.length} fields:`, inputs.slice(0, 40).join(', '));
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
