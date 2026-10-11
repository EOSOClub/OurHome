// Contact sheets of out/*.png for review: labelled thumbnails, 4 per row.
const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core');
const OUT = path.join(__dirname, process.env.DIR || 'out'); const per = Number(process.argv[2] || 16);
(async () => {
  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.png')).sort();
  console.log(`${files.length} screenshots, ${per} per sheet`);
  const browser = await chromium.launch({ channel: 'chrome' }); const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  for (let s = 0; s * per < files.length; s++) {
    const group = files.slice(s * per, (s + 1) * per);
    const cells = group.map(f => `<figure><img src="data:image/png;base64,${fs.readFileSync(path.join(OUT, f)).toString('base64')}"><figcaption>${f}</figcaption></figure>`).join('');
    await page.setContent(`<style>body{margin:0;background:#888;font:13px sans-serif;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px}figure{margin:0;background:#fff;padding:4px}img{width:100%;max-height:300px;object-fit:contain;background:#222}figcaption{padding:2px}</style>${cells}`);
    const file = path.join(__dirname, `${process.env.DIR || 'sheet'}${s + 1}.png`); await page.screenshot({ path: file, fullPage: true }); console.log('wrote', file);
  }
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
