/* ═══════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════ */
const COLORS = [
  '#185FA5', '#0F6E56', '#993C1D',
  '#534AB7', '#993556', '#854F0B',
  '#1D9E75', '#378ADD'
];

const ALGO_NAMES = {
  nn2opt: 'NN + 2-Opt',
  nn:     'Nearest Neighbor',
  random: 'Random'
};

/* ═══════════════════════════════════════════════════
   MAP INITIALIZATION
═══════════════════════════════════════════════════ */
const map = L.map('map', { zoomControl: true })
  .setView([-7.6298, 111.5239], 13); // Madiun, East Java

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19
}).addTo(map);

/* ═══════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════ */
let cities    = [];    // Array of { lat, lng }
let markers   = [];    // Leaflet marker instances
let routeLine = null;  // Active polyline on map
let solving   = false; // Lock during animation
let activeKph = 40;    // Active travel speed (km/h)
let lastTour  = null;  // Last solved tour (for re-calc on mode change)
let lastD     = null;  // Last distance matrix

/* ═══════════════════════════════════════════════════
   ICON FACTORY
═══════════════════════════════════════════════════ */
function makeIcon(index) {
  const color = COLORS[index % COLORS.length];
  const svg = `
    <svg xmlns='http://www.w3.org/2000/svg' width='28' height='38' viewBox='0 0 28 38'>
      <path d='M14 0C6.27 0 0 6.27 0 14c0 10.5 14 24 14 24S28 24.5 28 14C28 6.27 21.73 0 14 0z'
            fill='${color}'/>
      <circle cx='14' cy='14' r='7' fill='white' opacity='0.92'/>
      <text x='14' y='18.5' font-size='9' font-weight='700' text-anchor='middle'
            fill='${color}' font-family='Arial,sans-serif'>${index + 1}</text>
    </svg>`;
  return L.divIcon({
    html: svg, className: '',
    iconSize: [28, 38], iconAnchor: [14, 38], popupAnchor: [0, -40]
  });
}

/* ═══════════════════════════════════════════════════
   MATH UTILITIES
═══════════════════════════════════════════════════ */

/**
 * Haversine formula — great-circle distance in metres.
 */
