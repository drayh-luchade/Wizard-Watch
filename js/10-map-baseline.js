/* ---------- Map setup (no tile layer — stylized dark basemap) ----------
   Stacking, bottom to top: land fill (landPane 210) -> dasymetric density raster (densityPane 230)
   -> US state outlines (linePane 250) -> anomaly zones + warnings (default overlayPane 400). */
const overlayRenderer = L.svg();
const map = L.map('map', {worldCopyJump:false, minZoom:2, maxZoom:10, renderer: overlayRenderer}).setView([15, -80], 3);
[['landPane',210],['densityPane',230],['linePane',250]].forEach(([n,z]) => {
  const p = map.createPane(n); p.style.zIndex = z; p.style.pointerEvents = 'none';
});
const mapStarLayer = document.createElement('div');
mapStarLayer.className = 'star-layer';
document.getElementById('map').appendChild(mapStarLayer);
scatterStars(mapStarLayer, 220);

// Basemap: US states (with Alaska & Hawaii) + every other country at country level only.
L.geoJSON(basemap, {
  pane: 'landPane', interactive: false,
  style: f => f.properties.level === 'state'
    ? { stroke: false, fillColor: '#1A2A6C', fillOpacity: 0.95 }
    : { color: '#5B4A9E', weight: 1, fillColor: '#1A2A6C', fillOpacity: 0.95 }
}).addTo(map);
L.geoJSON(basemap, {
  pane: 'linePane', interactive: false,
  filter: f => f.properties.level === 'state',
  style: { color: '#5B4A9E', weight: 0.6, opacity: 0.5, fill: false }
}).addTo(map);

/* Stippled fill pattern for anomaly zones, injected into the default (overlay) SVG renderer. */
map.addLayer(overlayRenderer);
(function () {
  const svg = overlayRenderer._container;
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `<pattern id="stipple" patternUnits="userSpaceOnUse" width="6" height="6">
    <rect width="6" height="6" fill="transparent"/><circle cx="3" cy="3" r="1.1" fill="#FF3B3B"/></pattern>`;
  svg.insertBefore(defs, svg.firstChild);
})();
map.setView([39, -95], 4); // settle on a continental-US view

/* ---------- BASELINE HABITAT: dasymetric wizard-density raster ----------
   State-level density comes from real USDA data (forest cover % from Forest Inventory & Analysis,
   cattle density from NASS Jan-2024 head counts / land area), boosted 15% in states with major
   karst/cave regions. Instead of painting that value uniformly across each state, a build script
   (build_density_grid.py) redistributes it inside the state using fine-scale ancillary layers from
   Natural Earth: proximity to rivers, lakes and coast, remoteness from urban areas, and National Park
   Service land. Each state's average stays anchored to its real score; the pattern within it follows
   the habitat. Values are then feathered across state borders so state lines aren't visible in the data.
   NOT included yet: biodiversity richness (the pipeline accepts richness rasters when available). */

function greyRGB(t) {                       // t in 0..1 -> [r,g,b], matches the sidebar colorbar
  const lo = [58, 63, 74], hi = [242, 240, 234];
  return [0, 1, 2].map(i => Math.round(lo[i] + (hi[i] - lo[i]) * t));
}
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const invMercY = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
const densityGrids = {};

function buildDensityOverlay(key) {
  const r = densityData[key];
  const bin = atob(r.b64), g = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) g[i] = bin.charCodeAt(i);
  densityGrids[key] = { r, g };
  const S = 2, W = r.cols * S;
  const y0 = mercY(r.lat0), y1 = mercY(r.lat1);
  const H = Math.max(2, Math.round(W * (y1 - y0) / ((r.lon1 - r.lon0) * Math.PI / 180))); // rows in Mercator space
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    const lat = invMercY(y1 - (py + 0.5) / H * (y1 - y0));
    const fy = (r.lat1 - lat) / r.res - 0.5, iy = Math.floor(fy), ty = fy - iy;
    for (let px = 0; px < W; px++) {
      const fx = (px + 0.5) / S - 0.5, ix = Math.floor(fx), tx = fx - ix;
      let sv = 0, sw = 0;                    // bilinear, ignoring no-data cells
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const yy = iy + dy, xx = ix + dx;
        if (yy < 0 || yy >= r.rows || xx < 0 || xx >= r.cols) continue;
        const v = g[yy * r.cols + xx]; if (!v) continue;
        const wgt = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
        sv += v * wgt; sw += wgt;
      }
      if (sw < 0.5) continue;
      const t = Math.min(1, Math.max(0, (sv / sw - 1) / 253)), c = greyRGB(t), o = (py * W + px) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
      img.data[o + 3] = Math.round(90 + t * 150);   // sparse habitat fades, dense habitat glows
    }
  }
  ctx.putImageData(img, 0, 0);
  // Soften into blurred blobs rather than a crisp traced texture — the water/river signal is real
  // and still drives the underlying score, it just shouldn't visually read as a literal river map.
  const soft = document.createElement('canvas'); soft.width = W; soft.height = H;
  const sctx = soft.getContext('2d');
  sctx.filter = 'blur(5px)';
  sctx.drawImage(cv, 0, 0);
  return L.imageOverlay(soft.toDataURL(), [[r.lat0, r.lon0], [r.lat1, r.lon1]], { pane: 'densityPane', interactive: false });
}
const baselineLayer = L.layerGroup(Object.keys(densityData).map(buildDensityOverlay)).addTo(map);

