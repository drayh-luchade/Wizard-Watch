/* ===== AETHER BEGIN ===== */
/* ---------- AETHER INDEX: an invented "magical charge" built from three REAL atmospheric ingredients ----------
   storm energy (CAPE, J/kg) + downward sunlight (shortwave radiation, W/m²) + airborne pollen — or PM2.5 where
   pollen isn't available (Open-Meteo's pollen comes from CAMS' European model; US cells may come back empty,
   so the third term auto-selects whichever the API actually returns). The weights are made up; the inputs aren't.
   One request per API returns hourly arrays for 72 h, so the field is animated through the next 24 h at no
   extra cost. Cached ~100 min and rate-limit-aware (see the Open-Meteo weighting notes above). */
const AE = { lat0: 23, lat1: 51, lon0: -125, lon1: -65, step: 4, ttlMin: 100, frames: 25, frameMs: 700,
  wCape: 0.45, wSun: 0.30, wAir: 0.25, capeSat: 2500, sunSat: 800, pm25Sat: 50, pollenSat: 150 };
AE.nx = Math.round((AE.lon1 - AE.lon0) / AE.step) + 1; AE.ny = Math.round((AE.lat1 - AE.lat0) / AE.step) + 1;
const AE_PTS = []; for (let j = 0; j < AE.ny; j++) for (let i = 0; i < AE.nx; i++) AE_PTS.push([AE.lat0 + j * AE.step, AE.lon0 + i * AE.step]);
const AE_KEY = 'ww_wx_v1', AE_FAIL = 'ww_fail_wx';
const aePaneEl = map.createPane('aetherPane'); aePaneEl.style.zIndex = 245; aePaneEl.style.pointerEvents = 'none';
const ae = { data: null, frames: [], n: 0, startIdx: 0, t: 0, playing: false, dirty: false, on: true, canvas: null, ctx: null, raf: 0, last: 0 };
const JET = Array.from({ length: 256 }, (_, k) => { const v = k / 255, f = x => Math.max(0, Math.min(1, x));
  return [255 * f(1.5 - Math.abs(4 * v - 3)), 255 * f(1.5 - Math.abs(4 * v - 2)), 255 * f(1.5 - Math.abs(4 * v - 1))]; });
const PLAY_SVG = '<svg viewBox="0 0 12 12"><path d="M3 1.5v9l7-4.5z"/></svg>', PAUSE_SVG = '<svg viewBox="0 0 12 12"><path d="M2.5 1.5h3v9h-3zM6.5 1.5h3v9h-3z"/></svg>';