function haversine(a, b) {
  const R  = 6371000;
  const f1 = a.lat * Math.PI / 180;
  const f2 = b.lat * Math.PI / 180;
  const df = (b.lat - a.lat) * Math.PI / 180;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  const x  = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function buildMatrix(cs) {
  return cs.map(a => cs.map(b => haversine(a, b)));
}

function tourLen(tour, D) {
  let total = 0;
  for (let i = 0; i < tour.length; i++)
    total += D[tour[i]][tour[(i + 1) % tour.length]];
  return total;
}

/**
 * Segment distances along the tour (n segments, closing back to start).
 * @returns {number[]} metres per segment
 */
function segmentDistances(tour, D) {
  return tour.map((_, i) => D[tour[i]][tour[(i + 1) % tour.length]]);
}

/* ═══════════════════════════════════════════════════
   TIME FORMATTING
═══════════════════════════════════════════════════ */

/**
 * Convert metres + km/h → formatted duration string.
 * @param {number} metres
 * @param {number} kph
 * @returns {string} e.g. "1 j 23 m" or "45 mnt" or "30 dtk"
 */
function fmtTravelTime(metres, kph) {
  const hours   = metres / 1000 / kph;          // decimal hours
  const totalSec = Math.round(hours * 3600);

  if (totalSec < 60) {
    return `${totalSec}<span class="m-unit">dtk</span>`;
  }

  const h   = Math.floor(totalSec / 3600);
  const m   = Math.floor((totalSec % 3600) / 60);
  const s   = totalSec % 60;

  if (h > 0) {
    return `${h}<span class="m-unit">j</span> ${m}<span class="m-unit">mnt</span>`;
  }
  if (m >= 1 && s === 0) {
    return `${m}<span class="m-unit">mnt</span>`;
  }
  return `${m}<span class="m-unit">mnt</span> ${s}<span class="m-unit">dtk</span>`;
}

/**
 * Short time string for popups (plain text).
 * @returns {string} e.g. "1j 23mnt" or "45mnt" or "30dtk"
 */
function shortTime(metres, kph) {
  const totalSec = Math.round((metres / 1000 / kph) * 3600);
  if (totalSec < 60)  return `${totalSec} dtk`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}j ${m}mnt`;
  return `${m} mnt`;
}

/**
 * Format distance in metres.
 */
function fmtDist(metres) {
  if (metres >= 1000)
    return (metres / 1000).toFixed(2) + '<span class="m-unit">km</span>';
  return Math.round(metres) + '<span class="m-unit">m</span>';
}

/* ═══════════════════════════════════════════════════
   ALGORITHMS
═══════════════════════════════════════════════════ */
function nearestNeighbor(cs, D) {
  const n       = cs.length;
  const visited = new Array(n).fill(false);
  const tour    = [0];
  visited[0]    = true;
  for (let i = 1; i < n; i++) {
    const last = tour[tour.length - 1];
    let best = -1, bestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited[j] && D[last][j] < bestDist) { bestDist = D[last][j]; best = j; }
    }
    visited[best] = true;
    tour.push(best);
  }
  return tour;
}

function twoOpt(tour, D) {
  const n = tour.length;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = tour[i-1], b = tour[i], c = tour[j], d = tour[(j+1)%n];
        if (D[a][c] + D[b][d] < D[a][b] + D[c][d] - 1e-6) {
          let l = i, r = j;
          while (l < r) { [tour[l], tour[r]] = [tour[r], tour[l]]; l++; r--; }
          improved = true;
        }
      }
    }
  }
  return tour;
}

function randomTour(n) {
  const t = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}

/* ═══════════════════════════════════════════════════
   SOLVE
═══════════════════════════════════════════════════ */
function solve() {
  if (cities.length < 2 || solving) return;

  const algo = document.getElementById('algo-select').value;
  const D    = buildMatrix(cities);
  const t0   = performance.now();

  let tour, nnLength = 0;
  if (algo === 'nn2opt') {
    const nnTour = nearestNeighbor(cities, D).slice();
    nnLength     = tourLen(nnTour, D);
    tour         = twoOpt(nnTour, D);
  } else if (algo === 'nn') {
    tour = nearestNeighbor(cities, D);
  } else {
    tour = randomTour(cities.length);
  }

  const elapsed = performance.now() - t0;
  const length  = tourLen(tour, D);

  // Cache for re-use when mode changes
  lastTour = tour;
  lastD    = D;

  updateMetrics(tour, D, length, elapsed, nnLength, algo);
  updatePopups(tour, D);
  setStatus('Menganimasi rute...', 'amber');
  animateRoute(tour);
}

/* ═══════════════════════════════════════════════════
   UPDATE METRICS
═══════════════════════════════════════════════════ */
function updateMetrics(tour, D, length, elapsed, nnLength, algo) {
  document.getElementById('m-dist').innerHTML   = fmtDist(length);
  document.getElementById('m-travel').innerHTML = fmtTravelTime(length, activeKph);
  document.getElementById('m-time').innerHTML   =
    (elapsed !== null ? (elapsed < 1 ? '<1' : Math.round(elapsed)) : '—') +
    (elapsed !== null ? '<span class="m-unit">ms</span>' : '');

  if (algo === 'nn2opt' && nnLength > 0) {
    const pct = (nnLength - length) / nnLength * 100;
    document.getElementById('m-impr').innerHTML =
      (pct > 0 ? '-' : '') + Math.abs(pct).toFixed(1) + '<span class="m-unit">%</span>';
  } else if (algo) {
    document.getElementById('m-impr').textContent = '—';
  }

  document.getElementById('algo-badge').textContent  = ALGO_NAMES[algo] || ALGO_NAMES['nn2opt'];
  document.getElementById('state-badge').textContent = 'solved';
  document.getElementById('state-badge').className   = 'badge badge-green';
}

/* ═══════════════════════════════════════════════════
   ROUTE ANIMATION
═══════════════════════════════════════════════════ */
function animateRoute(tour) {
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  solving = true;

  const speed        = +document.getElementById('speed').value;
  const delayPerEdge = Math.max(30, Math.round(800 / tour.length / speed * 10));
  let step = 1;

  function tick() {
    if (step <= tour.length) {
      const pts = tour.slice(0, step + 1).map(i => [cities[i].lat, cities[i].lng]);
      if (routeLine) map.removeLayer(routeLine);
      routeLine = L.polyline(pts, { color: '#1D9E75', weight: 3, opacity: 0.85 }).addTo(map);
      step++;
      setTimeout(tick, delayPerEdge);
    } else {
      const closed = [...tour, tour[0]].map(i => [cities[i].lat, cities[i].lng]);
      if (routeLine) map.removeLayer(routeLine);
      routeLine = L.polyline(closed, { color: '#1D9E75', weight: 3, opacity: 0.85 }).addTo(map);
      solving = false;
      setStatus('Rute selesai. Klik peta untuk menambah kota atau ubah mode perjalanan.', 'green');
    }
  }
  tick();
}

/* ═══════════════════════════════════════════════════
   CITY MANAGEMENT
═══════════════════════════════════════════════════ */
function addCity(lat, lng) {
  const i = cities.length;
  cities.push({ lat, lng });

  const marker = L.marker([lat, lng], { icon: makeIcon(i), draggable: true })
    .bindPopup(makeCityPopup(i, null, null))
    .addTo(map);

  marker.on('dragend', function (ev) {
    cities[i] = { lat: ev.target.getLatLng().lat, lng: ev.target.getLatLng().lng };
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    lastTour = null; lastD = null;
    document.getElementById('state-badge').textContent = cities.length + ' kota';
    document.getElementById('state-badge').className   = 'badge badge-blue';
    setStatus('Kota dipindahkan. Klik Solve untuk memperbarui rute.', 'amber');
  });

  markers.push(marker);
  updateUI();
}

function clearAll() {
  markers.forEach(m => map.removeLayer(m));
  markers = []; cities = []; lastTour = null; lastD = null;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  ['m-dist','m-travel','m-time','m-impr'].forEach(id =>
    document.getElementById(id).textContent = '—');
  document.getElementById('state-badge').textContent = '0 kota';
  document.getElementById('state-badge').className   = 'badge badge-amber';
  updateUI();
}

/* ═══════════════════════════════════════════════════
   POPUP BUILDER
═══════════════════════════════════════════════════ */

/**
 * Build HTML popup for a city marker.
 * @param {number} cityIdx   - 0-based index in cities[]
 * @param {number|null} seq  - Position in route (1-based), null if not solved
 * @param {number|null} distToNext - metres to next stop, null if not solved
 */
function makeCityPopup(cityIdx, seq, distToNext) {
  const c = cities[cityIdx];
  const seqStr      = seq      !== null ? `#${seq}`                        : '—';
  const distStr     = distToNext !== null ? fmtDistPlain(distToNext)       : '—';
  const timeStr     = distToNext !== null ? shortTime(distToNext, activeKph) : '—';
  return `<div class="popup-city">
    <b>Kota ${cityIdx + 1}</b>
    <div class="p-row"><span class="p-key">Urutan rute</span><span class="p-val">${seqStr}</span></div>
    <div class="p-row"><span class="p-key">Jarak ke berikutnya</span><span class="p-val">${distStr}</span></div>
    <div class="p-row"><span class="p-key">Waktu ke berikutnya</span><span class="p-time">${timeStr}</span></div>
    <div class="p-row"><span class="p-key">Lat</span><span class="p-val">${c.lat.toFixed(5)}</span></div>
    <div class="p-row"><span class="p-key">Lng</span><span class="p-val">${c.lng.toFixed(5)}</span></div>
  </div>`;
}

