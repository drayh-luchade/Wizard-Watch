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
const ae = { data: null, R: null, K: null, flows: [], vals: null, n: 0, startIdx: 0, t: 0, playing: false, dirty: false, on: true, canvas: null, ctx: null, raf: 0, last: 0 };
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

/* ---------- Hour-to-hour motion ----------
   Crossfading two hourly maps makes a moving storm "pulse" (one blob fades out while a displaced copy fades in) and
   smears the sunrise/sunset edge. Instead each hour is split into two parts:
     R  = storm energy + air term (0..wCape+wAir)  -> carried between hours by estimated MOTION (optical flow)
     K  = cloud transmissivity (observed sunlight / clear-sky sunlight)  -> blended
   and the sunlight itself is computed analytically for any fractional hour from the sun's position, so the day/night
   line glides at its true 15°/hour. Fields live on a 120 x ~72 grid (0.5° per pixel) and are coloured at draw time. */
const AE_W = 120, AE_MINDIM = 8, AE_ALPHA2 = 0.008, AE_RMAX = 8, AE_NORM_R = 8;
const AE_H = Math.round(AE_W * (mercY(AE.lat1) - mercY(AE.lat0)) / ((AE.lon1 - AE.lon0) * Math.PI / 180)), AE_N = AE_W * AE_H;
const AE_RAD = Math.PI / 180;
const AE_LUT = Array.from({ length: 256 }, (_, q) => 0.2 + 0.5 * Math.pow(q / 255, 0.8));   // calm = faint, surging = vivid
const AE_PX = (() => {   // per-pixel geometry, built once
  const sinLat = new Float32Array(AE_N), cosLat = new Float32Array(AE_N), lon = new Float32Array(AE_N), mask = new Float32Array(AE_N);
  const y0 = mercY(AE.lat0), y1 = mercY(AE.lat1), fx = new Float32Array(AE_N), fy = new Float32Array(AE_N);
  for (let py = 0; py < AE_H; py++) {
    const lat = invMercY(y1 - (py + 0.5) / AE_H * (y1 - y0));
    for (let px = 0; px < AE_W; px++) {
      const k = py * AE_W + px, ex = Math.min(px, AE_W - 1 - px) / (AE_W * 0.12), ey = Math.min(py, AE_H - 1 - py) / (AE_H * 0.16), e = Math.min(1, ex, ey);
      sinLat[k] = Math.sin(lat * AE_RAD); cosLat[k] = Math.cos(lat * AE_RAD);
      lon[k] = (AE.lon0 + (px + 0.5) / AE_W * (AE.lon1 - AE.lon0)) * AE_RAD;
      mask[k] = e * e * (3 - 2 * e);   // smoothstep fade so the field dissolves at the sampling border
      fx[k] = (px + 0.5) / AE_W * (AE.nx - 1); fy[k] = (lat - AE.lat0) / AE.step;
    }
  }
  return { sinLat, cosLat, lon, mask, fx, fy };
})();

function aeClear(sinLat, cosLat, lonRad, decl, sunLon) {   // Haurwitz clear-sky global horizontal irradiance, W/m²
  const cz = sinLat * Math.sin(decl) + cosLat * Math.cos(decl) * Math.cos(lonRad - sunLon);
  return cz > 0.01 ? 1098 * cz * Math.exp(-0.059 / cz) : 0;
}
function aeSunField(ms, K, out) {   // sunlight term (0..1) at any instant: clear-sky * cloud transmissivity
  const sp = sunPosition(new Date(ms)), decl = sp.decl, sl = sp.lon * AE_RAD, P = AE_PX;
  for (let k = 0; k < AE_N; k++) out[k] = Math.min(1, K[k] * aeClear(P.sinLat[k], P.cosLat[k], P.lon[k], decl, sl) / AE.sunSat);
}

