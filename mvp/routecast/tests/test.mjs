// RouteCast regression harness (strict: exits 1 on the first failed suite).
//   npm i playwright-core leaflet@1.9.4
//   CHROME=/path/to/chrome node test.mjs path/to/routecast/index.html
// Every external service is mocked (see mocks.mjs): no network needed.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { installMocks, wxAt } from './mocks.mjs';

const file = path.resolve(process.argv[2] || '../v10/index.html');
const dir = path.dirname(file);
const only = process.argv[3];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
let serverUp = true;
const server = http.createServer((req, res) => {
  if (!serverUp) { req.socket.destroy(); return; }
  let p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (p.endsWith(path.sep) || p === dir) p = path.join(p, 'index.html');
  if (!p.startsWith(dir) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(p));
}).listen(0);
const BASE = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--lang=it-IT'], env: { ...process.env, LANGUAGE: 'it_IT', LANG: 'it_IT.UTF-8' } });
fs.mkdirSync('shots', { recursive: true });

// ── PNG pixel reader (for "is it REALLY visible" checks) ─────────────
function decodePng(buf) {
  let o = 8, w, h, ct; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = (x >= bpp && y) ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, bpp, px };
}
// mean luminance (0-255) of an element's box as actually painted
async function paintedLuma(page, sel) {
  const box = await page.locator(sel).first().boundingBox();
  assert.ok(box && box.width > 4, `${sel} has no box`);
  const img = decodePng(await page.screenshot({ clip: { x: box.x + 2, y: box.y + 2, width: box.width - 4, height: box.height - 4 } }));
  let s = 0; const n = img.w * img.h;
  for (let i = 0; i < n; i++) s += 0.299 * img.px[i * img.bpp] + 0.587 * img.px[i * img.bpp + 1] + 0.114 * img.px[i * img.bpp + 2];
  return s / n;
}

// ── helpers ──────────────────────────────────────────────────────────
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true };
async function open(cfg = {}, opt = {}) {
  const ctx = await browser.newContext({ ...MOBILE, locale: 'it-IT', timezoneId: 'Europe/Rome', serviceWorkers: 'block', ...opt.context });
  const log = await installMocks(ctx, cfg);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
  if (opt.clock) await page.clock.install({ time: opt.clock });
  await page.goto(BASE + (opt.query || ''));
  if (!opt.noBoot) await page.waitForFunction(() => !document.getElementById('go-btn').disabled || document.querySelectorAll('.route-card').length, null, { timeout: 15000 });
  return { ctx, page, log, errors };
}
const txt = async (page, sel) => (await page.innerText(sel)).replace(/\s+/g, ' ').trim();
async function search(page, from = 'Milano', to = 'Torino') {
  await page.fill('#origin', from); await page.fill('#destination', to);
  await page.click('#go-btn');
}
const cardsReady = page => page.waitForFunction(() => document.querySelectorAll('.route-card').length > 0 && !document.querySelector('.rc-loading'), null, { timeout: 20000 });
const detailReady = page => page.waitForFunction(() => { const b = document.querySelector('#alert-banner.visible'); return b && !b.textContent.includes('Carico'); }, null, { timeout: 20000 });
const setSlider = (page, v) => page.evaluate(v => { const s = document.getElementById('dep-slider'); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); }, v);

const suites = [];
const test = (name, fn) => suites.push({ name, fn });

// ── suites ───────────────────────────────────────────────────────────
test('boot: clean start, empty state and form really painted', async () => {
  const { page, errors, ctx } = await open();
  assert.equal(await page.isEnabled('#go-btn'), true);
  assert.ok(await paintedLuma(page, '#empty-state') < 90, 'empty-state hidden behind the map tiles');
  for (const id of ['#dep-date', '#dep-time', '#step-km']) assert.ok(await paintedLuma(page, id) < 90, id + ' not styled (white native control)');
  assert.match(await txt(page, '#attrib'), /OpenStreetMap.*Open-Meteo/);
  assert.deepEqual(errors, []); await ctx.close();
});