function fmtDistPlain(m) {
  return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
}

function updatePopups(tour, D) {
  const segs = segmentDistances(tour, D);
  markers.forEach((marker, cityIdx) => {
    const pos  = tour.indexOf(cityIdx); // position in tour (0-based)
    const seq  = pos + 1;
    const dist = segs[pos];
    marker.setPopupContent(makeCityPopup(cityIdx, seq, dist));
  });
}

/* ═══════════════════════════════════════════════════
   TRAVEL MODE
═══════════════════════════════════════════════════ */

/**
 * Update active speed, badges, and recalculate travel time if a tour exists.
 * @param {number} kph
 * @param {HTMLElement|null} activeBtn - button to mark as active
 */
function setTravelMode(kph, activeBtn) {
  activeKph = kph;
  document.getElementById('active-kph-label').textContent = kph + ' km/j';
  document.getElementById('mode-badge').textContent = '⏱ ' + kph + ' km/j';

  // Deactivate all mode buttons
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  if (activeBtn) activeBtn.classList.add('active');

  // Recalculate travel time if a route is already solved
  if (lastTour && lastD) {
    const length = tourLen(lastTour, lastD);
    document.getElementById('m-travel').innerHTML = fmtTravelTime(length, activeKph);
    updatePopups(lastTour, lastD);
    setStatus(`Mode diubah ke ${kph} km/j — waktu tempuh diperbarui.`, 'green');
  }
}

