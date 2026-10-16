/* ---------- STATION COMPARISON: pick up to 6 stations and chart them against each other ----------
   Shift/Ctrl/Cmd-click a station dot, or press "+ Compare" in its popup. Everything plotted is the same real
   period-of-record data the popups use (8 yearly same-week means + today's reading). The statistics are plain:
   percentile (normal approximation to the past same-week days) and a Theil-Sen trend with a Mann-Kendall test. */
const CMP_MAX = 6, CMP_COLORS = ['#5FD0C8', '#E8B84B', '#E056E0', '#FF8A5B', '#7FB2FF', '#C9F26B'];
const cmp = { sel: [], rows: new Map(), v: 'temp', mode: 'actual', min: false, msg: '' };
const cmpRingLayer = L.layerGroup().addTo(map);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* --- statistics --- */
function erf(x) {   // Abramowitz-Stegun 7.1.26
  const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
const phi = z => 0.5 * (1 + erf(z / Math.SQRT2));
function theilSen(xs, ys) {   // median of all pairwise slopes; robust to one odd year
  const sl = []; for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (xs[j] !== xs[i]) sl.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
  if (!sl.length) return null; sl.sort((a, b) => a - b); const m = sl.length >> 1; return sl.length % 2 ? sl[m] : (sl[m - 1] + sl[m]) / 2;
}
function mannKendallP(ys) {   // two-sided p, continuity-corrected normal approximation (no tie correction)
  const n = ys.length; let S = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) S += Math.sign(ys[j] - ys[i]);
  const v = n * (n - 1) * (2 * n + 5) / 18, z = S === 0 ? 0 : (S - Math.sign(S)) / Math.sqrt(v);
  return 2 * (1 - phi(Math.abs(z)));
}
function trendOf(years, vals) {   // -> {perDecade, p, n} or null when there isn't enough history
  const xs = [], ys = []; vals.forEach((v, i) => { if (v != null) { xs.push(years[i]); ys.push(v); } });
  if (xs.length < 5) return null;
  return { perDecade: theilSen(xs, ys) * 10, p: mannKendallP(ys), n: xs.length };
}
function fmtTrend(t, unit) {
  if (!t) return '—';
  const v = t.perDecade; return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}${unit}/dec${t.p < 0.05 ? '*' : ''}`;
}
function pctText(z, isTemp) {   // "Warmer than ≈N% of past same-week days"
  const p = Math.max(1, Math.min(99, Math.round(100 * phi(z))));
  return `${isTemp ? (z >= 0 ? 'Warmer' : 'Cooler') : (z >= 0 ? 'Windier' : 'Calmer')} than ≈${z >= 0 ? p : 100 - p}% of past same-week days`;
}
function cmpSeries(r) {   // everything one station contributes for the current variable
  const t = cmp.v === 'temp';
  return { yearly: t ? r.yearlyTemp : r.yearlyWind, now: t ? r.tMid : r.wMax, mu: t ? r.mu : r.windMu, sd: t ? r.sd : r.windSd, z: t ? r.zT : r.zW, unit: t ? '°F' : ' mph' };
}

/* --- selection --- */
function cmpToggle(name) {
  const i = cmp.sel.indexOf(name); cmp.msg = '';
  if (i >= 0) cmp.sel.splice(i, 1);
  else if (!cmp.rows.has(name)) cmp.msg = `${name} has no baseline right now, so it can't be compared.`;
  else if (cmp.sel.length >= CMP_MAX) cmp.msg = `Up to ${CMP_MAX} stations at a time — remove one first.`;
  else cmp.sel.push(name);
  cmpRender();
}
function cmpRefresh(rows) {   // called after every anomaly refresh so a selection survives updates
  cmp.rows = new Map(rows.filter(r => !r.noBaseline).map(r => [r.st.name, r]));
  cmp.sel = cmp.sel.filter(n => cmp.rows.has(n)); cmpRender();
}

