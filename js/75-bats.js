/* ===== BATS BEGIN ===== */
/* ---------- FAMILIARS: real USGS NABat summer-occupancy model, dressed as wizards' nocturnal familiars ----------
   Source: "Status and Trends of North American Bats: Summer Occupancy Analysis 2010-2019" (USGS NABat data release,
   public domain). For each 10 km grid cell and year the model gives the probability that the species is present
   in summer. This is modeled HISTORY through 2019, not live data, and not a count of bats. Only three species have
   all ten years (little brown, northern long-eared, tricolored: the white-nose-syndrome species); the rest start in 2016.
   Data are packed by the helper tool into data/bats/*.js and loaded on demand, one species at a time. */
const BAT_SP = {
  MYLU: ['Little brown bat', 'Myotis lucifugus'], MYSE: ['Northern long-eared bat', 'Myotis septentrionalis'], PESU: ['Tricolored bat', 'Perimyotis subflavus'],
  MYEV: ['Long-eared myotis', 'Myotis evotis'], MYGR: ['Gray bat', 'Myotis grisescens'], MYLE: ['Eastern small-footed bat', 'Myotis leibii'],
  MYTH: ['Fringed myotis', 'Myotis thysanodes'], MYVO: ['Long-legged myotis', 'Myotis volans'], MYYU: ['Yuma myotis', 'Myotis yumanensis'],
  EPFU: ['Big brown bat', 'Eptesicus fuscus'], LACI: ['Hoary bat', 'Lasiurus cinereus'], LANO: ['Silver-haired bat', 'Lasionycteris noctivagans'] };
const BAT_WEAK = new Set(['EPFU', 'LACI', 'LANO']);   // USGS: methods were insufficient to model these reliably
const BAT = { w: 2000, on: false, sp: 'MYLU', t: 0, playing: false, dirty: false, cells: null, d: null, loading: false, canvas: null, ctx: null, raf: 0, last: 0, autoplayed: false, hash: null };
const batPaneEl = map.createPane('batPane'); batPaneEl.style.zIndex = 235; batPaneEl.style.pointerEvents = 'none';
const batEl = id => document.getElementById(id);
const BAT_STOPS = [[0, [27, 20, 80], 0.14], [0.25, [91, 42, 158], 0.4], [0.5, [179, 61, 181], 0.6], [0.75, [240, 138, 75], 0.75], [1, [255, 224, 138], 0.85]];
const BAT_LUT = new Uint32Array(251), BAT_ALPHA = new Float32Array(251);   // colour and base opacity for every occupancy step (0..250 = 0..100%)
for (let q = 0; q <= 250; q++) {
  const v = q / 250; let k = 1; while (k < BAT_STOPS.length - 1 && v > BAT_STOPS[k][0]) k++;
  const a = BAT_STOPS[k - 1], b = BAT_STOPS[k], f = (v - a[0]) / (b[0] - a[0]), c = a[1].map((x, i) => Math.round(x + (b[1][i] - x) * f));
  BAT_LUT[q] = (c[0] | (c[1] << 8) | (c[2] << 16)) >>> 0; BAT_ALPHA[q] = 255 * (a[2] + (b[2] - a[2]) * f);
}
const batU8 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const batScript = src => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('missing ' + src)); document.head.appendChild(s); });

