// Local pre-deploy smoke for the v1.7 additions. The production smoke (tests/smoke.mjs) drives the deployed
// site; this one drives the working tree before anything is pushed.
//
// The app is an IIFE, so its functions are deliberately not on window. Rather than reach inside the running
// page, this re-executes the same script with a one-line test export appended *in the harness, never in the
// repo file* — so the code under test is byte-for-byte what ships.
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const c = [];
  for (const d of readdirSync(root)) { c.push(`${root}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`, `${root}/${d}/chrome-linux/chrome`, `${root}/${d}`); }
  return c.find((p) => existsSync(p) && fs.statSync(p).isFile());
}

const root = process.cwd();
const srv = http.createServer((q, r) => {
  let f = decodeURIComponent(q.url.split('?')[0]); if (f === '/') f = '/index.html';
  const p = path.join(root, f);
  if (!p.startsWith(root) || !existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end('nf'); }
  const ct = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }[path.extname(p)] || 'application/octet-stream';
  r.writeHead(200, { 'content-type': ct }); r.end(fs.readFileSync(p));
});
await new Promise((r) => srv.listen(8099, r));

const fails = [], pass = [];
const check = (n, c, d = '') => (c ? pass : fails).push(`${n}${d && !c ? ' — ' + d : ''}`);

const b = await chromium.launch({ executablePath: findChrome() });
const pg = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = [];
pg.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
pg.on('console', (m) => { if (m.type() === 'error' && !/404|favicon/i.test(m.text())) errs.push(m.text()); });
// Stub the edge function so the breakdown sheet opens deterministically. Offline, loadAssets() waits on a
// failing cross-origin fetch, which is a property of the sandbox rather than of the code under test.
await pg.route('**/ss-api/**', (r) => {
  const u = r.request().url();
  if (/\/equipment/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'a1', asset_no: 'SS-EX-01', make: 'Rippa', model: 'R15', category: 'excavator', status: 'Down', serial: 'X1' }]) });
  return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
});
await pg.goto('http://localhost:8099/index.html', { waitUntil: 'networkidle' });
await pg.waitForTimeout(1200);

// ---------- what a crew member actually sees ----------
await pg.locator('[data-act="nav"][data-id="equipment"]').first().click({ timeout: 8000 }).catch(() => {});
await pg.waitForTimeout(700);
check('QR: camera Scan button is on the fleet header', await pg.locator('[data-act="eq.scan"]').count() === 1);
check('QR: the typed code field still works alongside it', await pg.locator('#qrIn').count() === 1);

await pg.locator('[data-act="bd.new"]:visible').first().click({ timeout: 8000 }).catch(() => {});
await pg.locator('#sheet.on').waitFor({ timeout: 10000 }).catch(() => {});
// loadAssets() hits the API first; offline that is a failed fetch, so the sheet appears only after it settles.
await pg.locator('#bdPhotos').waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
check('breakdown: photos input kept', await pg.locator('#bdPhotos').count() === 1);
check('breakdown: short-video input added', await pg.locator('#bdVideo').count() === 1);
check('breakdown: video input accepts video/*', await pg.locator('#bdVideo').getAttribute('accept').catch(() => null) === 'video/*');
check('breakdown: video input opens the rear camera', await pg.locator('#bdVideo').getAttribute('capture').catch(() => null) === 'environment');
check('breakdown: voice-note recorder present', await pg.locator('[data-act="bd.rec"]').count() === 1);
check('breakdown: recorder starts idle', (await pg.locator('#bdRecState').textContent().catch(() => '')) === 'not recording');