test('validation: empty search shows a visible toast', async () => {
  const { page, log, ctx } = await open();
  await page.waitForSelector('.leaflet-tile-loaded'); await page.waitForTimeout(300);
  const before = await paintedLuma(page, '#attrib') , tiles = await paintedLuma(page, '.leaflet-tile-loaded');
  await page.click('#go-btn');
  await page.waitForSelector('#toast.visible');
  assert.match(await txt(page, '#toast'), /Inserisci partenza e destinazione/);
  const box = await page.locator('#toast').boundingBox();
  const img = decodePng(await page.screenshot({ clip: { x: box.x + 6, y: box.y + 6, width: 10, height: 10 } }));
  assert.ok(img.px[0] < 80 && img.px[1] < 60, 'toast not painted on top (covered by map)');
  assert.ok(tiles > 100 && before < 60, 'sanity: tiles light, chrome dark');
  assert.equal(await page.evaluate(() => document.getElementById('origin').classList.contains('bad')), true);
  assert.equal(log.osrm.length, 0); await ctx.close();
});

test('autocomplete: suggestions, no HTML injection, pick, no stuck list', async () => {
  const { page, log, ctx, errors } = await open();
  await page.click('#origin'); await page.keyboard.type('Mil', { delay: 40 });
  await page.waitForSelector('#ac-origin.visible');
  assert.equal(await page.locator('#ac-origin .ac-item').count(), 2);
  assert.equal(await page.evaluate(() => !!window.__xss), false, 'place name executed as HTML');
  assert.equal(await page.locator('#ac-origin img').count(), 0);
  await page.locator('#ac-origin .ac-item').first().click();
  assert.equal(await page.inputValue('#origin'), 'Milano, Lombardia, Italia');
  assert.equal(await page.isVisible('#ac-origin'), false);
  assert.ok(log.photon.every(q => !q.includes('lang=')), 'lang param sent to Photon');
  // type and leave the field before the answer arrives: the list must not pop up later
  await page.click('#destination'); await page.keyboard.type('Tor', { delay: 10 }); await page.click('#dep-time');
  await page.waitForTimeout(700);
  assert.equal(await page.isVisible('#ac-destination'), false, 'suggestion list stuck open after blur');
  // keyboard pick
  await page.fill('#destination', ''); await page.click('#destination'); await page.keyboard.type('Tori', { delay: 40 });
  await page.waitForSelector('#ac-destination.visible');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#destination'), 'Torino, Piemonte, Italia');
  assert.equal(log.osrm.length, 0, 'Enter on a suggestion must not start the search');
  assert.deepEqual(errors, []); await ctx.close();
});

test('search: 3 cards, ONE weather request, compact routing payload, tolls', async () => {
  const { page, log, ctx, errors } = await open();
  await search(page); await cardsReady(page);
  const cards = await page.$$eval('.route-card', els => els.map(e => e.className + ' | ' + e.innerText.replace(/\s+/g, ' ')));
  assert.equal(cards.length, 3);
  assert.equal(log.meteo.length, 1, 'overview must use a single batched weather request');
  assert.match(log.meteo[0], /timeformat=unixtime/); assert.match(log.meteo[0], /start_date=\d{4}-\d\d-\d\d/);
  assert.match(log.osrm[0], /geometries=polyline/);
  assert.equal(log.osrm.length, 2, 'expected exactly: normal request + exclude=toll request');
  assert.ok(log.osrm.every(u => u.startsWith('router.project-osrm.org')), 'mirror must not be called when the primary answers fast');
  assert.match(cards[0], /r-no .*€ TOLLS.*via A4.*Pioggia.*78%/);
  assert.match(cards[1], /NO TOLLS.*via SS11/);
  assert.ok(!cards[1].includes('<b>'));
  assert.equal(await page.locator('.route-card b').count(), 0, 'road name rendered as HTML');
  assert.equal(await page.isVisible('#empty-state'), false);
  assert.match(page.url(), /da=Milano&a=Torino/);
  assert.equal(await page.locator('.pin').count() > 6, true);
  await page.screenshot({ path: 'shots/t-overview.png' });
  assert.deepEqual(errors, []); await ctx.close();
});

