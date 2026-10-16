/* ---------- WIZARD WARNINGS: nationwide live NWS alerts, pulsating ---------- */
const BOLT_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#FF3B3B" d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z"/></svg>';
const ALERT_RANK = { 'Tornado Warning': 0, 'Severe Thunderstorm Warning': 1, 'Tornado Watch': 2, 'Severe Thunderstorm Watch': 3 };
async function loadWarnings() {
  const statusEl = document.getElementById('warning-status');
  try {
    const events = Object.keys(ALERT_RANK).map(encodeURIComponent).join(',');
    const res = await fetch(`https://api.weather.gov/alerts/active?status=actual&message_type=alert&event=${events}`,
      { headers: { 'Accept': 'application/geo+json' } });
    if (!res.ok) throw new Error('nws ' + res.status);
    const data = await res.json();
    const alerts = (data.features || []).slice()
      .sort((a, b) => (ALERT_RANK[a.properties.event] ?? 9) - (ALERT_RANK[b.properties.event] ?? 9));

    warningLayer.clearLayers(); // discard last cycle's alerts
    alerts.forEach(f => {
      if (!f.geometry) return; // zone-based watches have no polygon; they still appear in the ticker
      const p = f.properties;
      const gj = L.geoJSON(f.geometry, { style: { color: '#FF3B3B', weight: 2, fillColor: '#FF3B3B', fillOpacity: 0.35, className: 'pulse-path' } })
        .bindPopup(`<b>${p.event}</b><br>${p.areaDesc}`).addTo(warningLayer);
      // Polygons are tiny at continental zoom, so add a pulsing bolt at each centre.
      const icon = L.divIcon({ html: `<span class="bolt-icon">${BOLT_SVG}</span>`, className: '', iconSize: [26, 26] });
      L.marker(gj.getBounds().getCenter(), { icon }).bindPopup(`<b>${p.event}</b><br>${p.areaDesc}`).addTo(warningLayer);
    });

    statusEl.textContent = `live — ${alerts.length} active`;
    const short = s => { const t = s.split(';').slice(0, 2).join(',').trim(); return t.length > 70 ? t.slice(0, 67) + '…' : t; };
    const shown = alerts.slice(0, 10).map(f => `⚡ ${f.properties.event.toUpperCase()} — ${short(f.properties.areaDesc)}`);
    if (alerts.length > 10) shown.push(`+${alerts.length - 10} more active alerts`);
    liveTicker.warnings = alerts.length === 0
      ? ['No active tornado or severe thunderstorm alerts in the US right now.'] : shown;
  } catch (e) {
    console.error('NWS fetch failed', e);
    statusEl.textContent = 'unavailable right now';
    liveTicker.warnings = ['Could not reach api.weather.gov for current warnings.'];
  }
  renderTicker();
  stampLastUpdated();
}