/* ---------- Decorative "instrument reading" markers ----------
   Inspired by academic MCH-habitat map mockups: hollow circles for a "Thaum" energy reading, squares
   for identified coven/academy sites. Purely illustrative flavor on top of the real density data —
   the positions come from the real field (Thaum circles sample it, coven squares mark local peaks),
   but the "Thaum" unit and site names are invented. This is intentionally the most make-believe part
   of the page. Tied to the baseline toggle since it's part of the habitat visualization. */
const flavorLayer = L.layerGroup();
const ADJ = ['Hidden', 'Moonlit', 'Verdant', 'Sunken', 'Whispering', 'Ashen', 'Silver', 'Deepwood', 'Ember', 'Foggate'];
const NOUN = ['Academy of Arcane Studies', 'Coven', 'Institute of Thaumaturgy', 'Conclave', 'Lodge'];
function siteName(i) { return `${ADJ[i % ADJ.length]} ${NOUN[(i * 7) % NOUN.length]}`; }

function localMaxima(key, minDeg, want) {
  const { r, g } = densityGrids[key];
  const cand = [];
  for (let y = 1; y < r.rows - 1; y++) for (let x = 1; x < r.cols - 1; x++) {
    const v = g[y * r.cols + x]; if (!v) continue;
    let isMax = true;
    for (let dy = -1; dy <= 1 && isMax; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || yy >= r.rows || xx < 0 || xx >= r.cols) continue;
      if (g[yy * r.cols + xx] > v) { isMax = false; break; }
    }
    if (isMax && v > 140) cand.push({ v, lat: r.lat1 - (y + 0.5) * r.res, lng: r.lon0 + (x + 0.5) * r.res });
  }
  cand.sort((a, b) => b.v - a.v);
  const picked = [];
  for (const c of cand) {
    if (picked.length >= want) break;
    if (picked.some(p => Math.hypot(p.lat - c.lat, p.lng - c.lng) < minDeg)) continue;
    picked.push(c);
  }
  return picked;
}
function scatterThaum(key, step, cap) {
  const { r, g } = densityGrids[key];
  const pts = [];
  for (let y = 0; y < r.rows; y += step) for (let x = 0; x < r.cols; x += step) {
    const v = g[y * r.cols + x]; if (!v) continue;
    const dens = (v - 1) / 253 * 100;
    if (dens < 20) continue;
    pts.push({ lat: r.lat1 - (y + 0.5) * r.res, lng: r.lon0 + (x + 0.5) * r.res, dens });
  }
  const thin = Math.max(1, Math.ceil(pts.length / cap));
  return pts.filter((_, i) => i % thin === 0).slice(0, cap);
}

let covenCount = 0;
[['conus', 3.5, 9], ['alaska', 4, 2], ['hawaii', 2, 1]].forEach(([key, minDeg, want]) => {
  if (!densityGrids[key]) return;
  localMaxima(key, minDeg, want).forEach(p => {
    const icon = L.divIcon({ className: 'icon-coven-marker', iconSize: [12, 12] });
    L.marker([p.lat, p.lng], { icon }).bindPopup(
      `<b>${siteName(covenCount++)}</b><br>Identified coven/academy site <i>(illustrative)</i><br>Local density ≈ ${Math.round((p.v - 1) / 253 * 100)} wizards/km²`
    ).addTo(flavorLayer);
  });
  scatterThaum(key, key === 'conus' ? 22 : 10, key === 'conus' ? 22 : 4).forEach(p => {
    const icon = L.divIcon({ className: 'icon-thaum-marker', iconSize: [10, 10] });
    const thaum = (1 + p.dens / 100 * 9).toFixed(1);
    const st = stateAt(p.lat, p.lng);
    L.marker([p.lat, p.lng], { icon }).bindPopup(
      `<b>Thaum reading: ${thaum}</b> <i>(1–10 scale)</i><br>${st ? st + ' — ' : ''}sampled from ${Math.round(p.dens)} wizards/km² on the baseline layer<br>` +
      `<span style="font-size:0.72rem;opacity:0.75">Illustrative "magical energy" reading, scaled directly from the real density figure at this point — not a separate measurement.</span>`
    ).addTo(flavorLayer);
  });
});
flavorLayer.addTo(map);