test('detail: one request, markers never overlap, live slider without network', async () => {
  const now = Date.now();
  const { page, log, ctx, errors } = await open({ rainUntil: Math.floor(now / 1000) + 3 * 3600 });
  await search(page); await cardsReady(page);
  const m0 = log.meteo.length;
  await page.locator('.route-card').first().click(); await detailReady(page);
  assert.equal(log.meteo.length - m0, 1, 'detail must use a single batched weather request');
  const card = await txt(page, '#detail-card');
  assert.ok(!/Guidabilit/.test(card), 'dead "Guidabilità —/100" stat still shown');
  assert.match(card, /PIOGGIA 78%.*RAFFICHE 24 ?km\/h.*TEMP\. -?\d+/i);
  assert.match(await txt(page, '#alert-banner'), /Pioggia prevista al km \d+ verso le \d\d:\d\d/);
  const boxes = await page.$$eval('.wm-box', els => els.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
  assert.ok(boxes.length >= 3, 'too few markers: ' + boxes.length);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a, b] = [boxes[i], boxes[j]], ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    assert.ok(!(ox > 12 && oy > 12), `markers ${i} and ${j} overlap by ${ox | 0}×${oy | 0}px`);
  }
  // banner / share / stats must not sit on top of each other
  const bb = await page.locator('#alert-banner').boundingBox(), sb = await page.locator('#share-btn').boundingBox();
  assert.ok(bb.x + bb.width <= sb.x, 'alert banner overlaps the share button');
  const tops = await page.$$eval('.dc-stat', els => els.map(e => Math.round(e.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1, 'detail stats wrap onto two lines');
  await page.screenshot({ path: 'shots/t-detail.png' });
  // leave 4 h later: the rain band is over → banner flips, no request
  const m1 = log.meteo.length, dep0 = await txt(page, '#st-dep');
  await setSlider(page, 8); await page.waitForTimeout(250);
  assert.equal(log.meteo.length, m1, 'slider must not hit the network');
  assert.notEqual(await txt(page, '#st-dep'), dep0);
  assert.match(await txt(page, '#alert-banner'), /Nessuna pioggia prevista/);
  assert.match(await txt(page, '#st-pop'), /^(4|12)%$/);
  // zoom in: more markers appear
  const n0 = boxes.length;
  await page.evaluate(() => map.setZoom(map.getZoom() + 2, { animate: false })); await page.waitForTimeout(400);
  assert.ok(await page.locator('.wm-box').count() >= n0, 'declutter did not react to zoom');
  // popup opens with details
  await page.evaluate(() => map.setZoom(map.getZoom() - 2, { animate: false })); await page.waitForTimeout(300);
  await page.locator('.wm-box').first().click({ force: true });
  await page.waitForSelector('.leaflet-popup-content');
  assert.match(await txt(page, '.leaflet-popup-content'), /Km percorso.*Temperatura.*Raffiche/);
  // back
  await page.click('#dc-back'); await page.waitForSelector('#route-sheet.visible');
  assert.equal(await page.locator('.route-card').count(), 3);
  assert.equal(await page.isVisible('#detail-sheet'), false);
  assert.equal(await page.locator('.wm-box').count(), 0);
  // browser back button also works
  await page.locator('.route-card').nth(1).click(); await detailReady(page);
  await page.goBack(); await page.waitForSelector('#route-sheet.visible');
  assert.deepEqual(errors, []); await ctx.close();
});

test('weather lookup is right in any browser time zone', async () => {
  for (const tz of ['Europe/Rome', 'America/New_York', 'Asia/Tokyo']) {
    const { page, ctx } = await open({}, { context: { timezoneId: tz } });
    await search(page); await cardsReady(page);
    await page.locator('.route-card').first().click(); await detailReady(page);
    const got = await page.evaluate(() => ({ dep: baseDepTs, temp: detailMk[0]._row.wx.temp, P: detailSamples[0].P }));
    const hour = Math.round(got.dep / 3600) * 3600;
    const exp = Math.round(wxAt(+got.P[0].toFixed(2), +got.P[1].toFixed(2), hour, {}).temperature_2m);
    assert.equal(got.temp, exp, `wrong forecast hour picked in ${tz}`);
    await ctx.close();
  }
});

test('date/time change re-uses the routes (no new routing call)', async () => {
  const { page, log, ctx, errors } = await open();
  await search(page); await cardsReady(page);
  const o = log.osrm.length, p = log.photon.length, m = log.meteo.length;
  const d = new Date(Date.now() + 3 * 864e5), ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.fill('#dep-date', ds); await page.dispatchEvent('#dep-date', 'change');
  await page.waitForTimeout(700); await cardsReady(page);
  assert.equal(log.osrm.length, o); assert.equal(log.photon.length, p);
  assert.equal(log.meteo.length, m + 1);
  assert.match(log.meteo.at(-1), new RegExp('start_date=' + new Date(new Date(ds + 'T12:00').getTime() - 6 * 36e5).toISOString().slice(0, 4)));
  assert.match(page.url(), new RegExp('data=' + ds));
  assert.deepEqual(errors, []); await ctx.close();
});

test('weather down: never a false "dry", retry works', async () => {
  const cfg = { meteoDown: true };
  const { page, ctx } = await open(cfg);
  await search(page); await cardsReady(page);
  const cards = await page.$$eval('.route-card', els => els.map(e => e.className + ' | ' + e.innerText.replace(/\s+/g, ' ')));
  for (const c of cards) { assert.ok(!/r-yes|Asciutto|0%/.test(c), 'card claims dry weather without data: ' + c); assert.match(c, /Meteo non disponibile/); }
  assert.match(await txt(page, '#toast'), /Meteo non raggiungibile/);
  await page.locator('.route-card').first().click(); await detailReady(page);
  assert.match(await txt(page, '#alert-banner'), /Meteo non raggiungibile.*riprovare/);
  assert.ok(!/Nessuna pioggia/.test(await txt(page, '#alert-banner')));
  cfg.meteoDown = false;
  await page.waitForTimeout(4700); // let the toast go
  await page.locator('#alert-banner .alert').click(); await page.waitForSelector('.wm-box');
  assert.match(await txt(page, '#alert-banner'), /Pioggia prevista/);
  await ctx.close();
});

test('routing: mirror takes over on failure or slowness; clear error if all down', async () => {
  let r = await open({ osrmDown: 'primary' });
  let t = Date.now(); await search(r.page); await cardsReady(r.page);
  assert.ok(Date.now() - t < 2500, 'fallback should start as soon as the primary fails');
  assert.equal(r.log.osrm.filter(u => u.startsWith('routing.openstreetmap.de')).length, 2); await r.ctx.close();

  r = await open({ osrmHang: 20000 });
  t = Date.now(); await search(r.page); await cardsReady(r.page);
  assert.ok(Date.now() - t < 5500, 'a hanging primary must not block the search: ' + (Date.now() - t));
  await r.ctx.close();

  r = await open({ osrmDown: 'all' });
  await search(r.page); await r.page.waitForSelector('#toast.visible');
  assert.match(await txt(r.page, '#toast'), /Calcolo percorso non disponibile/);
  assert.equal(await r.page.isVisible('#loading'), false);
  assert.equal(await r.page.isEnabled('#go-btn'), true);
  assert.equal(await r.page.isVisible('#empty-state'), true);
  await r.ctx.close();
});

test('unknown place: field marked, readable message', async () => {
  const { page, log, ctx } = await open();
  await search(page, 'Milano', 'Xyzzyq'); await page.waitForSelector('#toast.visible');
  assert.match(await txt(page, '#toast'), /Non trovo "Xyzzyq"/);
  assert.equal(await page.evaluate(() => document.getElementById('destination').classList.contains('bad')), true);
  assert.equal(log.osrm.length, 0);
  // geocoder unreachable
  const r = await open({ photonDown: true });
  await search(r.page); await r.page.waitForSelector('#toast.visible');
  assert.match(await txt(r.page, '#toast'), /Ricerca luoghi non raggiungibile/);
  await r.ctx.close(); await ctx.close();
});

test('shared link: auto-search with waypoint; coordinates; swap; remove waypoint', async () => {
  let r = await open({}, { query: '?da=Milano&a=Torino&tappe=Novara&ogni=20' });
  await cardsReady(r.page);
  assert.equal(r.log.osrm[0].match(/driving\/([^?]+)/)[1].split(';').length, 3, 'waypoint not routed');
  assert.equal(await r.page.inputValue('#step-km'), '20');
  assert.equal(await r.page.locator('#wp-container input').count(), 1);
  await r.page.locator('#wp-container .icon-btn').click();
  assert.equal(await r.page.locator('#wp-container input').count(), 0);
  await r.page.click('#swap-btn');
  assert.equal(await r.page.inputValue('#origin'), 'Torino'); assert.equal(await r.page.inputValue('#destination'), 'Milano');
  await r.ctx.close();

  r = await open();
  await search(r.page, '45.4642, 9.19', 'Torino'); await cardsReady(r.page);
  assert.match(r.log.osrm[0], /driving\/9\.190000,45\.464200;/);
  assert.equal(r.log.photon.filter(q => /q=45/.test(q)).length, 0, 'coordinates must not be geocoded');
  await r.ctx.close();
});

test('just after midnight the default date is the LOCAL date', async () => {
  const t = new Date('2026-11-13T00:20:00+01:00');
  const { page, ctx } = await open({ nowMs: t.getTime() }, { clock: t });
  assert.equal(await page.inputValue('#dep-date'), '2026-11-13');
  assert.equal(await page.inputValue('#dep-time'), '00:35');
  await search(page); await cardsReady(page);
  assert.match(await txt(page, '.route-card'), /Pioggia|Asciutto/);
  await ctx.close();
});

test('stale departure time is fixed, far date is refused', async () => {
  const { page, log, ctx } = await open();
  await page.fill('#dep-date', '2026-01-01'); await search(page); await cardsReady(page);
  assert.notEqual(await page.inputValue('#dep-date'), '2026-01-01');
  const far = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
  const o = log.meteo.length;
  await page.fill('#dep-date', far); await page.dispatchEvent('#dep-date', 'change');
  await page.waitForFunction(() => /14 giorni/.test(document.getElementById('toast').textContent));
  assert.equal(log.meteo.length, o); await ctx.close();
});

test('double submit runs one search; new search from detail view works', async () => {
  const { page, log, ctx, errors } = await open();
  await page.fill('#origin', 'Milano'); await page.fill('#destination', 'Torino');
  await page.press('#destination', 'Enter'); await page.press('#destination', 'Enter'); await page.evaluate(() => computeRoute());
  await cardsReady(page);
  assert.equal(log.osrm.length, 2, 'one search = 2 routing calls (normal + no-tolls)');
  await page.locator('.route-card').first().click(); await detailReady(page);
  await search(page, 'Como', 'Bologna'); await page.waitForSelector('#route-sheet.visible'); await cardsReady(page);
  assert.equal(await page.isVisible('#detail-sheet'), false);
  assert.equal(await page.locator('.wm-box').count(), 0);
  assert.equal(await page.evaluate(() => mode), 'overview');
  assert.deepEqual(errors, []); await ctx.close();
});

test('snow showers are snow, not a thunderstorm', async () => {
  const { page, ctx } = await open({ rainCode: 85 });
  await search(page); await cardsReady(page);
  const c = await txt(page, '.route-card');
  assert.match(c, /Neve/); assert.ok(!/Temporal/.test(c), c);
  await page.locator('.route-card').first().click(); await detailReady(page);
  assert.match(await txt(page, '#alert-banner'), /Rovesci di neve previsti/);
  await ctx.close();
});

test('long route at 5 km: 2 chunked requests, fast, decluttered', async () => {
  const { page, log, ctx, errors } = await open();
  await page.selectOption('#step-km', '5');
  await search(page, 'Milano', 'Roma'); await cardsReady(page);
  const m0 = log.meteo.length, t = Date.now();
  await page.locator('.route-card').first().click(); await detailReady(page);
  const ms = Date.now() - t, samples = await page.evaluate(() => detailSamples.length);
  assert.ok(samples > 90, 'samples ' + samples);
  assert.equal(log.meteo.length - m0, Math.ceil(samples / 80) > 1 ? 2 : 1);
  assert.ok(ms < 1500, 'detail took ' + ms + ' ms');
  const shown = await page.locator('.wm-box').count();
  assert.ok(shown >= 4 && shown < 30, 'markers shown: ' + shown);
  assert.match(await txt(page, '#alert-banner'), /Raffiche fino a 62 km\/h/);
  // drag performance: 19 slider positions
  const dt = await page.evaluate(() => { const s = document.getElementById('dep-slider'), t0 = performance.now(); for (let v = +s.min; v <= +s.max; v++) { s.value = v; paintDetail(); } return performance.now() - t0; });
  assert.ok(dt < 400, 'slider repaint too slow: ' + dt.toFixed(0) + ' ms');
  await page.waitForTimeout(900);
  // the card was tapped while the map was still zooming: the whole route must still end up in the free area
  const vis = await page.evaluate(() => { const r = allRoutes[detailIdx], m = document.getElementById('map').getBoundingClientRect(), top = document.getElementById('alert-banner').getBoundingClientRect().bottom - m.top, bottom = document.getElementById('detail-card').getBoundingClientRect().top - m.top; return [r.coords[0], r.coords.at(-1)].map(c => { const p = map.latLngToContainerPoint(c); return p.y > top && p.y < bottom && p.x > 0 && p.x < m.width; }); });
  assert.deepEqual(vis, [true, true], 'route start/end hidden behind banner or detail card');
  await page.screenshot({ path: 'shots/t-long.png' });
  assert.deepEqual(errors, []); await ctx.close();
  console.log(`      (${samples} points, ${shown} markers shown, detail ready in ${ms} ms, 19 repaints in ${dt.toFixed(0)} ms)`);
});

test('CDN fallback: map still loads when cdnjs is blocked; message when both are', async () => {
  let r = await open({ cdnDown: 'cdnjs' });
  assert.equal(await r.page.evaluate(() => typeof L), 'object');
  await search(r.page); await cardsReady(r.page); await r.ctx.close();
  r = await open({ cdnDown: '.' }, { noBoot: true });
  await r.page.waitForFunction(() => /Mappa non caricata/.test(document.getElementById('map').textContent));
  await r.ctx.close();
});

test('layout: small phone and desktop have no overflow', async () => {
  for (const vp of [{ width: 360, height: 640 }, { width: 320, height: 568 }, { width: 1280, height: 800 }]) {
    const { page, ctx } = await open({}, { context: { viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 } });
    await search(page); await cardsReady(page);
    const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, bar: document.getElementById('searchbar').scrollWidth, go: document.getElementById('go-btn').offsetWidth }));
    assert.ok(ov.sw <= ov.iw && ov.bar <= ov.iw, `horizontal overflow at ${vp.width}px`);
    assert.ok(ov.go >= 60, `search button squeezed to ${ov.go}px at ${vp.width}px`);
    await page.locator('.route-card').first().click(); await detailReady(page);
    const tops = await page.$$eval('.dc-stat', els => els.map(e => Math.round(e.getBoundingClientRect().top)));
    assert.equal(new Set(tops).size, 1, `stats wrap at ${vp.width}px`);
    const c = await page.locator('#detail-card').boundingBox();
    assert.ok(c.x >= 0 && c.x + c.width <= vp.width + 0.5, `detail card off-screen at ${vp.width}px`);
    const mapBox = await page.locator('#map').boundingBox();
    if (vp.height > 600) assert.ok(c.y - mapBox.y > 90, `detail card leaves only ${Math.round(c.y - mapBox.y)}px of map at ${vp.width}×${vp.height}`);
    await page.waitForTimeout(700); await page.screenshot({ path: `shots/t-layout-${vp.width}.png` });
    await ctx.close();
  }
});