/* --- chart --- */
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }
function cmpChart(rowsSel) {
  const W = 372, H = 176, L0 = 36, R0 = 8, T0 = 8, B0 = 20;
  const years = rowsSel[0].years, n = years.length + 1, delta = cmp.mode === 'delta';
  const S = rowsSel.map(r => { const s = cmpSeries(r), off = delta ? s.mu : 0; return { r, s, ys: s.yearly.map(v => v == null ? null : v - off), now: s.now - off }; });
  const all = S.flatMap(o => [...o.ys.filter(v => v != null), o.now]).concat(delta ? [0] : []);
  let lo = Math.min(...all), hi = Math.max(...all); const pad = Math.max((hi - lo) * 0.12, 0.5); lo -= pad; hi += pad;
  const step = niceStep((hi - lo) / 4), t0 = Math.ceil(lo / step) * step;
  const x = i => L0 + (i + 0.5) / n * (W - L0 - R0), y = v => T0 + (1 - (v - lo) / (hi - lo)) * (H - T0 - B0);
  let g = '';
  for (let tv = t0; tv <= hi; tv += step) g += `<line x1="${L0}" x2="${W - R0}" y1="${y(tv).toFixed(1)}" y2="${y(tv).toFixed(1)}" stroke="rgba(245,242,232,${delta && Math.abs(tv) < 1e-9 ? 0.45 : 0.12})"${delta && Math.abs(tv) < 1e-9 ? '' : ' stroke-dasharray="2,3"'}/>` +
    `<text x="${L0 - 4}" y="${(y(tv) + 3).toFixed(1)}" font-size="9" fill="rgba(245,242,232,0.6)" text-anchor="end">${+tv.toFixed(2)}</text>`;
  years.forEach((yr, i) => { g += `<text x="${x(i).toFixed(1)}" y="${H - 6}" font-size="9" fill="rgba(245,242,232,0.6)" text-anchor="middle">${String(yr).slice(2)}</text>`; });
  const xn = x(n - 1), nowYear = new Date().getFullYear();
  g += `<line x1="${((x(n - 2) + xn) / 2).toFixed(1)}" x2="${((x(n - 2) + xn) / 2).toFixed(1)}" y1="${T0}" y2="${H - B0}" stroke="rgba(245,242,232,0.25)"/>` +
    `<text x="${xn.toFixed(1)}" y="${H - 6}" font-size="9" fill="#E8B84B" text-anchor="middle">now</text>`;
  S.forEach((o, k) => {
    const c = CMP_COLORS[cmp.sel.indexOf(o.r.st.name)], pts = o.ys.map((v, i) => v == null ? null : [x(i), y(v)]);
    let d = '', pen = false; pts.forEach(p => { if (!p) { pen = false; return; } d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`; pen = true; });
    g += `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>` +
      pts.filter(Boolean).map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2" fill="${c}"/>`).join('') +
      `<circle cx="${xn.toFixed(1)}" cy="${y(o.now).toFixed(1)}" r="4" fill="#12160F" stroke="${c}" stroke-width="2"><title>${esc(o.r.st.name)} today: ${o.s.now.toFixed(1)}${o.s.unit}</title></circle>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Comparison chart of ${S.length} stations">${g}</svg>`;
}

/* --- card --- */
function cmpEnsureCard() {
  let el = document.getElementById('cmp-card'); if (el) return el;
  el = document.createElement('div'); el.id = 'cmp-card'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Station comparison');
  map.getContainer().appendChild(el); L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el);
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return; const a = b.dataset.act;
    if (a === 'min') cmp.min = !cmp.min; else if (a === 'clear') { cmp.sel = []; cmp.msg = ''; }
    else if (a === 'var') cmp.v = b.dataset.val; else if (a === 'mode') cmp.mode = b.dataset.val;
    else if (a === 'rm') { cmp.sel = cmp.sel.filter(n => n !== decodeURIComponent(b.dataset.val)); cmp.msg = ''; }
    cmpRender();
  });
  let drag = null;   // drag by the header
  el.addEventListener('pointerdown', e => { const h = e.target.closest('.cmp-head'); if (!h || e.target.closest('button')) return;
    const r = el.getBoundingClientRect(), m = map.getContainer().getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, m }; h.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => { if (!drag) return;
    const m = drag.m, w = el.offsetWidth, hgt = el.offsetHeight;
    el.style.left = Math.max(0, Math.min(m.width - w, e.clientX - m.left - drag.dx)) + 'px'; el.style.top = Math.max(0, Math.min(m.height - hgt, e.clientY - m.top - drag.dy)) + 'px';
    el.style.right = 'auto'; });
  el.addEventListener('pointerup', () => { drag = null; });
  return el;
}
function cmpRender() {
  cmpRingLayer.clearLayers();
  const el = cmpEnsureCard(), rowsSel = cmp.sel.map(n => cmp.rows.get(n)).filter(Boolean);
  if (!cmp.sel.length && !cmp.msg) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  rowsSel.forEach(r => L.circleMarker([r.st.lat, r.st.lng], { pane: 'stationPane', radius: 12, color: CMP_COLORS[cmp.sel.indexOf(r.st.name)], weight: 3, fill: false, interactive: false }).addTo(cmpRingLayer));
  const tog = (act, val, cur, label) => `<button data-act="${act}" data-val="${val}" aria-pressed="${cur === val}" class="${cur === val ? 'on' : ''}">${label}</button>`;
  let h = `<div class="cmp-head"><b>Compare stations</b><span>${cmp.sel.length}/${CMP_MAX}</span>` +
    `<button data-act="clear" title="Remove all">Clear</button><button data-act="min" title="${cmp.min ? 'Expand' : 'Minimise'}" aria-label="${cmp.min ? 'Expand' : 'Minimise'}">${cmp.min ? '▢' : '–'}</button></div>`;
  if (!cmp.min) {
    if (rowsSel.length) {
      const isT = cmp.v === 'temp', unit = isT ? '°F' : ' mph';
      h += `<div class="cmp-ctl"><span class="seg">${tog('var', 'temp', cmp.v, 'Temperature')}${tog('var', 'wind', cmp.v, 'Peak wind')}</span><span class="seg">${tog('mode', 'actual', cmp.mode, 'Actual')}${tog('mode', 'delta', cmp.mode, 'vs normal')}</span></div>` +
        cmpChart(rowsSel) +
        `<table class="cmp-tab"><thead><tr><th>Station</th><th>Now</th><th>vs normal</th><th>Pctl</th><th>Trend</th></tr></thead><tbody>` +
        rowsSel.map(r => { const s = cmpSeries(r), c = CMP_COLORS[cmp.sel.indexOf(r.st.name)], d = s.now - s.mu, p = Math.max(1, Math.min(99, Math.round(100 * phi(s.z)))), tr = trendOf(r.years, s.yearly);
          return `<tr><td><i style="background:${c}"></i>${esc(r.st.name)}<button data-act="rm" data-val="${encodeURIComponent(r.st.name)}" aria-label="Remove ${esc(r.st.name)}">×</button></td>` +
            `<td>${s.now.toFixed(0)}${s.unit}</td><td>${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} (${s.z >= 0 ? '+' : '−'}${Math.abs(s.z).toFixed(1)}σ)</td><td>P${p}</td><td>${fmtTrend(tr, s.unit)}</td></tr>`; }).join('') + `</tbody></table>` +
        `<div class="cmp-note">Lines = same-week mean for each past year; hollow dot = today's reading. Pctl = how today ranks against past same-week days (normal approximation). Trend = Theil–Sen slope of the yearly means; * = Mann–Kendall p &lt; 0.05. With only ${rowsSel[0].years.length} years this is thin evidence — a hint, not a finding.</div>`;
    } else h += `<div class="cmp-note">Shift-click station dots (or use "+ Compare" in a popup) to add up to ${CMP_MAX}.</div>`;
    if (cmp.msg) h += `<div class="cmp-msg">${esc(cmp.msg)}</div>`;
  }
  el.innerHTML = h;
}
map.on('popupopen', e => {   // wire the "+ Compare" button inside station popups
  const root = e.popup.getElement(); if (!root) return; const b = root.querySelector('.cmp-add'); if (!b) return;
  const name = decodeURIComponent(b.dataset.st), sync = () => { b.textContent = cmp.sel.includes(name) ? '✓ In comparison' : '+ Compare'; };
  sync(); b.addEventListener('click', () => { cmpToggle(name); sync(); });
});