/* ═══════════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════════ */
function setStatus(msg, type) {
  document.getElementById('status-msg').textContent = msg;
  document.getElementById('status-dot').className   = 'dot ' + type;
}

function updateUI() {
  const n = cities.length;
  document.getElementById('city-count').textContent = n;
  document.getElementById('m-n').textContent         = n;
  document.getElementById('btn-solve').disabled      = n < 2;
  if (n > 0) {
    document.getElementById('state-badge').textContent = n + ' kota';
    document.getElementById('state-badge').className   = 'badge badge-blue';
  }
  renderCityList();
}

function renderCityList() {
  const list = document.getElementById('city-list');
  list.innerHTML = '';

  const segs = lastTour && lastD ? segmentDistances(lastTour, lastD) : null;

  cities.forEach((c, i) => {
    const div  = document.createElement('div');
    div.className = 'city-item';

    const pos       = lastTour ? lastTour.indexOf(i) : -1;
    const seqLabel  = pos >= 0 ? `<span class="city-seq">#${pos + 1}</span>` : '';
    const distLabel = segs && pos >= 0
      ? `<span class="city-dist">${fmtDistPlain(segs[pos])}</span>`
      : '';

    div.innerHTML =
      `<div class="city-dot" style="background:${COLORS[i % COLORS.length]}"></div>
       <span class="city-name">Kota ${i + 1}</span>
       ${seqLabel}${distLabel}`;
    list.appendChild(div);
  });
}

/* ═══════════════════════════════════════════════════
   EVENT LISTENERS
═══════════════════════════════════════════════════ */

// Map click → add city
map.on('click', function (e) {
  if (solving) return;
  addCity(e.latlng.lat, e.latlng.lng);
  setStatus(
    `Kota ${cities.length} ditambahkan. ${cities.length >= 2
      ? 'Klik Solve untuk mencari rute terpendek.'
      : 'Tambahkan satu kota lagi untuk mengaktifkan Solve.'}`,
    cities.length >= 2 ? 'green' : 'blue'
  );
});

// Solve
document.getElementById('btn-solve').addEventListener('click', solve);

// Random cities
document.getElementById('btn-random').addEventListener('click', function () {
  if (solving) return;
  clearAll();
  const center = map.getCenter();
  const span   = 0.06 / map.getZoom() * 10;
  const n      = 8 + Math.floor(Math.random() * 9);
  for (let k = 0; k < n; k++) {
    addCity(
      center.lat + (Math.random() - 0.5) * span,
      center.lng + (Math.random() - 0.5) * span
    );
  }
  setStatus(`${n} kota acak dihasilkan. Klik Solve untuk mencari rute.`, 'green');
});

// Clear
document.getElementById('btn-clear').addEventListener('click', function () {
  if (solving) return;
  clearAll();
  setStatus('Semua kota dihapus. Klik peta untuk mulai dari awal.', 'blue');
});

// Algorithm select
document.getElementById('algo-select').addEventListener('change', function () {
  document.getElementById('algo-badge').textContent = ALGO_NAMES[this.value];
});

// Animation speed slider
document.getElementById('speed').addEventListener('input', function () {
  document.getElementById('speed-val').textContent = this.value;
});

// Travel mode buttons
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    setTravelMode(+this.dataset.kph, this);
    document.getElementById('custom-kph').value = '';
  });
});

// Custom speed apply
document.getElementById('btn-apply-kph').addEventListener('click', function () {
  const val = parseInt(document.getElementById('custom-kph').value);
  if (!val || val < 1 || val > 300) {
    setStatus('Masukkan kecepatan antara 1–300 km/j.', 'amber');
    return;
  }
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  setTravelMode(val, null);
});

document.getElementById('custom-kph').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('btn-apply-kph').click();
});