// Catmull-Rom bicubic interpolation of the coarse grid: smooth blobs instead of bilinear diamonds.
function aeCr(p0, p1, p2, p3, t) { return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0))); }
function aeBicubic(G, fx, fy) {
  const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, cl = (v, m) => Math.max(0, Math.min(m, v));
  const col = jj => { const row = cl(jj, AE.ny - 1) * AE.nx, g = ii => G[row + cl(ii, AE.nx - 1)]; return aeCr(g(i - 1), g(i), g(i + 1), g(i + 2), tx); };
  return aeCr(col(j - 1), col(j), col(j + 1), col(j + 2), ty);
}
function aeUp(G, out) { for (let k = 0; k < AE_N; k++) out[k] = aeBicubic(G, AE_PX.fx[k], AE_PX.fy[k]); return out; }

function aeBuildFields(data, startIdx, n) {   // per hour: R (storm + air) and K (cloud transmissivity) on the fine grid
  const NP = AE_PTS.length, R = [], K = [], sinL = AE_PTS.map(p => Math.sin(p[0] * AE_RAD)), cosL = AE_PTS.map(p => Math.cos(p[0] * AE_RAD)), lonR = AE_PTS.map(p => p[1] * AE_RAD);
  const airW = data.mode === 'none' ? 0 : AE.wAir, airSat = data.mode === 'pollen' ? AE.pollenSat : AE.pm25Sat;
  const kRaw = Array.from({ length: n }, () => new Float32Array(NP).fill(-1));
  const sum = new Float64Array(NP), cnt = new Float64Array(NP);
  for (let k = 0; k < n; k++) {
    const h = startIdx + k, sp = sunPosition(new Date(data.start + h * 3600000 - 1800000));   // Open-Meteo reports the MEAN of the preceding hour
    for (let p = 0; p < NP; p++) {
      const cl = aeClear(sinL[p], cosL[p], lonR[p], sp.decl, sp.lon * AE_RAD);
      if (cl >= 40) { const v = Math.max(0, Math.min(1.15, (data.sw[p][h] || 0) / cl)); kRaw[k][p] = v; sum[p] += v; cnt[p]++; }
    }
  }
  for (let k = 0; k < n; k++) {
    const h = startIdx + k, Gr = new Float32Array(NP), Gk = new Float32Array(NP);
    for (let p = 0; p < NP; p++) {
      Gr[p] = AE.wCape * Math.min(1, (data.cape[p][h] || 0) / AE.capeSat) + airW * Math.min(1, (data.air[p][h] || 0) / airSat);
      Gk[p] = kRaw[k][p] >= 0 ? kRaw[k][p] : (cnt[p] ? sum[p] / cnt[p] : 0.7);   // night/low sun: use this point's typical daytime value
    }
    R.push(aeUp(Gr, new Float32Array(AE_N))); K.push(aeUp(Gk, new Float32Array(AE_N)));
  }
  return { R, K };
}