/* ---------- Wizard Territories ----------
   9 regions formed from real USGS HUC2 basin names: each CONUS state is assigned to its dominant
   real basin (a simplification — several states straddle multiple real basins), those are unioned,
   then paired with their most-similar adjacent basin by area (greedy matching, falling back to
   nearest-by-distance when a basin's touching neighbors are already taken) and merged into one
   territory — directly per the brief: 18 is even, so every basin ends up in exactly one pair. */
const territoryLayer = L.geoJSON(wizardTerritories, {
  style: { color: '#E8B84B', weight: 2, dashArray: '6,4', fillOpacity: 0, opacity: 0.85 },
  onEachFeature: (f, layer) => {
    const p = f.properties;
    // Hover, not click: a territory's fill (even at opacity 0) covers most of the map, and a
    // click-popup here would swallow clicks meant for the baseline stats popup underneath.
    layer.bindTooltip(`<b>${p.name}</b><br><i>Real basins merged: ${p.realBasins.join(' + ')}</i><br>Area ≈ ${p.areaSqKm.toLocaleString()} km²`,
      { sticky: true, className: 'territory-tip' });
    layer.on('mouseover', () => layer.setStyle({ weight: 3.5, opacity: 1 }));
    layer.on('mouseout', () => layer.setStyle({ weight: 2, opacity: 0.85 }));
  }
}).addTo(map);
document.getElementById('toggle-territories').addEventListener('change', e =>
  e.target.checked ? territoryLayer.addTo(map) : map.removeLayer(territoryLayer));

function densityAt(lat, lng) {
  for (const k in densityGrids) {
    const { r, g } = densityGrids[k];
    if (lat < r.lat0 || lat >= r.lat1 || lng < r.lon0 || lng >= r.lon1) continue;
    const v = g[Math.floor((r.lat1 - lat) / r.res) * r.cols + Math.floor((lng - r.lon0) / r.res)];
    return v ? (v - 1) / 253 * 100 : null;
  }
  return null;
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function stateAt(lat, lng) {
  for (const f of basemap.features) {
    if (f.properties.level !== 'state') continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) if (inRing(lng, lat, p[0]) && !p.slice(1).some(h => inRing(lng, lat, h))) return f.properties.name;
  }
  return null;
}
// Small deterministic seeded RNG (mulberry32) so a given state's fake stats are stable across
// reloads/visitors, rather than re-rolling randomly every click.
function seedFrom(str) { let h = 1779033703; for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; } return h >>> 0; }
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Real breakdown of what actually drives the score at this point (forest% and cattle-density
// contributions, each state's real normalized values) — a horizontal bar pair, not a mock-up.
function componentBars(d) {
  const rows = [['Forest cover', d.forestNorm, '#8FAE83'], ['Cattle density', d.cattleNorm, '#C9A24B']];
  return rows.map(([label, pct, color]) =>
    `<div style="display:flex;align-items:center;gap:6px;margin-top:2px;font-size:0.72rem">` +
    `<span style="width:82px">${label}</span>` +
    `<span style="flex:1;background:rgba(0,0,0,0.15);border-radius:3px;overflow:hidden;height:7px">` +
    `<span style="display:block;height:100%;width:${Math.max(pct,3)}%;background:${color}"></span></span>` +
    `<span style="width:28px;text-align:right">${Math.round(pct)}</span></div>`).join('');
}
// Purely illustrative — a fabricated "incident log" so a click has something fun to look at, deterministic
// per place so it doesn't change on refresh. Explicitly labeled as fictional in the popup itself.
function incidentBars(seed) {
  const rnd = mulberry32(seedFrom(seed));
  const months = ['Apr','May','Jun','Jul','Aug','Sep'];
  const vals = months.map(() => Math.round(2 + rnd() * 16));
  const max = Math.max(...vals);
  const bars = vals.map((v, i) => `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1">` +
    `<div style="width:100%;height:36px;display:flex;align-items:flex-end"><div style="width:100%;background:#A66BC9;border-radius:2px 2px 0 0;height:${(v/max*36).toFixed(0)}px"></div></div>` +
    `<span style="font-size:0.6rem;opacity:0.65">${months[i]}</span></div>`).join('');
  return `<div style="display:flex;gap:3px;margin-top:3px">${bars}</div>`;
}
map.on('click', e => {
  if (!map.hasLayer(baselineLayer)) return;
  const v = densityAt(e.latlng.lat, e.latlng.lng);
  if (v == null) return;
  const st = stateAt(e.latlng.lat, e.latlng.lng), d = st && stateBaselineData[st];
  const content = `<b>≈ ${Math.round(v)} wizards/km²</b>` +
    (d ? `<br>${st}${d.karst ? ' <i>(karst multiplier applied)</i>' : ''}` + componentBars(d) : '') +
    `<div style="font-size:0.68rem;opacity:0.6;margin-top:5px">Reported wizarding incidents, last 6mo <i>(fictional, for flavor)</i>:</div>${incidentBars(st || (e.latlng.lat + ',' + e.latlng.lng))}`;
  L.popup().setLatLng(e.latlng).setContent(content + aetherInfoHtml(e.latlng)).openOn(map);
});
