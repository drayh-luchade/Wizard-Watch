/* ---------- LIVE-DATA LAYERS ----------
   Nothing live is stored in this repo. Everything below is fetched in the visitor's browser
   on load and on a refresh timer, and drawn into layer groups that are cleared and redrawn
   each cycle, so stale data is discarded automatically. The only thing persisted is a tiny
   per-station climatology summary in localStorage, which expires and prunes itself.
   Data sources: api.weather.gov (NWS alerts), open-meteo.com (current/forecast + 10-yr archive). */

const anomalyLayer = L.layerGroup().addTo(map);
const warningLayer = L.layerGroup().addTo(map);
const stationLayer = L.layerGroup().addTo(map);
const birdLayer = L.layerGroup().addTo(map);

const ANOMALY_Z = 2;            // |z| >= 2 standard deviations counts as a real deviation from baseline
const CLIM_YEARS = 8;           // years of history used for the baseline (kept modest for Open-Meteo's free-tier limits)
const CLIM_WINDOW_DAYS = 7;     // +/- days around today's calendar date, per year
const CLIM_TTL_MS = 7 * 24 * 3600 * 1000;
const REFRESH_WARNINGS_MS = 2 * 60 * 1000;
const REFRESH_ANOMALY_MS = 30 * 60 * 1000;

// 43 stations, one small archive request per year of history (43 locations x ~15 days each), which
// stays inside Open-Meteo's free-tier per-minute weighting. The result is cached, so it runs about weekly.
const stations = [
  ['Seattle',47.61,-122.33],['Portland',45.52,-122.68],['Boise',43.62,-116.20],['San Francisco',37.77,-122.42],
  ['Los Angeles',34.05,-118.24],['San Diego',32.72,-117.16],['Las Vegas',36.17,-115.14],['Phoenix',33.45,-112.07],
  ['Salt Lake City',40.76,-111.89],['Billings',45.78,-108.50],['Denver',39.74,-104.99],['Albuquerque',35.08,-106.65],
  ['El Paso',31.76,-106.49],['Rapid City',44.08,-103.23],['Fargo',46.88,-96.79],['Omaha',41.26,-95.93],
  ['Kansas City',39.10,-94.58],['Oklahoma City',35.47,-97.52],['Amarillo',35.22,-101.83],['Dallas',32.78,-96.80],
  ['San Antonio',29.42,-98.49],['Houston',29.76,-95.37],['Minneapolis',44.98,-93.27],['Des Moines',41.59,-93.62],
  ['Chicago',41.88,-87.63],['Detroit',42.33,-83.05],['Indianapolis',39.77,-86.16],['St. Louis',38.63,-90.20],
  ['Columbus',39.96,-83.00],['Little Rock',34.75,-92.29],['New Orleans',29.95,-90.07],['Memphis',35.15,-90.05],
  ['Nashville',36.16,-86.78],['Birmingham',33.52,-86.80],['Atlanta',33.75,-84.39],['Jacksonville',30.33,-81.66],
  ['Miami',25.76,-80.19],['Charlotte',35.23,-80.84],['Washington DC',38.91,-77.04],['Pittsburgh',40.44,-79.99],
  ['New York',40.71,-74.01],['Boston',42.36,-71.06],['Buffalo',42.89,-78.88],
].map(([name, lat, lng]) => ({ name, lat, lng }));
const LATS = stations.map(s => s.lat).join(',');
const LNGS = stations.map(s => s.lng).join(',');
const UNITS = 'temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto';

/* ---------- WIZARD WIRE ticker (bottom of map) ---------- */
// Edit tickerLines with your own fake ads / shoutouts. Live warning and anomaly
// status lines are placed in front of them automatically.
const tickerLines = [
  "SPONSORED — Ye Olde Leather Emporium: snakeskin boots, 20% off through the equinox",
  "Norman Coven Potluck this Friday — bring your own cauldron",
  "Lost familiar: grey owl, answers to 'Gerald', last seen near Lake Thunderbird",
  "SPONSORED — Cavern Realty: karst-adjacent lots now leasing, multiplier included",
];
const liveTicker = { warnings: ['Checking for active storm alerts…'], anomalies: ['Running anomaly check…'], birds: ['Checking bird migration activity…'] };
const TICKER_SPEED = 100; // pixels per second
let lastTickerKey = '';
function renderTicker() {
  const lines = [...liveTicker.warnings, ...liveTicker.anomalies, ...liveTicker.birds, ...tickerLines];
  const key = lines.join('|');
  if (key === lastTickerKey) return; // don't restart the crawl unless the content changed
  lastTickerKey = key;
  const track = document.getElementById('ticker-track');
  track.style.animation = 'none';
  const joined = lines.map(t => `<span>${t}</span>`).join('<span class="sep">✦</span>');
  track.innerHTML = joined + '<span class="sep">✦</span>' + joined; // duplicated for a seamless loop
  requestAnimationFrame(() => {
    const halfWidth = track.scrollWidth / 2;
    track.style.animation = `ticker ${Math.max(halfWidth / TICKER_SPEED, 4)}s linear infinite`;
  });
}
renderTicker();
