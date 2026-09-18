// Browser smoke test: load the real page and assert what a person would actually see.
//
// This exists because a genuine bug shipped past `deno check`, 23 unit tests and a JS parse check: loadMetrics()
// was hooked into refresh(), boot() never calls refresh(), so every first paint showed offline sample numbers
// while the badge read "Live · Supabase". Nothing in the suite loaded the page, so nothing could have caught it.
// Type checks prove the code compiles. Only a browser proves the app is telling the truth.
//
//   node tests/smoke.mjs [url]        default: the production deployment
import { chromium } from 'playwright';
import { readdirSync, existsSync } from 'node:fs';

const URL = process.argv[2] || 'https://bridgebox-scagscapes.vercel.app/';
const fails = [];
const ok = [];
const check = (name, cond, detail = '') => (cond ? ok : fails).push(`${name}${detail ? ' — ' + detail : ''}`);

// Find a browser rather than assuming one. A sandbox may ship a pinned Chromium under PLAYWRIGHT_BROWSERS_PATH
// whose revision does not match the installed Playwright; a CI runner has none and expects Playwright's own
// download. Hardcoding one path passed locally and failed in CI on the very first run - which is the sort of
// thing this file exists to catch, so it should not be the thing this file gets wrong.
function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;             // let Playwright use the browser it installed
  const cands = [];
  for (const d of readdirSync(root)) {
    cands.push(`${root}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`);
    cands.push(`${root}/${d}/chrome-linux/chrome`);
  }
  return cands.find(existsSync);
}
// Poll until a container's rendered size stops changing, so the assertion is made on the settled DOM rather
// than on whatever happened to exist when a timer expired. The quiet period has to outlast a request in flight:
// at 400ms a section sat "stable" at 842 characters while its fetch was still travelling, and the test happily
// recorded the empty shell. Deterministic where a sleep is a coin flip, but only if the sleep is long enough.
async function settle(page, sel, { quietMs = 1500, maxMs = 12000 } = {}) {
  const t0 = Date.now(); let last = -1, stable = 0;
  while (Date.now() - t0 < maxMs) {
    const len = await page.evaluate(s => document.querySelector(s)?.innerHTML.length ?? -1, sel);
    if (len === last && len > 0) { stable += 120; if (stable >= quietMs) return len; } else { stable = 0; last = len; }
    await page.waitForTimeout(120);
  }
  return last;
}

const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
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
// The same nav id appears twice - sidebar and mobile tab bar - and the tab-bar copy sits outside the viewport,
// so drive the first match directly instead of trying to physically click it.
const secs = [...new Set(await page.$$eval('[data-act="nav"]', bs => bs.map(b => b.dataset.id)))];
for (const id of secs) {
  await page.evaluate(i => document.querySelector(`[data-act="nav"][data-id="${i}"]`).click(), id);
  // Sections fetch their rows after the click and re-render. A fixed timer measured the pre-load snapshot and
  // reported Vendors as an 842-character shell when it actually renders 19,126 characters and 35 providers - the
  // test inventing a bug that was not there, and failing intermittently depending on the network. So wait for the
  // section to stop changing instead of guessing how long it needs.
  await settle(page, '#s-' + id);
  // Assert the contract, not a byte count. An innerHTML length threshold is a proxy that depends on how fast a
  // fetch came back, which made this check flaky and - worse - made it report Vendors as an empty shell when it
  // renders 35 providers. What actually has to be true is: the section is showing, and it has rendered real
  // furniture (a panel) rather than a blank div. Size is reported for information, never asserted on.
  const info = await page.evaluate(sec => {
    const el = document.querySelector('#s-' + sec);
    if (!el) return { on: false, len: 0, panels: 0, rows: 0 };
    return { on: el.classList.contains('on'), len: el.innerHTML.length,
             panels: el.querySelectorAll('.panel, .kpi').length,
             rows: el.querySelectorAll('tbody tr').length };
  }, id);
  check(`section "${id}" renders`, info.on && info.panels > 0,
        `panels=${info.panels} rows=${info.rows} html=${info.len}`);
}

// ---- 4. a drill-down actually opens and carries its evidence ----
await page.evaluate(() => document.querySelector('[data-act="nav"][data-id="overview"]').click());
await page.waitForTimeout(600);
const drill = await page.$('[data-act="kpi.open"]');
if (drill) {
  await page.evaluate(() => document.querySelector('[data-act="kpi.open"]').click());
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