/* --- Horn–Schunck optical flow, coarse-to-fine --- */
function aeBox(src, w, h, r) {   // separable box blur
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), d = 2 * r + 1;
  for (let y = 0; y < h; y++) { let s = 0; for (let x = -r; x <= r; x++) s += src[y * w + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) { tmp[y * w + x] = s / d; s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)]; } }
  for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / d; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; } }
  return out;
}
function aeNorm(F, w, h) {   // value / local mean: puts weak and strong features on the same footing so the flow follows shape, not strength
  const m = aeBox(aeBox(F, w, h, AE_NORM_R), w, h, AE_NORM_R), o = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) o[k] = F[k] / (m[k] + 0.04);
  return o;
}
function aeSample(F, w, h, x, y) {
  x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y));
  const i = Math.min(w - 2, Math.floor(x)), j = Math.min(h - 2, Math.floor(y)), tx = x - i, ty = y - j, a = j * w + i;
  return (F[a] * (1 - tx) + F[a + 1] * tx) * (1 - ty) + (F[a + w] * (1 - tx) + F[a + w + 1] * tx) * ty;
}
function aeHalf(F, w, h) {
  const w2 = w >> 1, h2 = h >> 1, o = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) { const a = 2 * y * w + 2 * x; o[y * w2 + x] = 0.25 * (F[a] + F[a + 1] + F[a + w] + F[a + w + 1]); }
  return o;
}
function aeRefine(A, B, w, h, u, v, iters, warps) {
  const lim = 0.4 * w, Bw = new Float32Array(w * h), Ix = new Float32Array(w * h), Iy = new Float32Array(w * h), It = new Float32Array(w * h);
  let du = new Float32Array(w * h), dv = new Float32Array(w * h), nu = new Float32Array(w * h), nv = new Float32Array(w * h);
  for (let wp = 0; wp < warps; wp++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = y * w + x; Bw[k] = aeSample(B, w, h, x + u[k], y + v[k]); }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x, xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1), ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
      Ix[k] = 0.25 * (A[y * w + xp] - A[y * w + xm] + Bw[y * w + xp] - Bw[y * w + xm]);
      Iy[k] = 0.25 * (A[yp * w + x] - A[ym * w + x] + Bw[yp * w + x] - Bw[ym * w + x]);
      It[k] = Bw[k] - A[k];
    }
    du.fill(0); dv.fill(0);
    for (let it = 0; it < iters; it++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = y * w + x, xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1), ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
        const ub = 0.25 * (du[y * w + xm] + du[y * w + xp] + du[ym * w + x] + du[yp * w + x]);
        const vb = 0.25 * (dv[y * w + xm] + dv[y * w + xp] + dv[ym * w + x] + dv[yp * w + x]);
        const p = (Ix[k] * ub + Iy[k] * vb + It[k]) / (AE_ALPHA2 + Ix[k] * Ix[k] + Iy[k] * Iy[k]);
        nu[k] = ub - Ix[k] * p; nv[k] = vb - Iy[k] * p;
      }
      [du, nu] = [nu, du]; [dv, nv] = [nv, dv];
    }
    for (let k = 0; k < w * h; k++) { u[k] = Math.max(-lim, Math.min(lim, u[k] + du[k])); v[k] = Math.max(-lim, Math.min(lim, v[k] + dv[k])); }
  }
}
function aeFlow(F0, F1) {   // returns {u,v}: where each pixel of F0 moves to by F1, in pixels, at full resolution
  const A = [aeNorm(F0, AE_W, AE_H)], B = [aeNorm(F1, AE_W, AE_H)], dims = [[AE_W, AE_H]];
  while (Math.min(dims[dims.length - 1][0], dims[dims.length - 1][1]) >> 1 >= AE_MINDIM) {
    const [w, h] = dims[dims.length - 1]; A.push(aeHalf(A[A.length - 1], w, h)); B.push(aeHalf(B[B.length - 1], w, h)); dims.push([w >> 1, h >> 1]);
  }
  let u = null, v = null;
  for (let L = dims.length - 1; L >= 0; L--) {
    const [w, h] = dims[L], nu = new Float32Array(w * h), nv = new Float32Array(w * h);
    if (u) { const [cw, ch] = dims[L + 1];   // upsample coarser flow, scale vectors with the grid
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = y * w + x, sx = (x + 0.5) / 2 - 0.5, sy = (y + 0.5) / 2 - 0.5;
        nu[k] = 2 * aeSample(u, cw, ch, sx, sy); nv[k] = 2 * aeSample(v, cw, ch, sx, sy); } }
    aeRefine(A[L], B[L], w, h, nu, nv, L === 0 ? 25 : 45, 2);
    u = nu; v = nv;
  }
  // confidence: where the warped hour still doesn't match, trust the plain blend instead
  const W = AE_W, H = AE_H, res = new Float32Array(AE_N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = y * W + x; res[k] = Math.abs(aeSample(B[0], W, H, x + u[k], y + v[k]) - A[0][k]); }
  const err = aeBox(res, W, H, 1);
  for (let k = 0; k < AE_N; k++) {
    const c = 1 / (1 + Math.pow(err[k] / 0.12, 2)); u[k] *= c; v[k] *= c;
    const m = Math.hypot(u[k], v[k]); if (m > AE_RMAX) { u[k] *= AE_RMAX / m; v[k] *= AE_RMAX / m; }
  }
  return { u, v };
}
function aeFlowFor(i) { return ae.flows[i] || (ae.flows[i] = aeFlow(ae.R[i], ae.R[i + 1])); }
function aeWarpBlend(F0, F1, fl, tau, out) {   // advect hour i forward by tau, pull hour i+1 back by (1-tau), blend
  const W = AE_W, H = AE_H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x, u = fl.u[k], v = fl.v[k];
    out[k] = (1 - tau) * aeSample(F0, W, H, x - tau * u, y - tau * v) + tau * aeSample(F1, W, H, x + (1 - tau) * u, y + (1 - tau) * v);
  }
}
function aeInterpAt(i, tau, out) {   // Aether Index (0..100) at hour i + tau
  const a = 1 - tau;
  aeWarpBlend(ae.R[i], ae.R[i + 1], aeFlowFor(i), tau, ae.tmpR);
  for (let k = 0; k < AE_N; k++) ae.tmpK[k] = a * ae.K[i][k] + tau * ae.K[i + 1][k];
  aeSunField(ae.data.start + (ae.startIdx + i + tau) * 3600000 - 1800000, ae.tmpK, ae.tmpS);
  for (let k = 0; k < AE_N; k++) out[k] = Math.max(0, Math.min(100, 100 * (ae.tmpR[k] + AE.wSun * ae.tmpS[k]) / ae.norm));
}
function aeLabel() {
  if (!ae.data) return;
  const ms = ae.data.start + (ae.startIdx + ae.t) * 3600000;
  document.getElementById('wx-time').textContent = new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric' });
}
function aeDraw() {
  if (!ae.canvas || !ae.R) return;
  const ctx = ae.ctx, w = ae.canvas.width, h = ae.canvas.height;
  ctx.clearRect(0, 0, w, h);
  let i = Math.min(Math.floor(ae.t), ae.n - 2), tau = Math.max(0, Math.min(1, ae.t - i));
  aeInterpAt(i, tau, ae.vals);
  const d = ae.img.data, P = AE_PX;
  for (let k = 0; k < AE_N; k++) {
    const q = Math.round(ae.vals[k] * 2.55), c = JET[q], o = k * 4;
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = Math.round(255 * P.mask[k] * AE_LUT[q]);
  }
  ae.offCtx.putImageData(ae.img, 0, 0);
  const nw = map.latLngToContainerPoint([AE.lat1, AE.lon0]), se = map.latLngToContainerPoint([AE.lat0, AE.lon1]);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(ae.off, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
  if (!ae.flows[i + 1] && i + 2 < ae.n) setTimeout(() => { if (!ae.flows[i + 1]) aeFlowFor(i + 1); }, 0);   // warm the next hour's flow before it's needed
}
function aeReset() {
  if (!ae.canvas) return;
  const sz = map.getSize(); ae.canvas.width = sz.x; ae.canvas.height = sz.y;
  L.DomUtil.setPosition(ae.canvas, map.containerPointToLayerPoint([0, 0])); ae.dirty = true;
}
function aeTick(ts) {
  ae.raf = requestAnimationFrame(aeTick);
  if (!ae.on || !ae.R || document.hidden) { ae.last = ts; return; }
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
  const fl = aeBuildFields(data, nowIdx, n);
  ae.data = data; ae.startIdx = nowIdx; ae.n = n; ae.R = fl.R; ae.K = fl.K; ae.flows = new Array(n - 1); ae.t = Math.min(ae.t, n - 1);
  ae.norm = data.mode === 'none' ? AE.wCape + AE.wSun : 1;   // no third ingredient: renormalise so the scale still reaches 100
  if (!ae.vals) { ae.vals = new Float32Array(AE_N); ae.tmpR = new Float32Array(AE_N); ae.tmpK = new Float32Array(AE_N); ae.tmpS = new Float32Array(AE_N);
    ae.off = document.createElement('canvas'); ae.off.width = AE_W; ae.off.height = AE_H; ae.offCtx = ae.off.getContext('2d'); ae.img = ae.offCtx.createImageData(AE_W, AE_H); }
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
