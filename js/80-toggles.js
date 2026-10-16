/* ---------- Layer toggles ---------- */
document.getElementById('toggle-baseline').addEventListener('change', e => {
  if (e.target.checked) { baselineLayer.addTo(map); flavorLayer.addTo(map); }
  else { map.removeLayer(baselineLayer); map.removeLayer(flavorLayer); }
});
document.getElementById('toggle-anomaly').addEventListener('change', e => e.target.checked ? anomalyLayer.addTo(map) : map.removeLayer(anomalyLayer));
document.getElementById('toggle-stations').addEventListener('change', e => e.target.checked ? stationLayer.addTo(map) : map.removeLayer(stationLayer));
document.getElementById('toggle-birds').addEventListener('change', e => e.target.checked ? birdLayer.addTo(map) : map.removeLayer(birdLayer));
document.getElementById('toggle-warning').addEventListener('change', e => e.target.checked ? warningLayer.addTo(map) : map.removeLayer(warningLayer));