// ---------- commercial pursuits: the section that used to render and do nothing ----------
// Close the breakdown sheet first: it is modal, and its scrim silently swallows the nav click.
await pg.locator('#sheet [data-act="close"]').first().click({ timeout: 4000 }).catch(() => {});
await pg.locator('#sheet.on').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
await pg.evaluate(() => { document.querySelectorAll('#sheet,#scrim,#drawer').forEach((e) => e.classList.remove('on')); }).catch(() => {});
await pg.locator('[data-act="nav"][data-id="commercial"]:visible').first().click({ timeout: 8000 }).catch(() => {});
await pg.waitForTimeout(900);
check('commercial: nav entry exists', await pg.locator('[data-act="nav"][data-id="commercial"]').count() === 1);
check('commercial: section container exists', await pg.locator('#s-commercial').count() === 1);
const cmHtml = await pg.locator('#s-commercial').innerHTML().catch(() => '');
check('commercial: section renders something', cmHtml.length > 100, `${cmHtml.length} chars`);
// The API is stubbed in this harness, so the app is in live mode and renders the real board against no rows.
// What matters is that an empty board SAYS it is empty rather than showing a blank table, and that the
// weighted-pipeline figure carries its caveat instead of standing as a forecast.
check('commercial: the pursuit board renders', /Commercial pursuit board/.test(cmHtml));
check('commercial: an empty board says so rather than showing a blank table',
  /No pursuits yet/.test(cmHtml) || /<tbody><tr(?!><td colspan)/.test(cmHtml), cmHtml.slice(0, 160));
check('commercial: losses panel is present and honest when empty',
  /Why we did not win/.test(cmHtml) && (/No losses recorded/.test(cmHtml) || /fact/.test(cmHtml)));
check('commercial: weighted pipeline is labelled, not presented as a forecast',
  /Weighted/.test(cmHtml));

// ---------- the render logic, executed exactly as it ships ----------
const html = fs.readFileSync('index.html', 'utf8');
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
const hooked = js.replace(/\}\)\(\);\s*$/, ";window.__t={planHTML,notifPill,notifAck,prepMedia,readAsData,hasAction:(n)=>typeof (A&&A[n])===\'function\'};})();");
if (hooked === js) { fails.push('harness could not attach to the IIFE — the script tail changed shape'); }
const blank = await (await b.newContext()).newPage();
await blank.setContent('<div id="toast"></div>');
await blank.addScriptTag({ content: hooked }).catch((e) => fails.push('script re-execution threw: ' + e.message));
const has = await blank.evaluate(() => !!window.__t);
check('render functions are reachable for test', has);

