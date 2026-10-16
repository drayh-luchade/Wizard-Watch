/* ---------- ANOMALY ZONES: real z-scores against a 10-year same-week climatology ---------- */
// Station dots sit in their own pane above the zone polygons: the zones' invisible fill would otherwise swallow clicks meant for a dot inside them.
const stationPaneEl = map.createPane('stationPane'); stationPaneEl.style.zIndex = 455;
function meanSd(arr, sdFloor) {
  if (arr.length < 20) return null;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return { mu: m, sd: Math.max(Math.sqrt(v), sdFloor) };
}
function pruneClimCache(currentKey) {
  try {
    Object.keys(localStorage).filter(k => (k.startsWith('wa_clim_') || k.startsWith('ww_clim_')) && k !== currentKey)
      .forEach(k => localStorage.removeItem(k)); // old dates are deleted automatically
  } catch (e) {}
}
async function fetchYearWindow(year, now) {
  const iso = d => d.toISOString().slice(0, 10);
  const s = new Date(Date.UTC(year, now.getMonth(), now.getDate() - CLIM_WINDOW_DAYS));
  const e = new Date(Date.UTC(year, now.getMonth(), now.getDate() + CLIM_WINDOW_DAYS));
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${LATS}&longitude=${LNGS}` +
    `&start_date=${iso(s)}&end_date=${iso(e)}&daily=temperature_2m_max,temperature_2m_min,wind_speed_10m_max&${UNITS}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('archive ' + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : [j];
}
// Run at most `limit` requests at once; results stay index-aligned with the inputs (failures kept, not dropped).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { ok: true, v: await fn(items[i]) }; } catch (e) { out[i] = { ok: false, e }; }
    }
  }));
  return out;
}
// Bump this whenever the stored shape changes. (v2 had `yearly`; v3 has yearlyTemp/yearlyWind — reading a
// v2 entry with v3 code is what crashed the station charts for returning visitors.)
const CLIM_KEY_PREFIX = 'ww_clim_v3|';
const CLIM_FAIL_KEY = 'ww_fail_clim', CLIM_COOLDOWN_MS = 10 * 60 * 1000;
function validClim(stats) {
  return Array.isArray(stats) && stats.length === stations.length &&
    stats.every(s => s && Array.isArray(s.yearlyTemp) && Array.isArray(s.yearlyWind) && Array.isArray(s.years));
}
async function getClimatology() {
  const now = new Date();
  const key = CLIM_KEY_PREFIX + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  pruneClimCache(key); // also deletes every older-version entry
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (cached && Date.now() - cached.ts < CLIM_TTL_MS && validClim(cached.stats)) return cached.stats;
  } catch (e) {}
  // Circuit breaker: after a failed baseline fetch, leave Open-Meteo's weighted rate limits alone for a few minutes.
  try {
    const failedAt = +localStorage.getItem(CLIM_FAIL_KEY);
    if (failedAt && Date.now() - failedAt < CLIM_COOLDOWN_MS) throw new Error('baseline cooling down after a failed fetch');
  } catch (e) { if (/cooling/.test(e.message)) throw e; }
  const years = Array.from({ length: CLIM_YEARS }, (_, i) => now.getFullYear() - 1 - i);
  const settled = await mapLimit(years, 3, y => fetchYearWindow(y, now));
  const good = settled.filter(s => s.ok).length;
  if (good < 4) {
    try { localStorage.setItem(CLIM_FAIL_KEY, String(Date.now())); } catch (e) {}
    const rl = settled.find(s => !s.ok && /429/.test(String(s.e && s.e.message)));
    throw new Error(rl ? 'archive 429 (rate limited)' : `only ${good} of ${years.length} baseline years loaded`);
  }
  const results = settled.map(s => (s.ok ? s.v : null)); // index-aligned with `years`; a failed year stays null
  const stats = stations.map((_, i) => {
    const T = [], W = [];
    // One same-week mean per year, oldest first, for BOTH variables — real data, used for station
    // sparkline charts. Which one gets charted depends on which is actually driving the anomaly.
    const yearlyTemp = [], yearlyWind = [];
    years.slice().reverse().forEach(year => {
      const yi = years.indexOf(year);
      const d = results[yi] && results[yi][i] && results[yi][i].daily;
      if (!d) { yearlyTemp.push(null); yearlyWind.push(null); return; }
      const tVals = [], wVals = [];
      d.time.forEach((_, k) => {
        const hi = d.temperature_2m_max[k], lo = d.temperature_2m_min[k], w = d.wind_speed_10m_max[k];
        if (hi != null && lo != null) { const m = (hi + lo) / 2; T.push(m); tVals.push(m); }
        if (w != null) { W.push(w); wVals.push(w); }
      });
      yearlyTemp.push(tVals.length ? tVals.reduce((a, b) => a + b, 0) / tVals.length : null);
      yearlyWind.push(wVals.length ? wVals.reduce((a, b) => a + b, 0) / wVals.length : null);
    });
    return { temp: meanSd(T, 2), wind: meanSd(W, 2), yearlyTemp, yearlyWind, years: years.slice().reverse() };
  });
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), stats })); localStorage.removeItem(CLIM_FAIL_KEY); } catch (e) {}
  return stats;
}

