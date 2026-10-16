/* ---------- BIRD MIGRATION: live per-radar nocturnal migration intensity ----------
   Source: Purdue AeroEco Lab's public data sheet behind their "Lights Out" flow-map
   (aeroecolab.com/uslights), itself derived from NEXRAD weather radar per Van Doren & Horton 2018.
   avg_bird_density = birds/km³, speed = m/s (ground speed), direction = compass bearing birds are
   heading, height = altitude in meters, traffic = a cumulative hourly movement-rate figure. Radar
   coordinates come from MetPy's station table, matched 143/143 against the real radar_id values. */
const BIRD_CSV_URL = 'https://docs.google.com/spreadsheets/d/1-kd403bKmHO2P4hviCu20asyhR8w1XbLYmdhuIQ8JDE/export?format=csv&gid=800143826';
const BIRD_STALE_MS = 3 * 3600 * 1000; // flag as stale rather than silently showing old data as current
function densityBucket(d) {
  if (d <= 0) return { label: 'None detected', color: '#3A4A52' };
  if (d <= 4) return { label: 'Low', color: '#4FA8A0' };
  if (d <= 8) return { label: 'Moderate', color: '#E8B84B' };
  if (d <= 13) return { label: 'High', color: '#E0763C' };
  return { label: 'Extreme', color: '#C94FC9' };
}
function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {}; headers.forEach((h, i) => row[h] = cells[i]); return row;
  });
}
function birdIcon(color, dirDeg, hasArrow) {
  const arrow = hasArrow
    ? `<svg viewBox="0 0 20 20" width="20" height="20" style="transform:rotate(${dirDeg}deg)">
         <circle cx="10" cy="10" r="6" fill="${color}" fill-opacity="0.35"/>
         <path d="M10 3 L13.5 12 L10 9.5 L6.5 12 Z" fill="${color}"/>
       </svg>`
    : `<svg viewBox="0 0 20 20" width="14" height="14"><circle cx="10" cy="10" r="5" fill="${color}" fill-opacity="0.7" stroke="${color}" stroke-width="1.5"/></svg>`;
  return L.divIcon({ html: `<span class="bird-arrow">${arrow}</span>`, className: '', iconSize: hasArrow ? [20, 20] : [14, 14] });
}
function birdPopup(id, st, row, staleMin) {
  if (row.avg_u_speed === 'radar_not_operational') {
    return `<b>${st.name}, ${st.state}</b> (${id})<br><i>Radar currently offline</i>`;
  }
  const density = parseFloat(row.avg_bird_density);
  const bucket = densityBucket(density);
  const staleNote = staleMin > 180 ? `<br><i>Last update ${Math.round(staleMin / 60)}h ago — may be stale</i>` : '';
  if (density <= 0) {
    return `<b>${st.name}, ${st.state}</b> (${id})<br>Operational — no migration currently detected${staleNote}`;
  }
  return `<b>${st.name}, ${st.state}</b> (${id})<br>Migration intensity: <b>${bucket.label}</b> (${density.toFixed(1)} birds/km³)<br>` +
    `Ground speed: ${row.speed} m/s, heading ${row.direction}°<br>Altitude: ${row.height} m &nbsp; Traffic rate: ${row.traffic}${staleNote}`;
}
async function loadBirds() {
  const statusEl = document.getElementById('bird-status');
  try {
    const res = await fetch(BIRD_CSV_URL);
    if (!res.ok) throw new Error('bird csv ' + res.status);
    const rows = parseCsv(await res.text());
    birdLayer.clearLayers();
    let offline = 0, active = 0, matched = 0, staleMin = 0;
    const top = [], vecs = [];
    rows.forEach(row => {
      const st = nexradStations[row.radar_id];
      if (!st) return;
      matched++;
      const validTime = Date.parse(row.interval_start_time.replace(' ', 'T') + 'Z');
      staleMin = Math.max(staleMin, (Date.now() - validTime) / 60000);
      const offlineRow = row.avg_u_speed === 'radar_not_operational';
      if (offlineRow) {
        offline++;
        L.marker([st.lat, st.lon], { icon: birdIcon('#555', 0, false), opacity: 0.6 })
          .bindPopup(birdPopup(row.radar_id, st, row, 0)).addTo(birdLayer);
        return;
      }
      active++;
      const density = parseFloat(row.avg_bird_density);
      const bucket = densityBucket(density);
      const hasArrow = density > 0 && row.direction !== 'N/A';
      L.marker([st.lat, st.lon], { icon: birdIcon(bucket.color, hasArrow ? parseFloat(row.direction) : 0, hasArrow) })
        .bindPopup(birdPopup(row.radar_id, st, row, (Date.now() - validTime) / 60000)).addTo(birdLayer);
      if (density > 0) top.push({ id: row.radar_id, name: st.name, state: st.state, density });
      if (!isNaN(density)) vecs.push({ lat: st.lat, lon: st.lon, u: parseFloat(row.avg_u_speed) || 0, v: parseFloat(row.avg_v_speed) || 0, density: Math.max(0, density) });
    });
    top.sort((a, b) => b.density - a.density);
    flowSetData(vecs);
    const staleTag = staleMin > 180 ? ` (data ~${Math.round(staleMin / 60)}h old)` : '';
    statusEl.textContent = `live — ${active} active, ${offline} offline${staleTag}`;
    liveTicker.birds = [top.length === 0
      ? 'BIRD MIGRATION — no significant activity detected at any station right now'
      : `BIRD MIGRATION — strongest activity: ${top.slice(0, 5).map(t => `${t.name}, ${t.state} (${t.density.toFixed(1)} birds/km³)`).join(', ')}`];
  } catch (e) {
    console.error('Bird migration fetch failed', e);
    statusEl.textContent = 'unavailable right now';
    liveTicker.birds = ['Bird migration data unavailable — could not reach the AeroEco Lab feed.'];
  }
  renderTicker();
  stampLastUpdated();
}

function stampLastUpdated() {
  const el = document.getElementById('last-updated');
  if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
// Manual refresh: re-fetches warnings + anomalies only. Does not touch the splash screen,
// the basemap, or the (static, pre-built) baseline density layer.
const refreshBtn = document.getElementById('refresh-btn');
let refreshing = false;
async function manualRefresh() {
  if (refreshing) return;
  refreshing = true;
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');
  try { updateSky(); await Promise.all([loadWarnings(), loadAnomalies(), loadBirds(), loadAether({ maxAgeMin: 30 })]); }
  finally { refreshBtn.disabled = false; refreshBtn.classList.remove('spinning'); refreshing = false; }
}
refreshBtn.addEventListener('click', manualRefresh);

const REFRESH_BIRDS_MS = 10 * 60 * 1000; // a good citizen's cadence for an unofficial research-lab feed
loadWarnings();
loadAnomalies();
loadBirds();
setInterval(() => { if (!document.hidden) loadWarnings(); }, REFRESH_WARNINGS_MS);
setInterval(() => { if (!document.hidden) loadAnomalies(); }, REFRESH_ANOMALY_MS);
setInterval(() => { if (!document.hidden) loadBirds(); }, REFRESH_BIRDS_MS);