async function batEnsureCells() {
  if (BAT.cells) return BAT.cells;
  await batScript('data/bats/cells.js');
  const raw = new Uint16Array(batU8(window.BAT_CELLS.b64).buffer), n = window.BAT_CELLS.n, lon = new Float32Array(n), lat = new Float32Array(n);
  let lo0 = 1e9, lo1 = -1e9, la0 = 1e9, la1 = -1e9;
  for (let i = 0; i < n; i++) { lon[i] = raw[2 * i] / 100 - 180; lat[i] = raw[2 * i + 1] / 100 - 90; lo0 = Math.min(lo0, lon[i]); lo1 = Math.max(lo1, lon[i]); la0 = Math.min(la0, lat[i]); la1 = Math.max(la1, lat[i]); }
  lo0 -= 0.6; lo1 += 0.6; la0 = Math.max(-80, la0 - 0.6); la1 = Math.min(80, la1 + 0.6);
  // Fixed Mercator-aligned canvas covering every cell, so the picture lines up with the map at any zoom.
  const S = BAT.w / (lo1 - lo0), pr = S * 180 / Math.PI, y1 = mercY(la1), H = Math.ceil((y1 - mercY(la0)) * pr);
  const px = new Int16Array(n), py = new Int16Array(n), bs = new Uint8Array(n);
  for (let i = 0; i < n; i++) { px[i] = Math.round((lon[i] - lo0) * S); py[i] = Math.round((y1 - mercY(lat[i])) * pr);
    bs[i] = Math.max(2, Math.round(10 / (111.32 * Math.cos(lat[i] * Math.PI / 180)) * S * 1.15)); }
  BAT.cells = { n, lon, lat, px, py, bs, lo0, lo1, la0, la1, H };
  BAT.off = document.createElement('canvas'); BAT.off.width = BAT.w; BAT.off.height = H; BAT.offCtx = BAT.off.getContext('2d');
  BAT.img = BAT.offCtx.createImageData(BAT.w, H); BAT.buf32 = new Uint32Array(BAT.img.data.buffer);
  return BAT.cells;
}
async function batUse(code) {
  const status = batEl('bat-status'); BAT.loading = true; status.textContent = 'loading…';
  try {
    await batEnsureCells();
    if (!window.BAT_TRENDS) await batScript('data/bats/trends.js').catch(() => {});
    if (!(window.BAT_DATA && window.BAT_DATA[code])) await batScript(`data/bats/${code}.js`);
    const r = window.BAT_DATA[code], C = BAT.cells;
    const d = { code, y0: r.y0, ny: r.ny, n: r.n, idx: new Uint32Array(batU8(r.idx).buffer), mean: batU8(r.mean), dif: batU8(r.dif) };
    const hash = new Map();   // 0.2-degree buckets for click lookups
    for (let j = 0; j < d.n; j++) { const c = d.idx[j], k = Math.floor(C.lat[c] / 0.2) * 100000 + Math.floor(C.lon[c] / 0.2); let a = hash.get(k); if (!a) hash.set(k, a = []); a.push(j); }
    BAT.d = d; BAT.hash = hash; BAT.sp = code;
    const sl = batEl('bat-slider'); sl.max = String(Math.max(1, d.ny - 1)); BAT.t = Math.min(BAT.t, d.ny - 1);
    status.textContent = `${d.n.toLocaleString()} cells · modeled ${d.y0}–${d.y0 + d.ny - 1}`;
    batNote(); BAT.dirty = true; batLabel();
  } catch (e) {
    console.error('Bat layer', e); BAT.d = null; BAT.dirty = true;
    status.textContent = /missing/.test(e.message) ? `no data file for ${code} (add data/bats/${code}.js)` : 'could not load';
  }
  BAT.loading = false;
}
function batNote() {
  const d = BAT.d, el = batEl('bat-note'); if (!d) { el.textContent = ''; return; }
  const tr = window.BAT_TRENDS && window.BAT_TRENDS[d.code] && window.BAT_TRENDS[d.code].Range, yr = d.y0 + Math.round(BAT.t);
  let s = '';
  if (tr && tr.p) { const cur = tr.p[yr - tr.y0], first = tr.p[0]; if (cur) s = `Range-wide mean occupancy ${yr}: ${Math.round(cur[0] * 100)}%` + (first && yr !== tr.y0 ? ` (${tr.y0}: ${Math.round(first[0] * 100)}%)` : ''); }
  if (BAT_WEAK.has(d.code)) s += (s ? ' · ' : '') + 'USGS rates this species\' model as weak: rough guide only';
  el.textContent = s;
}
function batLabel() { const d = BAT.d; batEl('bat-year').textContent = d ? String(d.y0 + Math.round(BAT.t)) : '—'; batNote(); }