function aetherIndex(cape, sw, air, mode) {
  const c = Math.min(1, (cape || 0) / AE.capeSat), s = Math.min(1, (sw || 0) / AE.sunSat);
  if (mode === 'none') return 100 * (AE.wCape * c + AE.wSun * s) / (AE.wCape + AE.wSun);   // renormalise when there's no third ingredient
  const a = Math.min(1, (air || 0) / (mode === 'pollen' ? AE.pollenSat : AE.pm25Sat));
  return 100 * (AE.wCape * c + AE.wSun * s + AE.wAir * a);
}
async function aeGetJson(url) { const r = await fetch(url); if (!r.ok) throw new Error('http ' + r.status); const j = await r.json(); return Array.isArray(j) ? j : [j]; }
async function aetherFetch() {
  try { const f = +localStorage.getItem(AE_FAIL); if (f && Date.now() - f < CLIM_COOLDOWN_MS) throw new Error('weather field cooling down'); }
  catch (e) { if (/cooling/.test(e.message)) throw e; }
  const q = `latitude=${AE_PTS.map(p => p[0]).join(',')}&longitude=${AE_PTS.map(p => p[1]).join(',')}&forecast_days=3&timezone=GMT`;
  const [fR, aR] = await Promise.allSettled([
    aeGetJson(`https://api.open-meteo.com/v1/forecast?${q}&hourly=cape,shortwave_radiation`),
    aeGetJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&hourly=pm2_5,alder_pollen,birch_pollen,grass_pollen,ragweed_pollen`)]);
  if (fR.status !== 'fulfilled') { try { localStorage.setItem(AE_FAIL, String(Date.now())); } catch (e) {} throw fR.reason; }
  const fc = fR.value, N = AE_PTS.length;
  if (fc.length !== N) throw new Error(`expected ${N} locations, got ${fc.length}`);
  const start = Date.parse(fc[0].hourly.time[0] + 'Z');
  const rnd = a => a.map(v => (v == null ? 0 : Math.round(v)));
  const cape = fc.map(o => rnd(o.hourly.cape)), sw = fc.map(o => rnd(o.hourly.shortwave_radiation)), H = cape[0].length;
  let mode = 'none', air = fc.map(() => new Array(H).fill(0));
  if (aR.status === 'fulfilled' && aR.value.length === N) {
    const aq = aR.value, off = Math.round((Date.parse(aq[0].hourly.time[0] + 'Z') - start) / 3600000);
    const at = (o, name, h) => { const arr = o.hourly[name], v = arr && arr[h - off]; return v == null ? null : v; };
    let nPollen = 0, nPm = 0;
    const pollen = aq.map(o => Array.from({ length: H }, (_, h) => { let s = null;
      for (const n of ['alder_pollen', 'birch_pollen', 'grass_pollen', 'ragweed_pollen']) { const v = at(o, n, h); if (v != null) s = (s || 0) + v; }
      if (s != null) nPollen++; return s; }));
    const pm = aq.map(o => Array.from({ length: H }, (_, h) => { const v = at(o, 'pm2_5', h); if (v != null) nPm++; return v; }));
    if (nPollen > 0.05 * N * H) { mode = 'pollen'; air = pollen.map(a => a.map(v => (v == null ? 0 : Math.round(v)))); }
    else if (nPm > 0.05 * N * H) { mode = 'pm25'; air = pm.map(a => a.map(v => (v == null ? 0 : Math.round(v * 10) / 10))); }
  }
  try { localStorage.removeItem(AE_FAIL); } catch (e) {}
  return { v: 1, ts: Date.now(), start, mode, cape, sw, air };
}
function aeValid(d) { return !!d && d.v === 1 && typeof d.start === 'number' && Array.isArray(d.cape) && d.cape.length === AE_PTS.length &&
  Array.isArray(d.sw) && Array.isArray(d.air) && !!d.cape[0] && d.cape[0].length >= 48; }
function aeReadCache() { try { const d = JSON.parse(localStorage.getItem(AE_KEY)); return aeValid(d) ? d : null; } catch (e) { return null; } }
function aeWriteCache(d) { try { localStorage.setItem(AE_KEY, JSON.stringify(d)); } catch (e) {} }

// Catmull-Rom bicubic interpolation of the coarse grid: smooth blobs instead of bilinear diamonds.
function aeCr(p0, p1, p2, p3, t) { return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0))); }
function aeBicubic(G, fx, fy) {
  const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, cl = (v, m) => Math.max(0, Math.min(m, v));
  const col = jj => { const row = cl(jj, AE.ny - 1) * AE.nx, g = ii => G[row + cl(ii, AE.nx - 1)]; return aeCr(g(i - 1), g(i), g(i + 1), g(i + 2), tx); };
  return aeCr(col(j - 1), col(j), col(j + 1), col(j + 2), ty);
}
function aetherBuildFrames(data, startIdx, n) {
  const W = 240, y0 = mercY(AE.lat0), y1 = mercY(AE.lat1), H = Math.round(W * (y1 - y0) / ((AE.lon1 - AE.lon0) * Math.PI / 180));   // rows spaced in Mercator, like the density raster
  const frames = [], NP = AE_PTS.length;
  for (let k = 0; k < n; k++) {
    const h = startIdx + k, G = new Float32Array(NP);
    for (let p = 0; p < NP; p++) G[p] = aetherIndex(data.cape[p][h], data.sw[p][h], data.air[p][h], data.mode);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx = cv.getContext('2d'), img = cx.createImageData(W, H);
    for (let py = 0; py < H; py++) {
      const fy = (invMercY(y1 - (py + 0.5) / H * (y1 - y0)) - AE.lat0) / AE.step;
      for (let px = 0; px < W; px++) {
        const v = Math.max(0, Math.min(100, aeBicubic(G, (px + 0.5) / W * (AE.nx - 1), fy))), c = JET[Math.round(v * 2.55)];
        const ex = Math.min(px, W - 1 - px) / (W * 0.12), ey = Math.min(py, H - 1 - py) / (H * 0.16), e = Math.min(1, ex, ey);
        const edge = e * e * (3 - 2 * e), o = (py * W + px) * 4;   // smoothstep fade so the field dissolves at the sampling border instead of ending in a visible box
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
        img.data[o + 3] = Math.round(255 * edge * (0.2 + 0.5 * Math.pow(v / 100, 0.8)));   // calm = faint, surging = vivid
      }
    }
    cx.putImageData(img, 0, 0); frames.push(cv);
  }
  return frames;
}
function aeLabel() {
  if (!ae.data) return;
  const ms = ae.data.start + (ae.startIdx + ae.t) * 3600000;
  document.getElementById('wx-time').textContent = new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric' });
}
function aeDraw() {
  if (!ae.canvas || !ae.frames.length) return;
  const ctx = ae.ctx, w = ae.canvas.width, h = ae.canvas.height;
  ctx.clearRect(0, 0, w, h);
  const nw = map.latLngToContainerPoint([AE.lat1, AE.lon0]), se = map.latLngToContainerPoint([AE.lat0, AE.lon1]);
  const i = Math.min(Math.floor(ae.t), ae.n - 1), f = ae.t - i;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = 1; ctx.drawImage(ae.frames[i], nw.x, nw.y, se.x - nw.x, se.y - nw.y);
  if (f > 0.002 && i + 1 < ae.n) { ctx.globalAlpha = f; ctx.drawImage(ae.frames[i + 1], nw.x, nw.y, se.x - nw.x, se.y - nw.y); }   // crossfade between hours
  ctx.globalAlpha = 1;
}
function aeReset() {
  if (!ae.canvas) return;
  const sz = map.getSize(); ae.canvas.width = sz.x; ae.canvas.height = sz.y;
  L.DomUtil.setPosition(ae.canvas, map.containerPointToLayerPoint([0, 0])); ae.dirty = true;
}
function aeTick(ts) {
  ae.raf = requestAnimationFrame(aeTick);
  if (!ae.on || !ae.frames.length || document.hidden) { ae.last = ts; return; }
  if (ae.playing) {
    ae.t += Math.min((ts - ae.last) / 1000, 0.2) * 1000 / AE.frameMs;
    if (ae.t >= ae.n - 1) ae.t = 0;
    document.getElementById('wx-slider').value = ae.t;
  }
  ae.last = ts;
  if (ae.playing || ae.dirty) { aeDraw(); aeLabel(); ae.dirty = false; }
}
function aeSetPlaying(on) { ae.playing = on; document.getElementById('wx-play').innerHTML = on ? PAUSE_SVG : PLAY_SVG; }
function aetherUse(data) {
  const H = data.cape[0].length, nowIdx = Math.max(0, Math.min(H - 1, Math.floor((Date.now() - data.start) / 3600000)));
  const n = Math.min(AE.frames, H - nowIdx);
  if (n < 2) throw new Error('weather field data has run out');
  ae.data = data; ae.startIdx = nowIdx; ae.n = n; ae.frames = aetherBuildFrames(data, nowIdx, n); ae.t = Math.min(ae.t, n - 1);
  if (!ae.canvas) { ae.canvas = L.DomUtil.create('canvas', 'flow-canvas'); aePaneEl.appendChild(ae.canvas); ae.ctx = ae.canvas.getContext('2d'); aeReset(); }
  document.getElementById('wx-slider').max = String(n - 1);
  const what = { pollen: 'CAPE · sunlight · pollen', pm25: 'CAPE · sunlight · PM2.5', none: 'CAPE · sunlight' }[data.mode];
  document.getElementById('wx-comps').textContent = what;
  const why = { pollen: 'pollen', pm25: 'PM2.5 (no US pollen data returned)', none: 'no air-quality term available' }[data.mode];
  document.getElementById('aether-status').textContent = `live — CAPE + sunlight + ${why}`;
  document.getElementById('wx-card').style.display = ae.on ? 'flex' : 'none';
  ae.dirty = true; aeLabel();
}
async function loadAether(opts = {}) {
  const statusEl = document.getElementById('aether-status');
  try {
    let data = aeReadCache();
    if (!data || Date.now() - data.ts > (opts.maxAgeMin || AE.ttlMin) * 60000) {
      try { data = await aetherFetch(); aeWriteCache(data); }
      catch (e) { if (!data || Date.now() - data.ts > 12 * 3600000) throw e; console.warn('Aether refresh failed; using older data', e); }
    }
    aetherUse(data);
  } catch (e) {
    console.error('Aether load failed', e);
    const why = describeError(e);
    statusEl.textContent = /rate/.test(why) ? 'rate-limited — retrying later' : /reach/.test(why) ? 'unavailable (network)' : 'unavailable right now';
    if (!ae.data) document.getElementById('wx-card').style.display = 'none';
  }
}
function aetherInfoHtml(ll) {   // appended to the click popup so the field has site-specific numbers, not just colour
  if (!ae.on || !ae.data) return '';
  const ir = Math.round((ll.lng - AE.lon0) / AE.step), jr = Math.round((ll.lat - AE.lat0) / AE.step);
  if (ir < 0 || jr < 0 || ir >= AE.nx || jr >= AE.ny) return '';
  const p = jr * AE.nx + ir, h = ae.startIdx + Math.round(ae.t), d = ae.data;
  const idx = aetherIndex(d.cape[p][h], d.sw[p][h], d.air[p][h], d.mode);
  const air = d.mode === 'pollen' ? ` · pollen ${d.air[p][h]} grains/m³` : d.mode === 'pm25' ? ` · PM2.5 ${d.air[p][h]} µg/m³` : '';
  return `<div style="font-size:0.72rem;margin-top:6px;border-top:1px solid rgba(245,242,232,0.2);padding-top:4px"><b>Aether Index ≈ ${Math.round(idx)}</b> · ${document.getElementById('wx-time').textContent}<br>` +
    `storm energy ${d.cape[p][h].toLocaleString()} J/kg · sunlight ${d.sw[p][h]} W/m²${air}<br><i>nearest point of a coarse ${AE.step}° sample grid</i></div>`;
}
const wxCard = document.getElementById('wx-card');
L.DomEvent.disableClickPropagation(wxCard); L.DomEvent.disableScrollPropagation(wxCard);
document.getElementById('wx-play').addEventListener('click', () => { if (!ae.playing && ae.t >= ae.n - 1.01) ae.t = 0; aeSetPlaying(!ae.playing); ae.dirty = true; });
document.getElementById('wx-slider').addEventListener('input', e => { aeSetPlaying(false); ae.t = +e.target.value; ae.dirty = true; });
document.getElementById('toggle-aether').addEventListener('change', e => {
  ae.on = e.target.checked;
  if (ae.canvas) ae.canvas.style.display = ae.on ? '' : 'none';
  wxCard.style.display = ae.on && ae.data ? 'flex' : 'none'; ae.dirty = true;
});
map.on('zoomstart', () => { if (ae.ctx) ae.ctx.clearRect(0, 0, ae.canvas.width, ae.canvas.height); });
map.on('moveend zoomend resize', aeReset);
aeSetPlaying(!(typeof reduceMotion !== 'undefined' && reduceMotion));
ae.raf = requestAnimationFrame(aeTick);
loadAether();
setInterval(() => { if (!document.hidden) loadAether(); }, 30 * 60 * 1000);
/* ===== AETHER END ===== */