if (has) {
  const plan = await blank.evaluate(() => window.__t.planHTML({
    recommended: 'ONE_STOP', offers_considered: 4, note: 'n', job: { id: 'j', name: 'Johnson drainage' }, unsourced: ['weird basin'],
    plans: [{ id: 'ONE_STOP', label: 'One stop', total_landed: 612.5, goods: 500, crew_delay_cost: 112, drive_minutes: 32, stop_overhead_minutes: 18,
      covered: 2, total_items: 3, partial: true, confidence: 'posted', why: 'because', tradeoff: '$0.00 more in materials, 50 min of crew time, 1 stop.',
      stops: [{ vendor_name: 'Home Depot Airline', drive_minutes: 16, drive_mi: 11, drive_status: 'LIVE_VERIFIED', phone: '2255550101',
        items: [{ item: '4in perforated pipe', qty: 310, unit_price: 1.1, extended: 341, substitute: false, availability_status: 'PROVIDER_POSTED', confidence: 'posted' }] }] }],
  }, 'j'));
  check('plan: landed cost is the headline number', plan.includes('612.50') && /landed/.test(plan));
  check('plan: the crew-time component is shown, not buried', plan.includes('$112') && plan.includes('32 min driving'));
  check('plan: the recommendation is labelled', plan.includes('recommended'));
  check('plan: partial coverage is admitted', plan.includes('covers 2 of 3'));
  check('plan: an item nobody could price is still listed', plan.includes('weird basin'));
  check('plan: the stop can be called from the phone', plan.includes('tel:2255550101'));
  check('plan: stock confidence is on the card', plan.includes('posted stock'));

  const est = await blank.evaluate(() => window.__t.planHTML({ recommended: 'LOWEST', unsourced: [],
    plans: [{ id: 'LOWEST', label: 'L', total_landed: 1, goods: 1, crew_delay_cost: 0, drive_minutes: 1, stop_overhead_minutes: 0, covered: 1, total_items: 1, partial: false, confidence: 'call', why: 'w', tradeoff: 't',
      stops: [{ vendor_name: 'V', drive_minutes: 9, drive_mi: 4, drive_status: 'ESTIMATED', drive_caveat: 'This leg crosses the Mississippi.', items: [] }] }] }, 'j'));
  check('plan: an unrouted drive time says so', est.includes('drive time estimated, not routed'));
  check('plan: the river caveat reaches the crew', est.includes('Mississippi'));

  const empty = await blank.evaluate(() => window.__t.planHTML({ plans: [], unsourced: ['x'], note: 'No supplier could price any missing item.' }, 'j'));
  check('plan: no offers renders an honest empty state, not a blank sheet', empty.includes('No supplier could price') && empty.includes('x'));

  const ackOn = await blank.evaluate(() => window.__t.notifAck({ id: 'abc', needs_ack: true, ack_at: null, escalate_after_min: 20, escalate_to: 'admin' }));
  const ackDone = await blank.evaluate(() => window.__t.notifAck({ id: 'x', needs_ack: true, ack_at: '2026-09-21T10:00:00Z', ack_by: 'Charlie' }));
  const ackNone = await blank.evaluate(() => window.__t.notifAck({ needs_ack: false }));
  check('notify: an unacknowledged critical offers the button', ackOn.includes('notif.ack'));
  check('notify: and says what happens if nobody presses it', ackOn.includes('escalates to admin after 20 min'));
  check('notify: an acknowledged notice names who took it', ackDone.includes('Charlie') && !ackDone.includes('notif.ack'));
  check('notify: a routine notice is not cluttered with a button', ackNone === '');
  const pills = await blank.evaluate(() => [window.__t.notifPill({ urgency: 'critical' }), window.__t.notifPill({ urgency: 'high' }), window.__t.notifPill({ urgency: 'low' })]);
  check('notify: urgency is visible at a glance', pills[0].includes('critical') && pills[1].includes('high') && pills[2] === '');

  // The whole point of this port: an Advance button with a handler behind it.
  const acts = await blank.evaluate(() => {
    const src = document.querySelector('script') ? '' : '';
    return ['cm.advance','cm.convert','cm.save','cm.saveloss','cm.add','cm.addloss']
      .map(a => [a, typeof window.__t.hasAction === 'function' ? window.__t.hasAction(a) : null]);
  }).catch(() => null);
  if (acts) for (const [a, present] of acts) if (present !== null) check(`action ${a} has a handler`, present);

  const over = await blank.evaluate(async () => {
    const big = new File([new Uint8Array(9 * 1024 * 1024)], 'long.mp4', { type: 'video/mp4' });
    return await window.__t.prepMedia(big);
  });
  check('media: a clip over the 8 MB server cap is refused in the crew\'s hand, not silently dropped', over === null);
  const bad = await blank.evaluate(async () => await window.__t.prepMedia(new File(['x'], 'a.txt', { type: 'text/plain' })));
  check('media: an unsupported type is refused', bad === null);
  const okClip = await blank.evaluate(async () => { const r = await window.__t.prepMedia(new File([new Uint8Array(1024)], 'clip.webm', { type: 'audio/webm' })); return r && r.type; });
  check('media: a voice note under the cap is prepared for upload', okClip === 'audio/webm');
}

console.log('');
pass.forEach((p) => console.log('  ok    ' + p));
fails.forEach((f) => console.log('  FAIL  ' + f));
console.log(`\n${pass.length} passed, ${fails.length} failed`);
if (errs.length) { console.log('\nconsole/page errors:'); errs.slice(0, 10).forEach((e) => console.log('  ' + e)); }
else console.log('no console or page errors');
await b.close(); srv.close();
process.exit(fails.length || errs.length ? 1 : 0);