function batStep() {   // which pair of years we are between, and how far
  const ny = BAT.d.ny, i = Math.max(0, Math.min(Math.floor(BAT.t), ny - 2));
  return { i, tau: ny < 2 ? 0 : Math.max(0, Math.min(1, BAT.t - i)), nx: ny < 2 ? 0 : 1 };
}
function batPacked(j, st) {   // colour + opacity of one cell at the current moment (0 = not modeled)
  const d = BAT.d, o = j * d.ny + st.i, a = d.mean[o], b = d.mean[o + st.nx]; if (a === 255 && b === 255) return 0;
  const m = a === 255 ? b : b === 255 ? a : a + (b - a) * st.tau;   // smooth drift between the yearly estimates
  const da = d.dif[o], db = d.dif[o + st.nx]; let w = da === 255 ? db : db === 255 ? da : da + (db - da) * st.tau; if (w === 255) w = 125;
  const q = Math.round(m), alpha = (BAT_ALPHA[q] * (1 - 0.45 * Math.min(1, w / 200))) | 0;   // wide credible interval = fainter cell
  return ((alpha << 24) | BAT_LUT[q]) >>> 0;
}
function batRender() {   // zoomed out: every cell into one fixed-size picture, drawn scaled
  const d = BAT.d, C = BAT.cells, W = BAT.w, buf = BAT.buf32, st = batStep(); buf.fill(0);
  for (let j = 0; j < d.n; j++) {
    const packed = batPacked(j, st); if (!packed) continue;
    const c = d.idx[j], bs = C.bs[c], x0 = C.px[c] - (bs >> 1), y0 = C.py[c] - (bs >> 1);
    for (let yy = 0; yy < bs; yy++) { let p = (y0 + yy) * W + x0; for (let xx = 0; xx < bs; xx++, p++) buf[p] = packed; }
  }
  BAT.offCtx.putImageData(BAT.img, 0, 0);
}
function batDrawCells(ctx) {   // zoomed in: the cells on screen as exact-size blocks, written (not blended) so neighbours never leave seams
  const d = BAT.d, C = BAT.cells, st = batStep(), bnd = map.getBounds().pad(0.05), z = map.getZoom(), w = BAT.canvas.width, h = BAT.canvas.height;
  if (!BAT.sImg || BAT.sImg.width !== w || BAT.sImg.height !== h) { BAT.sImg = ctx.createImageData(w, h); BAT.sBuf = new Uint32Array(BAT.sImg.data.buffer); }
  const buf = BAT.sBuf, mpx = 10000 * Math.pow(2, z) / 156543.03; buf.fill(0);
  for (let j = 0; j < d.n; j++) {
    const c = d.idx[j], la = C.lat[c], lo = C.lon[c]; if (la < bnd.getSouth() || la > bnd.getNorth() || lo < bnd.getWest() || lo > bnd.getEast()) continue;
    const packed = batPacked(j, st); if (!packed) continue;
    const p = map.latLngToContainerPoint([la, lo]), s = mpx / Math.cos(la * Math.PI / 180), bs = Math.ceil(s * 1.2), x0 = Math.round(p.x - bs / 2), y0 = Math.round(p.y - bs / 2);
    for (let yy = Math.max(0, y0); yy < Math.min(h, y0 + bs); yy++) { const row = yy * w; for (let xx = Math.max(0, x0); xx < Math.min(w, x0 + bs); xx++) buf[row + xx] = packed; }
  }
  ctx.putImageData(BAT.sImg, 0, 0);
}
function batDraw() {
  if (!BAT.canvas) return;
  const ctx = BAT.ctx, w = BAT.canvas.width, h = BAT.canvas.height; ctx.clearRect(0, 0, w, h);
  if (!BAT.on || !BAT.d || !BAT.cells) return;
  if (map.getZoom() >= 6) { batDrawCells(ctx); return; }
  batRender();
  const C = BAT.cells, nw = map.latLngToContainerPoint([C.la1, C.lo0]), se = map.latLngToContainerPoint([C.la0, C.lo1]);
  ctx.imageSmoothingEnabled = (se.x - nw.x) / BAT.w < 2.5; ctx.imageSmoothingQuality = 'high';   // soft when zoomed out, crisp squares when zoomed in
  ctx.drawImage(BAT.off, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
}
function batReset() { if (!BAT.canvas) return; const sz = map.getSize(); BAT.canvas.width = sz.x; BAT.canvas.height = sz.y; L.DomUtil.setPosition(BAT.canvas, map.containerPointToLayerPoint([0, 0])); BAT.dirty = true; }
function batTick(ts) {
  BAT.raf = requestAnimationFrame(batTick);
  if (!BAT.on || !BAT.d || document.hidden) { BAT.last = ts; return; }
  if (BAT.playing) {
    BAT.t += Math.min((ts - BAT.last) / 1000, 0.2) * 1000 / 1400;   // about 1.4 s per year
    if (BAT.t >= BAT.d.ny - 1) { BAT.t = BAT.d.ny - 1; batSetPlaying(false); }   // plays once through, then rests on the latest year
    batEl('bat-slider').value = BAT.t; BAT.dirty = true;
  }
  BAT.last = ts;
  if (BAT.dirty) { batDraw(); batLabel(); BAT.dirty = false; }
}
function batSetPlaying(on) { BAT.playing = on; batEl('bat-play').innerHTML = on ? PAUSE_SVG : PLAY_SVG; }

/* click lookup: nearest modeled cell within ~8 km, plus the real state-level trend */
function batFind(ll) {
  const d = BAT.d, C = BAT.cells; if (!d || !BAT.hash) return null;
  const bx = Math.floor(ll.lng / 0.2), by = Math.floor(ll.lat / 0.2), cl = Math.cos(ll.lat * Math.PI / 180); let best = null, bd = 64;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const a = BAT.hash.get((by + dy) * 100000 + bx + dx); if (!a) continue;
    for (const j of a) { const c = d.idx[j], ex = (C.lon[c] - ll.lng) * 111.32 * cl, ey = (C.lat[c] - ll.lat) * 111.32, k = ex * ex + ey * ey; if (k < bd) { bd = k; best = j; } } }
  return best;
}
function batSpark(d, j) {
  const w = 150, h = 34, n = d.ny, bw = w / n, cur = Math.round(BAT.t);
  const bars = Array.from({ length: n }, (_, y) => { const m = d.mean[j * n + y]; if (m === 255) return ''; const bh = Math.max(1, m / 250 * (h - 10));
    return `<rect x="${(y * bw + 1).toFixed(1)}" y="${(h - 9 - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" fill="${y === cur ? '#F3EFE4' : 'rgba(224,86,224,0.6)'}"/>`; }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="margin-top:3px">${bars}<text x="1" y="${h - 1}" font-size="7" fill="rgba(245,242,232,0.6)">${d.y0}</text><text x="${w - 1}" y="${h - 1}" font-size="7" fill="rgba(245,242,232,0.6)" text-anchor="end">${d.y0 + n - 1}</text></svg>`;
}
function batInfoHtml(ll) {
  const d = BAT.d; if (!BAT.on || !d) return '';
  const j = batFind(ll); if (j == null) return '';
  const nm = BAT_SP[d.code][0], yr = d.y0 + Math.round(BAT.t), o = j * d.ny + Math.round(BAT.t), m = d.mean[o], w = d.dif[o];
  let h = `<div style="font-size:0.72rem;margin-top:6px;border-top:1px solid rgba(245,242,232,0.2);padding-top:4px"><b>${nm}: summer occupancy ≈ ${m === 255 ? 'n/a' : Math.round(m / 2.5) + '%'}</b> (${yr})`;
  if (m !== 255 && w !== 255) h += `<br>the model's 95% range here is about ${Math.round(w / 2.5)} points wide`;
  h += batSpark(d, j);
  const st = typeof stateAt === 'function' ? stateAt(ll.lat, ll.lng) : null, T = window.BAT_TRENDS && window.BAT_TRENDS[d.code], reg = T && st && T[st];
  if (reg) { const pick = reg.t9 ? ['9', reg.t9] : reg.t7 ? ['7', reg.t7] : reg.t3 ? ['3', reg.t3] : null, pc = v => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v * 100)) + '%';
    if (pick) h += `<br>${st} overall: ${pc(pick[1][0])} change over ${pick[0]} years (95% range ${pc(pick[1][1])} to ${pc(pick[1][2])})`; }
  return h + `<br><i>${BAT_SP[d.code][1]} · USGS NABat model, summer; history, not live</i></div>`;
}

