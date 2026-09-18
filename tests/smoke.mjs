// Browser smoke test: load the real page and assert what a person would actually see.
//
// This exists because a genuine bug shipped past `deno check`, 23 unit tests and a JS parse check: loadMetrics()
// was hooked into refresh(), boot() never calls refresh(), so every first paint showed offline sample numbers
// while the badge read "Live · Supabase". Nothing in the suite loaded the page, so nothing could have caught it.
// Type checks prove the code compiles. Only a browser proves the app is telling the truth.
//
//   node tests/smoke.mjs [url]        default: the production deployment
import { chromium } from 'playwright';

const URL = process.argv[2] || 'https://bridgebox-scagscapes.vercel.app/';
const fails = [];
const ok = [];
const check = (name, cond, detail = '') => (cond ? ok : fails).push(`${name}${detail ? ' — ' + detail : ''}`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e.message)));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(URL + (URL.includes('?') ? '&' : '?') + 'smoke=' + Date.now(), { waitUntil: 'networkidle', timeout: 45000 });
await page.waitForTimeout(2500);

// ---- 1. nothing blew up on the way in ----
check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

// ---- 2. the mode badge and the KPI strip must agree ----
// This is the assertion that would have caught the bug. A page claiming "Live" while rendering the offline
// fallback is worse than a page that is honestly offline.
const badge = (await page.textContent('#modeChip').catch(() => '')) || '';
const isLive = /live/i.test(badge);
const kpis = await page.$$eval('#kpis .kpi', els => els.map(e => ({
  label: e.querySelector('.l')?.textContent?.trim(),
  value: e.querySelector('.v')?.textContent?.trim(),
  sub:   e.querySelector('.d')?.textContent?.trim(),
  drill: e.classList.contains('drill'),
})));
check('KPI strip rendered', kpis.length >= 4, `${kpis.length} tiles`);
if (isLive) {
  const fallback = kpis.filter(k => /sample data/i.test(k.sub || ''));
  check('live mode shows measured numbers, not sample data', fallback.length === 0,
        fallback.map(k => k.label).join(', '));
  check('every live tile is drillable', kpis.every(k => k.drill),
        kpis.filter(k => !k.drill).map(k => k.label).join(', '));
  check('every live tile names its source table', kpis.every(k => /ss_/.test(k.sub || '')),
        kpis.filter(k => !/ss_/.test(k.sub || '')).map(k => k.label).join(', '));
}

// ---- 3. every section renders something ----
const secs = await page.$$eval('[data-act="nav"]', bs => bs.map(b => b.dataset.id));
for (const id of secs) {
  await page.click(`[data-act="nav"][data-id="${id}"]`);
  await page.waitForTimeout(id === 'map' ? 1800 : 700);
  const info = await page.evaluate(sec => {
    const el = document.querySelector('#s-' + sec);
    return { on: !!el && el.classList.contains('on'), len: el ? el.innerHTML.length : 0,
             title: document.querySelector('#secTitle')?.textContent };
  }, id);
  check(`section "${id}" renders`, info.on && info.len > 400, `on=${info.on} html=${info.len}`);
}

// ---- 4. a drill-down actually opens and carries its evidence ----
await page.click('[data-act="nav"][data-id="overview"]');
await page.waitForTimeout(600);
const drill = await page.$('[data-act="kpi.open"]');
if (drill) {
  await drill.click();
  await page.waitForTimeout(1800);
  const d = await page.evaluate(() => {
    const el = document.querySelector('#drawer');
    return { open: el?.classList.contains('on'), text: el?.innerText || '' };
  });
  check('KPI drill-down opens', !!d.open);
  check('drill-down states how it is calculated', /How it is calculated/i.test(d.text));
  check('drill-down names the source of truth', /Source of truth/i.test(d.text));
  check('drill-down lists the contributing records', /Every record behind it/i.test(d.text));
} else check('a KPI tile is drillable', false, 'no [data-act="kpi.open"] found');

await browser.close();

console.log('\nPASS');
for (const o of ok) console.log('  ✓ ' + o);
if (fails.length) {
  console.log('\nFAIL');
  for (const f of fails) console.log('  ✗ ' + f);
  console.log(`\n${ok.length} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log(`\n${ok.length} passed, 0 failed`);