test('PWA: versions in sync, service worker caches the shell, works offline', async () => {
  const html = fs.readFileSync(file, 'utf8'), sw = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
  const v = html.match(/APP_VERSION='([^']+)'/)[1];
  assert.equal(sw.match(/CACHE = 'routecast-v([^']+)'/)[1], v, 'APP_VERSION and sw.js CACHE out of sync');
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.webmanifest'), 'utf8'));
  for (const i of man.icons) assert.ok(fs.existsSync(path.join(dir, i.src)), 'missing icon ' + i.src);
  const { page, ctx } = await open({}, { context: { serviceWorkers: 'allow' } });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).some(k => k.startsWith('routecast-v')));
  await page.waitForFunction(async v => { const c = await caches.open('routecast-v' + v); return (await c.keys()).length >= 4; }, v);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  serverUp = false; // the site is gone: only the cache can answer
  try {
    await page.reload(); await page.waitForFunction(() => typeof map === 'object' && map && !document.getElementById('go-btn').disabled, null, { timeout: 8000 });
    assert.match(await txt(page, '#attrib'), new RegExp('v' + v.replace('.', '\\.')));
  } finally { serverUp = true; }
  await ctx.close();
});

test('tolls / no tolls: both offered whenever both exist', async () => {
  const cards = page => page.$$eval('.route-card', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
  // every normal proposal is a toll road → the toll-free route replaces the third
  let r = await open({ allToll: true }); await search(r.page); await cardsReady(r.page);
  let c = await cards(r.page);
  assert.equal(c.length, 3); assert.match(c[0], /€ TOLLS/); assert.match(c[1], /€ TOLLS/); assert.match(c[2], /NO TOLLS.*via SP11/);
  await r.page.locator('.route-card').nth(2).click(); await detailReady(r.page);
  assert.match(await txt(r.page, '#detail-card'), /NO TOLLS/);
  await r.ctx.close();
  // only one normal proposal, with tolls → second card is the toll-free one
  r = await open({ allToll: true, nAlt: 1 }); await search(r.page); await cardsReady(r.page);
  c = await cards(r.page);
  assert.equal(c.length, 2, 'must offer at least 2 options'); assert.match(c[0], /€ TOLLS/); assert.match(c[1], /NO TOLLS/);
  await r.ctx.close();
  // server without "exclude": search still works, nothing mislabelled
  r = await open({ allToll: true, excludeUnsupported: true }); await search(r.page); await cardsReady(r.page);
  c = await cards(r.page); assert.equal(c.length, 3); assert.ok(c.every(x => /€ TOLLS/.test(x)));
  assert.equal(await r.page.isVisible('#toast'), false); await r.ctx.close();
  // server that ignores "exclude" and returns a toll road: never shown as "No tolls"
  r = await open({ allToll: true, excludeIgnored: true }); await search(r.page); await cardsReady(r.page);
  c = await cards(r.page); assert.ok(c.every(x => !/NO TOLLS/.test(x)), c.join(' / ')); await r.ctx.close();
  // no toll road on the way: one card, not the same route twice
  r = await open({ allFree: true, nAlt: 1 }); await search(r.page); await cardsReady(r.page);
  c = await cards(r.page); assert.equal(c.length, 1); assert.match(c[0], /NO TOLLS/); await r.ctx.close();
});

test('share: prominent button, link that really reopens the same route', async () => {
  const stubShare = page => page.addInitScript(() => { window.__shared = []; navigator.share = d => { window.__shared.push(d); return Promise.resolve(); }; });
  // 1) button: yellow, labelled, big enough; icon-only (still yellow) in detail, clear of the banner
  let r = await open(); await stubShare(r.page); await r.page.reload(); await r.page.waitForFunction(() => !document.getElementById('go-btn').disabled);
  assert.equal(await r.page.isVisible('#share-btn'), false, 'share must not show before there is a route');
  await search(r.page, 'Milano', 'Torino'); await cardsReady(r.page); await r.page.waitForTimeout(500);
  const box = await r.page.locator('#share-btn').boundingBox();
  assert.ok(box.width >= 110 && box.height >= 40, `share button too small: ${box.width}×${box.height}`);
  assert.match(await txt(r.page, '#share-btn'), /Condividi/);
  const px = decodePng(await r.page.screenshot({ clip: { x: box.x + 4, y: box.y + 4, width: 4, height: 4 } })).px;
  assert.ok(px[0] > 200 && px[1] > 220 && px[2] < 120, 'share button is not painted in the accent yellow: ' + [px[0], px[1], px[2]]);
  await r.page.screenshot({ path: 'shots/t-share-overview.png' });
  // 2) what is handed to the share sheet
  await r.page.click('#share-btn');
  const shared = await r.page.evaluate(() => window.__shared);
  assert.equal(shared.length, 1); assert.deepEqual(Object.keys(shared[0]).sort(), ['title', 'url'], 'extra fields make some apps drop the link');
  const url = shared[0].url;
  assert.ok(url.startsWith(BASE + '?'), url); assert.ok(!/[+ ]/.test(url), 'link contains + or spaces: ' + url);
  assert.equal(url, r.page.url(), 'shared link differs from the address bar');
  const q = new URL(url).searchParams;
  assert.equal(q.get('da'), 'Milano'); assert.equal(q.get('a'), 'Torino'); assert.equal(q.get('pt'), '45.46420,9.19000;45.07030,7.68690');
  const osrmPath = r.log.osrm[0].match(/driving\/([^?]+)/)[1];
  await r.ctx.close();
  // 3) the receiver: fresh browser, place search DOWN → same route anyway
  let b = await open({ photonDown: true }, { query: url.slice(BASE.length) }); await cardsReady(b.page);
  assert.equal(b.log.osrm[0].match(/driving\/([^?]+)/)[1], osrmPath, 'receiver got a different route');
  assert.equal(b.log.photon.length, 0); assert.equal(await b.page.locator('.route-card').count(), 3);
  assert.equal(await b.page.inputValue('#origin'), 'Milano'); await b.ctx.close();
  // 4) "La mia posizione" + a waypoint with spaces/accents
  r = await open({}, { context: { geolocation: { latitude: 45.808, longitude: 9.0852 }, permissions: ['geolocation'] } });
  await stubShare(r.page); await r.page.reload(); await r.page.waitForFunction(() => !document.getElementById('go-btn').disabled);
  await r.page.click('#geo-btn'); await r.page.waitForFunction(() => document.getElementById('origin').value === 'La mia posizione');
  await r.page.click('#add-wp-btn'); await r.page.fill('#wp-container input', 'Novara'); await r.page.fill('#destination', 'Torino');
  await r.page.click('#go-btn'); await cardsReady(r.page); await r.page.click('#share-btn');
  const u2 = (await r.page.evaluate(() => window.__shared))[0].url, q2 = new URL(u2).searchParams;
  assert.equal(q2.get('da'), 'Posizione condivisa'); assert.equal(q2.get('tappe'), 'Novara'); assert.equal(q2.get('pt').split(';').length, 3);
  assert.ok(u2.includes('Posizione%20condivisa'));
  const path2 = r.log.osrm[0].match(/driving\/([^?]+)/)[1]; await r.ctx.close();
  b = await open({}, { query: u2.slice(BASE.length) }); await cardsReady(b.page);   // receiver has NO geolocation
  assert.equal(b.log.osrm[0].match(/driving\/([^?]+)/)[1], path2); assert.equal(await b.page.isVisible('#toast'), false);
  assert.equal(await b.page.locator('#wp-container input').count(), 1); await b.ctx.close();
  // 5) no share sheet (desktop): link goes to the clipboard, green confirmation
  r = await open({}, { context: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, permissions: ['clipboard-read', 'clipboard-write'] } });
  await r.page.evaluate(() => { try { delete Navigator.prototype.share; } catch (e) {} });
  await search(r.page); await cardsReady(r.page); await r.page.click('#share-btn');
  await r.page.waitForFunction(() => /Link copiato/.test(document.getElementById('toast').textContent));
  assert.equal(await r.page.evaluate(() => navigator.clipboard.readText()), r.page.url());
  // edited fields after the search: the stale coordinates must not travel with new names
  await r.page.fill('#destination', 'Roma');
  assert.ok(!(await r.page.evaluate(() => shareUrl())).includes('pt='), 'old coordinates attached to a new destination');
  await r.ctx.close();
  // 6) page opened from a local file: link points to the public address, not "null/…"
  const ctx = await browser.newContext({ ...MOBILE, serviceWorkers: 'block' }); await installMocks(ctx, {});
  const p = await ctx.newPage(); await p.goto('file://' + file); await p.waitForFunction(() => !document.getElementById('go-btn').disabled);
  await search(p); await cardsReady(p);
  const u3 = await p.evaluate(() => shareUrl());
  assert.match(u3, /^https:\/\/aigen-c\.com\/mvp\/routecast\//, u3); await ctx.close();
});

test('portrait only: sideways phone gets the rotate screen, nothing else does', async () => {
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(man.orientation, 'portrait');
  let r = await open({}, { context: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true }, noBoot: true });
  await r.page.waitForSelector('#rotate', { state: 'visible' });
  assert.match(await txt(r.page, '#rotate'), /Ruota il telefono in verticale/i);
  const top = await r.page.evaluate(() => document.elementFromPoint(400, 200).closest('#rotate') !== null);
  assert.ok(top, 'rotate screen does not cover the app');
  await r.page.screenshot({ path: 'shots/t-landscape.png' });
  await r.page.setViewportSize({ width: 390, height: 844 }); await r.page.waitForSelector('#rotate', { state: 'hidden' });
  await search(r.page); await cardsReady(r.page); await r.ctx.close();
  for (const c of [{ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false }, { viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true }]) {
    r = await open({}, { context: c }); assert.equal(await r.page.isVisible('#rotate'), false, 'rotate screen shown at ' + c.viewport.width + '×' + c.viewport.height); await r.ctx.close();
  }
});

// ── runner ───────────────────────────────────────────────────────────
let failed = 0;
for (const s of suites) {
  if (only && !s.name.includes(only)) continue;
  const t = Date.now();
  try { await s.fn(); console.log(`  ok   ${s.name}  (${Date.now() - t} ms)`); }
  catch (e) { failed++; console.log(`  FAIL ${s.name}\n       ${String(e.message).split('\n')[0]}`); if (process.env.TRACE) console.log(e.stack); }
}
await browser.close(); server.close();
console.log(failed ? `\n${failed} suite(s) FAILED` : `\nall ${only ? 'selected ' : ''}suites passed`);
process.exit(failed ? 1 : 0);