/* Anomaly field: each station's strongest z-score is interpolated across the country with a Gaussian
   kernel (normalised, so neighbours pull each other), then contoured at ANOMALY_Z with marching squares.
   A small "core" term guarantees any flagged station keeps at least a local zone. Shapes are only as
   detailed as the station network — a denser precomputed climatology grid would sharpen them. */
const FIELD = { lon0: -125, lon1: -66, lat0: 24, lat1: 50, step: 0.5, sigmaKm: 180, minCover: 0.35, coreKm: 45 };
function fieldValue(rows, lat, lng) {
  let sw = 0, sz = 0, core = 0;
  const cosl = Math.cos(lat * Math.PI / 180);
  for (const r of rows) {
    const dy = (lat - r.st.lat) * 111, dx = (lng - r.st.lng) * 111 * cosl, d2 = dx * dx + dy * dy;
    const w = Math.exp(-d2 / (2 * FIELD.sigmaKm ** 2));
    sw += w; sz += w * r.topZ;
    core = Math.max(core, r.topZ * Math.exp(-d2 / (2 * FIELD.coreKm ** 2)));
  }
  return Math.max(sw >= FIELD.minCover ? sz / sw : 0, core);
}
function contourRings(F, nx, ny, level) {
  const pts = new Map(), adj = new Map();
  const key = (t, i, j) => t + ':' + i + ':' + j;
  const edgePoint = (t, i, j) => {
    const k = key(t, i, j); if (pts.has(k)) return k;
    const a = F[j * nx + i], b = t === 'h' ? F[j * nx + i + 1] : F[(j + 1) * nx + i], f = (level - a) / (b - a);
    pts.set(k, t === 'h' ? [i + f, j] : [i, j + f]); return k;
  };
  const link = (p, q) => {
    if (!adj.has(p)) adj.set(p, []); if (!adj.has(q)) adj.set(q, []);
    adj.get(p).push(q); adj.get(q).push(p);
  };
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const A = F[j * nx + i], B = F[j * nx + i + 1], C = F[(j + 1) * nx + i + 1], D = F[(j + 1) * nx + i];
    const idx = (A >= level ? 1 : 0) | (B >= level ? 2 : 0) | (C >= level ? 4 : 0) | (D >= level ? 8 : 0);
    if (idx === 0 || idx === 15) continue;
    const edges = [['h', i, j], ['v', i + 1, j], ['h', i, j + 1], ['v', i, j]]; // bottom, right, top, left
    const ctr = (A + B + C + D) / 4 >= level;
    const T = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: ctr ? [[3, 2], [0, 1]] : [[3, 0], [1, 2]],
      6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 10: ctr ? [[0, 3], [1, 2]] : [[0, 1], [2, 3]],
      11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]] };
    for (const [p, q] of T[idx]) link(edgePoint(...edges[p]), edgePoint(...edges[q]));
  }
  const seen = new Set(), rings = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const ring = []; let prev = null, cur = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur); ring.push(pts.get(cur));
      const next = adj.get(cur).find(n => n !== prev && !seen.has(n)); prev = cur; cur = next;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}
