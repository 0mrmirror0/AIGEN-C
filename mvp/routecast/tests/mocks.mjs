// RouteCast test mocks — fake Photon / OSRM / Open-Meteo / tiles / CDN.
// Every external host the app talks to is intercepted, so tests are
// deterministic and need no network.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEAFLET_JS = fs.readFileSync(path.join(HERE, 'node_modules/leaflet/dist/leaflet.js'), 'utf8');
const LEAFLET_CSS = fs.readFileSync(path.join(HERE, 'node_modules/leaflet/dist/leaflet.css'), 'utf8');

// ── tiny valid grey PNG tile ─────────────────────────────────────────
function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function greyTile() {
  const w = 256, h = 256;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit greyscale
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    raw[y * (w + 1) + 1 + x] = (x === 0 || y === 0) ? 150 : 205;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TILE = greyTile();

// ── gazetteer ────────────────────────────────────────────────────────
export const PLACES = [
  { name: 'Milano', city: null, state: 'Lombardia', country: 'Italia', lat: 45.4642, lon: 9.19 },
  { name: 'Torino', city: null, state: 'Piemonte', country: 'Italia', lat: 45.0703, lon: 7.6869 },
  { name: 'Como', city: null, state: 'Lombardia', country: 'Italia', lat: 45.808, lon: 9.0852 },
  { name: 'Roma', city: null, state: 'Lazio', country: 'Italia', lat: 41.9028, lon: 12.4964 },
  { name: 'Bologna', city: null, state: 'Emilia-Romagna', country: 'Italia', lat: 44.4949, lon: 11.3426 },
  { name: 'Novara', city: null, state: 'Piemonte', country: 'Italia', lat: 45.4469, lon: 8.622 },
  { name: 'Brunate', city: null, state: 'Lombardia', country: 'Italia', lat: 45.82, lon: 9.096 },
  { name: 'Milan <img src=x onerror=window.__xss=1>', city: 'Ohio', state: 'Ohio', country: 'USA', lat: 41.3, lon: -82.6 },
];

// ── geometry helpers ─────────────────────────────────────────────────
const R = 6371;
export function hav(a, b) {
  const dLat = (b[0] - a[0]) * Math.PI / 180, dLon = (b[1] - a[1]) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
export function encodePolyline(pts, precision = 5) { // pts: [lat,lon]
  const f = 10 ** precision; let out = '', pl = 0, pn = 0;
  const enc = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [la, lo] of pts) { const a = Math.round(la * f), b = Math.round(lo * f); out += enc(a - pl) + enc(b - pn); pl = a; pn = b; }
  return out;
}
function synthRoute(wps, variant) {
  // wps: [[lat,lon],...]; variant 0..2 bends the path sideways a bit
  const pts = [];
  for (let s = 0; s < wps.length - 1; s++) {
    const A = wps[s], B = wps[s + 1], km = hav(A, B);
    const n = Math.max(20, Math.round(km / 0.06)); // ≈ one vertex every 60 m like OSRM full overview
    const amp = [0, 0.09, -0.12, 0.2][variant] * Math.min(1, km / 100);
    for (let i = (s ? 1 : 0); i <= n; i++) {
      const f = i / n, bend = Math.sin(f * Math.PI) * amp, wig = Math.sin(f * 60) * 0.002;
      const dx = B[0] - A[0], dy = B[1] - A[1];
      pts.push([A[0] + dx * f - dy * bend + wig, A[1] + dy * f + dx * bend]);
    }
  }
  return pts;
}

// ── weather model (deterministic) ────────────────────────────────────
// Rain band over Novara's longitude (8.2–8.7°E) until T0+3h, clear afterwards.
// Gusty south of 43.5°N. Everything else dry.
export function wxAt(lat, lon, epochSec, cfg) {
  const rainOver = cfg.rainUntil ?? Infinity;
  const inBand = lon > 8.2 && lon <= 8.7;
  const raining = inBand && epochSec < rainOver;
  const hod = new Date(epochSec * 1000).getUTCHours();
  return {
    temperature_2m: +(9 + 5 * Math.sin((hod - 9) / 24 * 2 * Math.PI) - (lat - 44)).toFixed(1),
    apparent_temperature: +(7 + 5 * Math.sin((hod - 9) / 24 * 2 * Math.PI) - (lat - 44)).toFixed(1),
    precipitation_probability: raining ? 78 : inBand ? 12 : 4,
    precipitation: raining ? 2.4 : 0,
    weathercode: raining ? (cfg.rainCode ?? 63) : (lon < 8.2 ? 3 : 0),
    windspeed_10m: 12, windgusts_10m: lat < 43.5 ? 62 : 24,
  };
}

function pad(n) { return String(n).padStart(2, '0'); }

// ── install on a Playwright context ──────────────────────────────────
export async function installMocks(context, cfg = {}) {
  const log = { photon: [], osrm: [], meteo: [], tiles: 0, bytes: { osrm: 0, meteo: 0 }, meteoLocations: 0, other: [] };
  const lat = ms => new Promise(r => setTimeout(r, ms));
  const L = { photon: 80, osrm: 350, meteo: 140, ...cfg.latency };

  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const h = url.hostname;
    try {
      if (url.protocol === 'file:' || h === 'localhost' || h === '127.0.0.1') return route.continue();
      if (h.includes('cdnjs.cloudflare.com') || h.includes('unpkg.com')) {
        if (cfg.cdnDown && h.includes(cfg.cdnDown)) return route.abort();
        if (url.pathname.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: LEAFLET_CSS });
        if (url.pathname.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: LEAFLET_JS });
        return route.fulfill({ status: 204, body: '' });
      }
      if (h.includes('fonts.googleapis.com')) return route.fulfill({ contentType: 'text/css', body: '' });
      if (h.includes('fonts.gstatic.com')) return route.fulfill({ status: 204, body: '' });
      if (h.includes('tile.openstreetmap.org')) { log.tiles++; return route.fulfill({ contentType: 'image/png', body: TILE }); }

      if (h === 'photon.komoot.io') {
        log.photon.push(url.search);
        await lat(L.photon);
        if (cfg.photonDown) return route.abort();
        const q = (url.searchParams.get('q') || '').toLowerCase().split(',')[0].trim();
        const limit = +(url.searchParams.get('limit') || 15);
        const feats = PLACES.filter(p => p.name.toLowerCase().startsWith(q)).slice(0, limit).map(p => ({
          type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: { name: p.name, city: p.city || undefined, state: p.state, country: p.country, osm_key: 'place', osm_value: 'city' },
        }));
        return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ type: 'FeatureCollection', features: feats }) });
      }

      if (h === 'router.project-osrm.org' || h === 'routing.openstreetmap.de') {
        log.osrm.push(h + decodeURIComponent(url.pathname) + url.search);
        if (cfg.osrmDown === 'all' || (cfg.osrmDown === 'primary' && h === 'router.project-osrm.org')) { await lat(60); return route.abort(); }
        if (cfg.osrmHang && h === 'router.project-osrm.org') { await lat(cfg.osrmHang); return route.abort(); }
        await lat(L.osrm);
        const m = url.pathname.match(/driving\/(.+)$/);
        const wps = decodeURIComponent(m[1]).split(';').map(s => { const [lo, la] = s.split(',').map(Number); return [la, lo]; });
        const fmt = url.searchParams.get('geometries') || 'polyline';
        const steps = url.searchParams.get('steps') === 'true';
        const excl = url.searchParams.get('exclude') === 'toll';
        if (excl) log.osrmExclude = (log.osrmExclude || 0) + 1;
        if (excl && cfg.excludeUnsupported) return route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 'InvalidValue', message: 'Exclude flag combination is not supported.' }) });
        const nAlt = excl ? 1 : url.searchParams.get('alternatives') === 'true' ? (cfg.nAlt || 3) : 1;
        const geom = pts => fmt === 'geojson' ? { type: 'LineString', coordinates: pts.map(([a, b]) => [+b.toFixed(6), +a.toFixed(6)]) } : encodePolyline(pts, fmt === 'polyline6' ? 6 : 5);
        const routes = [];
        for (let k = 0; k < nAlt; k++) {
          const v = excl ? (cfg.allFree ? 0 : 3) : k;
          const pts = synthRoute(wps, v);
          let dist = 0; for (let i = 1; i < pts.length; i++) dist += hav(pts[i - 1], pts[i]);
          const toll = !cfg.allFree && (excl ? !!cfg.excludeIgnored : (v === 0 || !!cfg.allToll)); // main route = toll motorway, alternatives free
          const stepList = [];
          if (steps) {
            const per = Math.max(2, Math.floor(pts.length / 24));
            for (let i = 0; i < pts.length - 1; i += per) {
              const seg = pts.slice(i, i + per + 1);
              const onMw = toll && i > per && i < pts.length - 2 * per;
              stepList.push({
                name: onMw ? '' : (v === 0 ? 'Viale Certosa' : v === 1 ? 'Strada Statale 11 <b>Padana</b>' : v === 3 ? 'Strada Provinciale 11' : 'Via Novara'),
                ref: onMw ? 'A4' : (v === 1 ? 'SS11' : v === 3 ? 'SP11' : undefined),
                distance: 1000, duration: 60, geometry: geom(seg), mode: 'driving',
                maneuver: { type: 'turn', location: [seg[0][1], seg[0][0]] },
                intersections: [{ location: [seg[0][1], seg[0][0]], bearings: [0], entry: [true], ...(onMw ? { classes: ['toll', 'motorway'] } : {}) }],
              });
            }
          }
          routes.push({ geometry: geom(pts), distance: dist * 1000, duration: dist / (v === 0 ? 105 : 75) * 3600, weight: 1,
            legs: [{ summary: toll ? 'A4' : 'SS11', steps: stepList, distance: dist * 1000, duration: 1 }] });
        }
        const body = JSON.stringify({ code: 'Ok', routes, waypoints: [] });
        log.bytes.osrm += body.length;
        return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
      }

      if (h === 'api.open-meteo.com') {
        log.meteo.push(url.search);
        await lat(L.meteo);
        if (cfg.meteoDown) return route.fulfill({ status: 503, body: 'down', headers: { 'access-control-allow-origin': '*' } });
        const lats = url.searchParams.get('latitude').split(',').map(Number);
        const lons = url.searchParams.get('longitude').split(',').map(Number);
        log.meteoLocations += lats.length;
        const vars = url.searchParams.get('hourly').split(',');
        const unix = url.searchParams.get('timeformat') === 'unixtime';
        const tz = url.searchParams.get('timezone') || 'GMT';
        const off = tz === 'auto' ? 3600 : 0; // mock: every location is CET
        let startSec, hours;
        const now = cfg.nowMs ?? Date.now();
        if (url.searchParams.get('start_date')) {
          const sd = url.searchParams.get('start_date'), ed = url.searchParams.get('end_date');
          const s = Date.parse(sd + 'T00:00:00Z'), e = Date.parse(ed + 'T00:00:00Z');
          const today = Math.floor(now / 864e5) * 864e5;
          if (isNaN(s) || isNaN(e) || e < s || s < today - 92 * 864e5 || e > today + 15 * 864e5)
            return route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: true, reason: 'date out of range' }) });
          startSec = s / 1000 - off; hours = (e - s) / 36e5 + 24;
        } else {
          const days = +(url.searchParams.get('forecast_days') || 7);
          startSec = Math.floor((now + off * 1000) / 864e5) * 86400 - off; hours = days * 24;
        }
        const out = lats.map((la, i) => {
          const hourly = { time: [] }; vars.forEach(v => hourly[v] = []);
          for (let k = 0; k < hours; k++) {
            const t = startSec + k * 3600;
            if (unix) hourly.time.push(t);
            else { const d = new Date((t + off) * 1000); hourly.time.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00`); }
            const w = wxAt(la, lons[i], t, cfg);
            vars.forEach(v => hourly[v].push(w[v] ?? null));
          }
          return { latitude: la, longitude: lons[i], utc_offset_seconds: off, timezone: tz === 'auto' ? 'Europe/Rome' : 'GMT', hourly };
        });
        const body = JSON.stringify(out.length === 1 ? out[0] : out);
        log.bytes.meteo += body.length;
        return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
      }
      log.other.push(url.href.slice(0, 120));
      return route.fulfill({ status: 404, body: '' });
    } catch (e) {
      log.other.push('MOCK ERROR ' + e.message + ' @ ' + url.href.slice(0, 100));
      return route.abort();
    }
  });
  return log;
}
