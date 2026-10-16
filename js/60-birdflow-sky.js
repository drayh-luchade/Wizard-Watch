/* ===== FLOW+SKY BEGIN ===== */
/* ---------- BIRD FLOW: animated particles following the real radar-derived bird movement vectors ----------
   Each active NEXRAD site reports the average movement of birds as east/west (u) and north/south (v)
   components in m/s. Those vectors are blended across the country with a Gaussian kernel into a coarse grid;
   particles are spawned where migration density is high and advected along the interpolated field, so
   direction and relative intensity are real. Speed is TIME-LAPSED (FLOW.timeScale) — real flight speeds
   would be invisible at continental scale — and the sidebar says so. */
const FLOW = { lat0: 24, lat1: 50, lon0: -125, lon1: -66, step: 0.5, sigmaKm: 220, cutKm: 650,
  timeScale: 14400, nParticles: window.innerWidth < 720 ? 700 : 1500, trail: 8, ref: 10 };
const flowPaneEl = map.createPane('flowPane'); flowPaneEl.style.zIndex = 450; flowPaneEl.style.pointerEvents = 'none';
const flowS = { grid: null, particles: [], canvas: null, ctx: null, running: false, paused: false, last: 0, lastDraw: 0, raf: 0 };
const FLOW_COLORS = [null, '#5FD0C8', '#F2C94C', '#F2994A', '#E056E0'];
const FLOW_ALPHA = [0, 0.5, 0.7, 0.85, 0.95];
const flowBucket = d => d < 0.3 ? 0 : d <= 4 ? 1 : d <= 8 ? 2 : d <= 13 ? 3 : 4;