function chaikin(ring, iters) {
  let r = ring;
  for (let n = 0; n < iters; n++) {
    const out = [];
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]], [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
    }
    r = out;
  }
  return r;
}
function anomalyRings(rows) {
  const W = Math.round((FIELD.lon1 - FIELD.lon0) / FIELD.step) + 1, H = Math.round((FIELD.lat1 - FIELD.lat0) / FIELD.step) + 1;
  const nx = W + 2, ny = H + 2, F = new Float32Array(nx * ny).fill(-1); // 1-cell border below the level closes every contour
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++)
    F[(j + 1) * nx + i + 1] = fieldValue(rows, FIELD.lat0 + j * FIELD.step, FIELD.lon0 + i * FIELD.step);
  return contourRings(F, nx, ny, ANOMALY_Z).map(r => chaikin(r, 2)
    .map(([x, y]) => [FIELD.lat0 + (y - 1) * FIELD.step, FIELD.lon0 + (x - 1) * FIELD.step]));
}
function nearestStation(rows, ll) {
  let best = null, bd = Infinity;
  const c = Math.cos(ll.lat * Math.PI / 180);
  rows.forEach(r => { const d = (r.st.lat - ll.lat) ** 2 + ((r.st.lng - ll.lng) * c) ** 2; if (d < bd) { bd = d; best = r; } });
  return best;
}
// WaterWatch-style classification: the same "much below/below/normal/above/much above normal"
// bucketing USGS uses for streamflow-vs-historical-percentile, applied here to the z-score.
function classify(z) {
  const a = Math.abs(z), sign = z >= 0 ? 'above' : 'below';
  if (a < 0.5) return 'Normal';
  if (a < 1.5) return `${sign[0].toUpperCase()}${sign.slice(1)} normal`;
  if (a < 2.5) return `Much ${sign} normal`;
  return `Extreme${sign === 'above' ? ' high' : ' low'}`;
}
function stationPopup(r, n) {
  return `<b>Anomaly zone</b> — nearest station: ${r.st.name}<br>Classification: <b>${classify(r.topName === 'temperature' ? r.zT : r.topZ)}</b> (${r.topName})<br>` +
    `Anomaly Severity Index: ${Math.min(100, Math.round(100 * r.topZ / 3))}<br>` +
    `Strongest deviation: ${r.topName} (${r.topZ.toFixed(1)}σ)<br>` +
    `Today's mean temp: ${r.tMid.toFixed(0)}°F (normal ${r.mu.toFixed(0)}°F ± ${r.sd.toFixed(0)})<br>` +
    `Peak wind: ${r.wMax.toFixed(0)} mph (${r.zW >= 0 ? '+' : ''}${r.zW.toFixed(1)}σ)<br>` +
    `3-hr pressure change: ${(-r.drop3).toFixed(1)} hPa<br>Humidity: ${r.d.current.relative_humidity_2m}%<br>` +
    `<i>Period of record: 8-yr same-week baseline · zone interpolated between ${n} stations</i>`;
}