/* ---------- wiring ---------- */
(() => {
  const sel = batEl('bat-sp'), card = batEl('bat-card');
  Object.keys(BAT_SP).forEach(c => sel.add(new Option(BAT_SP[c][0] + (BAT_WEAK.has(c) ? ' (weak model)' : ''), c)));
  sel.value = BAT.sp; L.DomEvent.disableClickPropagation(card); L.DomEvent.disableScrollPropagation(card);
  BAT.canvas = L.DomUtil.create('canvas', 'flow-canvas'); batPaneEl.appendChild(BAT.canvas); BAT.ctx = BAT.canvas.getContext('2d'); batReset();
  sel.addEventListener('change', async () => { batSetPlaying(false); BAT.t = 1e9; await batUse(sel.value); if (BAT.d) { BAT.t = BAT.d.ny - 1; batEl('bat-slider').value = BAT.t; } BAT.dirty = true; });
  batEl('bat-play').addEventListener('click', () => { if (!BAT.d) return; if (!BAT.playing && BAT.t >= BAT.d.ny - 1.01) BAT.t = 0; batSetPlaying(!BAT.playing); BAT.dirty = true; });
  batEl('bat-slider').addEventListener('input', e => { batSetPlaying(false); BAT.t = +e.target.value; BAT.dirty = true; });
  batEl('toggle-bats').addEventListener('change', async e => {
    BAT.on = e.target.checked; card.style.display = BAT.on ? 'flex' : 'none';
    if (BAT.on && !BAT.d && !BAT.loading) await batUse(BAT.sp);
    if (BAT.on && BAT.d && !BAT.autoplayed && !(typeof reduceMotion !== 'undefined' && reduceMotion)) { BAT.autoplayed = true; BAT.t = 0; batSetPlaying(true); }   // first time on: play the whole record once
    else if (BAT.on && BAT.d && !BAT.autoplayed) { BAT.autoplayed = true; BAT.t = BAT.d.ny - 1; batEl('bat-slider').value = BAT.t; }
    BAT.dirty = true;
  });
  map.on('zoomstart', () => { if (BAT.ctx) BAT.ctx.clearRect(0, 0, BAT.canvas.width, BAT.canvas.height); });
  map.on('moveend zoomend resize', batReset);
  batSetPlaying(false); BAT.raf = requestAnimationFrame(batTick);
})();
/* ===== BATS END ===== */