function flowSetData(vectors) {
  const nx = Math.round((FLOW.lon1 - FLOW.lon0) / FLOW.step) + 1, ny = Math.round((FLOW.lat1 - FLOW.lat0) / FLOW.step) + 1;
  const U = new Float32Array(nx * ny), V = new Float32Array(nx * ny), D = new Float32Array(nx * ny), C = new Float32Array(nx * ny);
  const s2 = 2 * FLOW.sigmaKm ** 2, cut2 = FLOW.cutKm ** 2;
  for (let j = 0; j < ny; j++) {
    const lat = FLOW.lat0 + j * FLOW.step, cosl = Math.cos(lat * Math.PI / 180);
    for (let i = 0; i < nx; i++) {
      const lon = FLOW.lon0 + i * FLOW.step;
      let sg = 0, sgd = 0, su = 0, sv = 0, sw = 0;
      for (const p of vectors) {
        const dy = (lat - p.lat) * 111, dx = (lon - p.lon) * 111 * cosl, d2 = dx * dx + dy * dy;
        if (d2 > cut2) continue;
        const g = Math.exp(-d2 / s2), wv = g * p.density;
        sg += g; sgd += wv; su += wv * p.u; sv += wv * p.v; sw += wv; // vectors are density-weighted; zero-density sites still pull density down
      }
      const k = j * nx + i;
      C[k] = Math.min(1, sg);                // how well radar coverage reaches this cell
      D[k] = sg > 1e-6 ? sgd / sg : 0;       // interpolated migration density, birds/km³
      if (sw > 1e-6) { U[k] = su / sw; V[k] = sv / sw; }
    }
  }
  flowS.grid = { nx, ny, U, V, D, C };
}
function flowSample(lat, lon) {
  const g = flowS.grid; if (!g) return null;
  const fx = (lon - FLOW.lon0) / FLOW.step, fy = (lat - FLOW.lat0) / FLOW.step;
  if (fx < 0 || fy < 0 || fx >= g.nx - 1 || fy >= g.ny - 1) return null;
  const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
  const k00 = j * g.nx + i, k10 = k00 + 1, k01 = k00 + g.nx, k11 = k01 + 1;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  const bl = A => A[k00] * w00 + A[k10] * w10 + A[k01] * w01 + A[k11] * w11;
  return { u: bl(g.U), v: bl(g.V), d: bl(g.D), c: bl(g.C) };
}
function flowSpawn(p) {
  for (let t = 0; t < 12; t++) {
    const lat = FLOW.lat0 + Math.random() * (FLOW.lat1 - FLOW.lat0), lon = FLOW.lon0 + Math.random() * (FLOW.lon1 - FLOW.lon0);
    const s = flowSample(lat, lon);
    if (s && Math.random() < Math.min(1, (s.d * s.c) / FLOW.ref)) {   // more particles where migration is heavier
      p.lat = lat; p.lon = lon; p.age = 0; p.max = 70 + Math.random() * 90; p.trail = []; p.on = true; return;
    }
  }
  p.on = false;
}
function flowTick(ts) {
  if (!flowS.running) return;
  flowS.raf = requestAnimationFrame(flowTick);
  if (document.hidden || flowS.paused || !flowS.grid) { flowS.last = ts; return; }
  if (ts - flowS.lastDraw < 30) return;                              // ~33 fps is plenty
  const dt = Math.min((ts - flowS.last) / 1000, 0.08); flowS.last = ts; flowS.lastDraw = ts;
  const sim = dt * FLOW.timeScale, W = flowS.canvas.width, H = flowS.canvas.height, buckets = new Map();
  for (const p of flowS.particles) {
    if (!p.on) { if (Math.random() < 0.15) flowSpawn(p); continue; }
    const s = flowSample(p.lat, p.lon);
    if (!s || s.d * s.c < 0.15 || ++p.age > p.max) { flowSpawn(p); continue; }
    p.lat += (s.v * sim) / 111000;
    p.lon += (s.u * sim) / (111000 * Math.cos(p.lat * Math.PI / 180));
    const pt = map.latLngToContainerPoint([p.lat, p.lon]);
    if (pt.x < -20 || pt.y < -20 || pt.x > W + 20 || pt.y > H + 20) { p.trail.length = 0; continue; }
    const t = p.trail; t.push(pt.x, pt.y);
    if (t.length > FLOW.trail * 2) t.splice(0, 2);
    const b = flowBucket(s.d), n = t.length / 2;
    if (!b || n < 2) continue;
    for (let k = 1; k < n; k++) {                                     // segments batched per (intensity, fade) into one path each
      const a = Math.max(1, Math.round(k / (n - 1) * 4)), key = b * 10 + a;
      let e = buckets.get(key); if (!e) { e = { path: new Path2D(), b, a }; buckets.set(key, e); }
      e.path.moveTo(t[2 * k - 2], t[2 * k - 1]); e.path.lineTo(t[2 * k], t[2 * k + 1]);
    }
  }
  const ctx = flowS.ctx; ctx.clearRect(0, 0, W, H); ctx.lineWidth = 1.5; ctx.lineCap = 'round';
  for (const e of buckets.values()) { ctx.globalAlpha = FLOW_ALPHA[e.b] * (e.a / 4); ctx.strokeStyle = FLOW_COLORS[e.b]; ctx.stroke(e.path); }
  ctx.globalAlpha = 1;
}
function flowReset() {
  const sz = map.getSize(); flowS.canvas.width = sz.x; flowS.canvas.height = sz.y;
  L.DomUtil.setPosition(flowS.canvas, map.containerPointToLayerPoint([0, 0]));
  flowS.particles.forEach(p => { p.trail = []; });
}
function flowStart() {
  if (flowS.running) return;
  if (!flowS.canvas) { flowS.canvas = L.DomUtil.create('canvas', 'flow-canvas'); flowPaneEl.appendChild(flowS.canvas); flowS.ctx = flowS.canvas.getContext('2d'); }
  flowS.canvas.style.display = '';
  flowS.particles = Array.from({ length: FLOW.nParticles }, () => ({ on: false, lat: 0, lon: 0, age: 0, max: 100, trail: [] }));
  flowReset(); flowS.running = true; flowS.paused = false; flowS.last = performance.now();
  flowS.raf = requestAnimationFrame(flowTick);
}
function flowStop() {
  flowS.running = false; cancelAnimationFrame(flowS.raf);
  if (flowS.canvas) { flowS.ctx.clearRect(0, 0, flowS.canvas.width, flowS.canvas.height); flowS.canvas.style.display = 'none'; }
}
// Trails are stored in screen pixels, so panning/zooming clears them and the canvas is re-anchored afterwards.
map.on('movestart zoomstart', () => { flowS.paused = true; if (flowS.ctx) flowS.ctx.clearRect(0, 0, flowS.canvas.width, flowS.canvas.height); });
map.on('moveend zoomend resize', () => { if (flowS.canvas && flowS.running) { flowReset(); flowS.paused = false; } });
// The sidebar collapse resizes #map without a window resize; keep Leaflet (and the flow canvas) in step.
let _rszRaf = 0;
new ResizeObserver(() => { cancelAnimationFrame(_rszRaf); _rszRaf = requestAnimationFrame(() => map.invalidateSize({ animate: false })); }).observe(document.getElementById('map'));
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const flowToggle = document.getElementById('toggle-birdflow');
if (reduceMotion) flowToggle.checked = false;   // respect the OS "reduce motion" setting; the user can still opt in
flowToggle.addEventListener('change', e => e.target.checked ? flowStart() : flowStop());
if (flowToggle.checked) flowStart();