// Real historical same-week data per year, as a small inline SVG bar chart — the one place on this
// page closest to an actual USGS/NOAA station dashboard: period-of-record data, not a mock-up.
// The final bar is today's actual reading (not a same-week average like the rest), so the chart
// always reaches the current year instead of stopping at last year's data.
function sparkChart(years, yearly, mu, currentYear, currentVal) {
  const allYears = [...(years || []), currentYear];
  const allVals = [...(yearly || []), currentVal];
  const w = 190, h = 54, pad = 14, n = allVals.length;
  const vals = allVals.filter(v => v != null);
  if (vals.length < 2) return '';
  const lo = Math.min(...vals, mu), hi = Math.max(...vals, mu);
  const span = Math.max(hi - lo, 1);
  const bw = (w - pad) / n;
  const y = v => h - 10 - ((v - lo) / span) * (h - 20);
  const bars = allVals.map((v, i) => {
    if (v == null) return '';
    const x = pad + i * bw, bh = (h - 10) - y(v);
    const isNow = i === n - 1; // today's actual reading, not a historical year average
    const fill = isNow ? '#F3EFE4' : 'rgba(232,184,75,0.45)';
    const stroke = isNow ? ' stroke="#E8B84B" stroke-width="1"' : '';
    return `<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${Math.max(bh, 1).toFixed(1)}" fill="${fill}"${stroke}/>` +
      `<text x="${(x + bw / 2 - 1.5).toFixed(1)}" y="${h - 1}" font-size="7" fill="${isNow ? '#E8B84B' : 'rgba(245,242,232,0.55)'}" text-anchor="middle">${isNow ? 'now' : String(allYears[i]).slice(2)}</text>`;
  }).join('');
  const muY = y(mu).toFixed(1);
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="margin-top:4px">` +
    `<line x1="${pad}" y1="${muY}" x2="${w}" y2="${muY}" stroke="rgba(245,242,232,0.35)" stroke-dasharray="2,2"/>` +
    bars + `</svg>`;
}
function stationDashboard(r) {
  if (r.noBaseline) return stationBasic(r);
  const isTemp = r.topName === 'temperature';
  const cls = classify(isTemp ? r.zT : r.topName === 'wind' ? r.zW : r.topZ);
  const nowYear = new Date().getFullYear();
  const chart = isTemp ? sparkChart(r.years, r.yearlyTemp, r.mu, nowYear, r.tMid)
    : r.topName === 'wind' ? sparkChart(r.years, r.yearlyWind, r.windMu, nowYear, r.wMax) : '';
  const chartLabel = isTemp ? 'Same-week mean temp' : 'Same-week peak wind';
  const tr = trendOf(r.years, isTemp ? r.yearlyTemp : r.yearlyWind), trendLine = tr ? `${fmtTrend(tr, isTemp ? '°F' : ' mph')} over ${tr.n} yrs${tr.p < 0.05 ? '' : ' (not significant)'}` : '';
  return `<b>${r.st.name}</b><br>Classification: <b>${cls}</b> (${r.topName})<br>` +
    `Today: ${r.tMid.toFixed(0)}°F &nbsp; Normal: ${r.mu.toFixed(0)}°F ± ${r.sd.toFixed(0)}<br>` +
    `Peak wind: ${r.wMax.toFixed(0)} mph (normal ${r.windMu.toFixed(0)} ± ${r.windSd.toFixed(0)}, ${r.zW >= 0 ? '+' : ''}${r.zW.toFixed(1)}σ)<br>` +
    `<span style="font-size:0.72rem;opacity:0.85">${pctText(isTemp ? r.zT : r.zW, isTemp)}</span><br>` +
    (trendLine ? `<span style="font-size:0.72rem;opacity:0.85">Trend: ${trendLine}</span><br>` : '') +
    (chart ? `<div style="font-size:0.7rem;opacity:0.7;margin-top:2px">${chartLabel}, past ${r.years.length} yrs + today (dashed = normal):</div>${chart}`
           : '<i>Not enough years of history for this station yet</i>') +
    `<div style="margin-top:6px"><button class="cmp-add" data-st="${encodeURIComponent(r.st.name)}">+ Compare</button> <span style="font-size:0.66rem;opacity:0.6">or shift-click a dot</span></div>`;
}

function describeError(e) {
  const m = String((e && e.message) || e);
  if (/cooling/.test(m)) return 'baseline paused briefly after a failed fetch';
  if (/429/.test(m)) return 'rate-limited by Open-Meteo (free-tier limit)';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'could not reach Open-Meteo';
  return 'internal error: ' + m;
}
function stationBasic(r) {
  return `<b>${r.st.name}</b><br><i>8-yr baseline isn't available right now, so this station can't be classified.</i><br>` +
    `Today's mean temp: ${r.tMid.toFixed(0)}°F<br>Peak wind: ${r.wMax.toFixed(0)} mph<br>` +
    `3-hr pressure change: ${(-r.drop3).toFixed(1)} hPa<br>Humidity: ${r.d.current.relative_humidity_2m}%`;
}
async function loadAnomalies() {
  const statusEl = document.getElementById('anomaly-status');
  try {
    // allSettled: a failed baseline must not throw away a perfectly good current-conditions response.
    const [climR, resR] = await Promise.allSettled([
      getClimatology(),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${LATS}&longitude=${LNGS}` +
        `&current=temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m&hourly=pressure_msl` +
        `&daily=temperature_2m_max,temperature_2m_min,wind_speed_10m_max&past_days=1&forecast_days=1&${UNITS}`)
    ]);
    if (resR.status !== 'fulfilled') throw resR.reason;
    if (!resR.value.ok) throw new Error('forecast ' + resR.value.status);
    const j = await resR.value.json();
    const data = Array.isArray(j) ? j : [j];
    const clim = climR.status === 'fulfilled' ? climR.value : null;
    if (!clim) console.warn('Baseline climatology unavailable:', climR.reason);

    const rows = stations.map((st, i) => {
      const d = data[i];
      if (!d || !d.daily || !d.current) return null;
      const c = clim && clim[i];
      const dayIdx = d.daily.time.indexOf(d.current.time.slice(0, 10));
      const di = dayIdx >= 0 ? dayIdx : d.daily.time.length - 1;
      const tMid = (d.daily.temperature_2m_max[di] + d.daily.temperature_2m_min[di]) / 2;
      const wMax = d.daily.wind_speed_10m_max[di];
      // Pressure tendency: a fall of ~4 hPa / 3 h is the conventional "rapidly falling" mark,
      // so it is scaled to z = 2 at that point.
      const hi = d.hourly.time.indexOf(d.current.time.slice(0, 13) + ':00');
      const drop3 = hi >= 3 ? d.hourly.pressure_msl[hi - 3] - d.hourly.pressure_msl[hi] : 0;
      if (!c || !c.temp || !c.wind) return { st, d, tMid, wMax, drop3, noBaseline: true, topName: '—', topZ: 0, zT: 0, zW: 0 };
      const zT = (tMid - c.temp.mu) / c.temp.sd;
      const zW = (wMax - c.wind.mu) / c.wind.sd;
      const zP = drop3 / 2;
      const comps = [['temperature', Math.abs(zT)], ['wind', Math.max(zW, 0)], ['pressure drop', Math.max(zP, 0)]];
      const [topName, topZ] = comps.reduce((a, b) => (b[1] > a[1] ? b : a));
      return { st, d, tMid, wMax, zT, zW, drop3, topName, topZ, mu: c.temp.mu, sd: c.temp.sd,
        windMu: c.wind.mu, windSd: c.wind.sd, yearlyTemp: c.yearlyTemp, yearlyWind: c.yearlyWind, years: c.years };
    }).filter(Boolean);
    const baseRows = rows.filter(r => !r.noBaseline);
    cmpRefresh(rows);   // keeps any station selection (and its numbers) current across refreshes

    anomalyLayer.clearLayers(); // discard last cycle's zones
    stationLayer.clearLayers();
    // WaterWatch-style colour-coded dots, one per station, sized/coloured by how far off normal it is.
    // Gray = no baseline yet (current conditions only). One bad station can never take the others down.
    const classColor = { 'Normal': '#8FAE83', 'Above normal': '#E8B84B', 'Below normal': '#7FA8C9',
      'Much above normal': '#E08A3C', 'Much below normal': '#4F7FA8', 'Extreme high': '#FF3B3B', 'Extreme low': '#A63DFF' };
    rows.forEach(r => {
      try {
        const base = !r.noBaseline;
        const color = base ? (classColor[classify(r.topName === 'temperature' ? r.zT : r.topZ)] || '#8FAE83') : '#7C8A94';
        const m = L.circleMarker([r.st.lat, r.st.lng], {
          pane: 'stationPane', radius: base ? 5 + Math.min(4, Math.abs(r.topZ)) : 5, color: '#12160F', weight: 1, fillColor: color, fillOpacity: base ? 0.9 : 0.75
        });
        const popup = L.popup({ maxWidth: 270 }).setContent(base ? stationDashboard(r) : stationBasic(r));
        m.on('click', ev => {   // plain click = popup; shift/ctrl/cmd-click = add to / remove from the comparison
          L.DomEvent.stop(ev); const oe = ev.originalEvent;
          if (base && oe && (oe.shiftKey || oe.ctrlKey || oe.metaKey)) { cmpToggle(r.st.name); return; }
          popup.setLatLng(m.getLatLng()).openOn(map);
        });
        m.addTo(stationLayer);
      } catch (err) { console.error('Station marker failed for', r.st.name, err); }
    });
    const hot = baseRows.filter(r => r.topZ >= ANOMALY_Z).sort((x, y) => y.topZ - x.topZ);
    const rings = baseRows.length ? anomalyRings(baseRows) : [];
    if (rings.length) {
      // One polygon (evenodd) so enclosed rings become holes. Shapes come from the interpolated field.
      const poly = L.polygon(rings, { color: '#FF3B3B', weight: 1.2, dashArray: '2,4', fillOpacity: 0.55, bubblingMouseEvents: false });
      poly.on('add', () => { const el = poly.getElement(); if (el) el.setAttribute('fill', 'url(#stipple)'); });
      poly.on('click', ev => L.popup().setLatLng(ev.latlng)
        .setContent(stationPopup(nearestStation(baseRows, ev.latlng), baseRows.length)).openOn(map));
      poly.addTo(anomalyLayer);
      const el = poly.getElement(); if (el) el.setAttribute('fill', 'url(#stipple)');
    }
    if (!baseRows.length) {
      const why = describeError(climR.reason);
      statusEl.textContent = `partial — baseline ${/rate/.test(why) ? 'rate-limited' : 'unavailable'}, current conditions only`;
      liveTicker.anomalies = [`ANOMALY WATCH — baseline history unavailable (${why}); showing current conditions only, will retry.`];
    } else {
      const top = baseRows.slice().sort((x, y) => y.topZ - x.topZ)[0];
      statusEl.textContent = `live — ${baseRows.length} stations, ${hot.length} flagged`;
      liveTicker.anomalies = [hot.length === 0
        ? `ANOMALY WATCH — ${baseRows.length} stations checked, none beyond ${ANOMALY_Z}σ` +
          (top ? ` (largest: ${top.st.name}, ${top.topName} ${top.topZ.toFixed(1)}σ)` : '')
        : `ANOMALY WATCH — ${hot.length} station${hot.length > 1 ? 's' : ''} beyond ${ANOMALY_Z}σ: ` +
          hot.slice(0, 6).map(r => `${r.st.name} (${r.topName} ${r.topZ.toFixed(1)}σ)`).join(', ') +
          (hot.length > 6 ? `, +${hot.length - 6} more` : '')];
    }
  } catch (e) {
    console.error('Anomaly check failed', e);
    const why = describeError(e);
    statusEl.textContent = /rate/.test(why) ? 'rate-limited — retrying later' : /reach/.test(why) ? 'unavailable (network)' : 'error — see console';
    liveTicker.anomalies = [`Anomaly check unavailable — ${why}.`];
  }
  renderTicker();
  stampLastUpdated();
}