/* ---------- SKY: moon phase + day/night terminator (computed locally from the clock; approximate) ---------- */
const RAD = Math.PI / 180;
function moonPhase(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;          // Julian date
  let f = ((jd - 2451550.1) / 29.530588853) % 1; if (f < 0) f += 1;   // days since the 2000-01-06 new moon / synodic month
  const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
  return { f, illum: (1 - Math.cos(2 * Math.PI * f)) / 2, name: names[Math.floor(f * 8 + 0.5) % 8] };
}
function moonSvg(f) {
  const r = 11, c = 14, k = Math.cos(2 * Math.PI * f), waxing = f < 0.5, rx = Math.abs(k) * r;
  const outer = waxing ? 1 : 0, term = waxing ? (k > 0 ? 0 : 1) : (k > 0 ? 1 : 0);
  return `<svg viewBox="0 0 28 28" width="28" height="28"><circle cx="${c}" cy="${c}" r="${r}" fill="#1d2142" stroke="rgba(245,242,232,0.35)"/>` +
    `<path d="M ${c} ${c - r} A ${r} ${r} 0 0 ${outer} ${c} ${c + r} A ${rx.toFixed(2)} ${r} 0 0 ${term} ${c} ${c - r} Z" fill="#F3EFE4"/></svg>`;
}
function sunPosition(date) {
  const N = (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000;   // days since Jan 1 00:00 UTC
  const decl = -Math.asin(0.39779 * Math.cos(RAD * (0.98565 * (N + 10) + 1.914 * Math.sin(RAD * 0.98565 * (N - 2)))));
  const B = RAD * (360 / 365 * (N - 81)), eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);   // equation of time, minutes
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = (12 - utcH - eot / 60) * 15; lon = ((lon + 540) % 360) - 180;
  return { decl, lon };   // subsolar point
}
function nightPolygon(date) {
  const { decl, lon: ls } = sunPosition(date);
  const td = Math.tan(Math.abs(decl) < 1e-4 ? 1e-4 : decl), pts = [];
  for (let lon = -180; lon <= 180; lon += 2) pts.push([Math.max(-85, Math.min(85, Math.atan(-Math.cos((lon - ls) * RAD) / td) / RAD)), lon]);
  const pole = decl > 0 ? -85 : 85;   // whichever pole is in darkness (Mercator can't draw ±90)
  pts.push([pole, 180], [pole, -180]);
  return pts;
}
const nightPaneEl = map.createPane('nightPane'); nightPaneEl.style.zIndex = 240; nightPaneEl.style.pointerEvents = 'none';
const nightLayer = L.layerGroup().addTo(map);
function updateSky() {
  const now = new Date();
  nightLayer.clearLayers();
  L.polygon(nightPolygon(now), { pane: 'nightPane', stroke: false, fillColor: '#02030f', fillOpacity: 0.3, interactive: false }).addTo(nightLayer);
  const m = moonPhase(now);
  document.getElementById('moon-icon').innerHTML = moonSvg(m.f);
  document.getElementById('moon-name').textContent = m.name;
  document.getElementById('moon-detail').textContent = `${Math.round(m.illum * 100)}% lit`;
}
updateSky();
setInterval(updateSky, 5 * 60 * 1000);
document.getElementById('toggle-night').addEventListener('change', e => e.target.checked ? nightLayer.addTo(map) : map.removeLayer(nightLayer));
/* ===== FLOW+SKY END ===== */
