// Mapbox token is injected by config.js.php at page load as window.MAPBOX_TOKEN
let MAPBOX_TOKEN = window.MAPBOX_TOKEN || '';

// --- State ---

const state = {
  a: null,         // { lat, lng, name }
  b: null,
  map: null,
  markers: [],
  allResults: [],  // full unfiltered result set, preserved for filter re-runs
  activeFilters: new Set(),
};

// --- Utilities ---

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Geocoding (Google Places Autocomplete via PHP proxy) ---

async function autocompleteSuggest(query, proximity) {
  const params = new URLSearchParams({ action: 'autocomplete', input: query });
  if (proximity) {
    params.set('lat', proximity.lat);
    params.set('lng', proximity.lng);
  }
  const res = await fetch('api.php?' + params);
  const data = await res.json();
  return data.predictions || [];
}

async function fetchPlaceDetails(placeId) {
  const res = await fetch('api.php?action=placedetails&place_id=' + encodeURIComponent(placeId));
  const data = await res.json();
  const loc = data.result?.geometry?.location;
  if (!loc) throw new Error('Could not get location for selected place');
  return {
    lat: loc.lat,
    lng: loc.lng,
    name: data.result.formatted_address || data.result.name,
  };
}

function setupInput(inputEl, listEl, targetKey) {
  const otherKey = targetKey === 'a' ? 'b' : 'a';

  const debouncedSearch = debounce(async (query) => {
    if (query.length < 2) { listEl.innerHTML = ''; return; }
    try {
      const predictions = await autocompleteSuggest(query, state[otherKey]);
      listEl.innerHTML = '';
      predictions.forEach(p => {
        const li = document.createElement('li');
        li.textContent = p.description;
        li.addEventListener('mousedown', async (e) => {
          e.preventDefault();
          listEl.innerHTML = '';
          inputEl.value = p.description;
          inputEl.disabled = true;
          try {
            const place = await fetchPlaceDetails(p.place_id);
            state[targetKey] = place;
            inputEl.value = place.name;
            updateControls();
            if (state.a && state.b) runSearch();
          } catch {
            inputEl.value = '';
          } finally {
            inputEl.disabled = false;
          }
        });
        listEl.appendChild(li);
      });
    } catch {
      listEl.innerHTML = '';
    }
  }, 300);

  inputEl.addEventListener('input', () => {
    state[targetKey] = null;
    updateControls();
    debouncedSearch(inputEl.value.trim());
  });

  inputEl.addEventListener('blur', () => {
    setTimeout(() => { listEl.innerHTML = ''; }, 150);
  });
}

function setupLocateButton(btn, inputEl, targetKey) {
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser.');
      return;
    }
    btn.textContent = '⏳';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        state[targetKey] = { lat, lng, name: 'My location' };
        inputEl.value = 'My location';
        btn.textContent = '📍';
        updateControls();
        if (state.a && state.b) runSearch();
      },
      () => {
        btn.textContent = '📍';
        alert('Could not get your location. Please type an address instead.');
      }
    );
  });
}

function updateControls() {
  const ready = !!(state.a && state.b);
  searchBtn.disabled = !ready;
  shareBtn.hidden = !ready;
}

// --- Filters ---

function applyFilters(restaurants) {
  const f = state.activeFilters;
  return restaurants.filter(r => {
    // Open now
    if (f.has('open') && r.opening_hours?.open_now === false) return false;

    // Rating (only one rating filter can be active at a time)
    if (f.has('rating-45') && (r.rating == null || r.rating < 4.5)) return false;
    else if (f.has('rating-40') && (r.rating == null || r.rating < 4.0)) return false;
    else if (f.has('rating-35') && (r.rating == null || r.rating < 3.5)) return false;

    // Price — pass if no price filters active, or restaurant matches any selected level,
    // or restaurant has no price data
    const priceFilters = ['price-1', 'price-2', 'price-3', 'price-4'].filter(p => f.has(p));
    if (priceFilters.length > 0 && r.price_level != null) {
      if (!f.has(`price-${r.price_level}`)) return false;
    }

    return true;
  });
}

function refreshResults() {
  const visible = applyFilters(state.allResults);
  renderResults(visible, state.a, state.b);
  if (state.map) {
    if (state.map.isStyleLoaded()) {
      addMarkers(state.map, state.a, state.b, visible);
    }
  }
}

function setupFilters() {
  const ratingGroup = ['rating-35', 'rating-40', 'rating-45'];

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.filter;

      if (ratingGroup.includes(key)) {
        // Rating filters are mutually exclusive — clicking the active one deselects it
        const alreadyActive = state.activeFilters.has(key);
        ratingGroup.forEach(k => {
          state.activeFilters.delete(k);
          document.querySelector(`[data-filter="${k}"]`).classList.remove('active');
        });
        if (!alreadyActive) {
          state.activeFilters.add(key);
          btn.classList.add('active');
        }
      } else {
        // All other filters toggle independently
        if (state.activeFilters.has(key)) {
          state.activeFilters.delete(key);
          btn.classList.remove('active');
        } else {
          state.activeFilters.add(key);
          btn.classList.add('active');
        }
      }

      refreshResults();
    });
  });
}

// --- Share link ---

const shareBtn = document.getElementById('share-btn');

shareBtn.addEventListener('click', () => {
  if (!state.a || !state.b) return;
  const params = new URLSearchParams({
    alat: state.a.lat,
    alng: state.a.lng,
    aname: state.a.name,
    blat: state.b.lat,
    blng: state.b.lng,
    bname: state.b.name,
  });
  const url = location.origin + location.pathname + '?' + params;
  navigator.clipboard.writeText(url).then(() => {
    shareBtn.textContent = 'Copied!';
    setTimeout(() => { shareBtn.textContent = 'Copy share link'; }, 2000);
  });
});

// --- Midpoint ---

async function getMidpoint(a, b, distanceKm) {
  if (distanceKm < 100) {
    return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  }
  const params = new URLSearchParams({
    action: 'route',
    originLat: a.lat,
    originLng: a.lng,
    destLat: b.lat,
    destLng: b.lng,
  });
  const res = await fetch('api.php?' + params);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.midpoint;
}

// --- Restaurant fetch & filter ---

async function fetchRestaurants(lat, lng, radiusMeters) {
  const params = new URLSearchParams({
    action: 'places',
    lat,
    lng,
    radius: Math.round(radiusMeters),
  });
  const res = await fetch('api.php?' + params);
  const data = await res.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error('Places API error: ' + (data.status || 'unknown'));
  }
  return data.results || [];
}

// Buffer width for the corridor (capped at 10km so it doesn't grow absurdly large)
function corridorBufferKm(distanceKm) {
  return Math.min(distanceKm * 0.2, 10);
}

// Fetch from 5 evenly-spaced points along the corridor in parallel,
// each with a generous radius, then deduplicate by place_id.
// The wider radius compensates for Google's 20-result-per-call cap.
async function fetchAllCandidates(a, b, distanceKm) {
  const bufKm = corridorBufferKm(distanceKm);
  const radiusMeters = Math.min(Math.max(bufKm * 3, 3) * 1000, 50000);

  const fractions = [0.25, 0.375, 0.5, 0.625, 0.75];
  const searchPoints = fractions.map(t => ({
    lat: a.lat + t * (b.lat - a.lat),
    lng: a.lng + t * (b.lng - a.lng),
  }));

  const batches = await Promise.all(
    searchPoints.map(p => fetchRestaurants(p.lat, p.lng, radiusMeters))
  );

  const seen = new Set();
  return batches.flat().filter(r => {
    if (seen.has(r.place_id)) return false;
    seen.add(r.place_id);
    return true;
  });
}

// Keep restaurants whose projection onto the A-B segment falls in [25%, 75%]
// and whose perpendicular distance is within the corridor buffer.
function filterByCorridor(restaurants, a, b, distanceKm) {
  const bufKm = corridorBufferKm(distanceKm);
  const ABx = b.lng - a.lng;
  const ABy = b.lat - a.lat;
  const AB2 = ABx * ABx + ABy * ABy;

  return restaurants.filter(r => {
    const rLat = r.geometry.location.lat;
    const rLng = r.geometry.location.lng;

    // Projection fraction along A-B (0 = at A, 1 = at B)
    const t = ((rLng - a.lng) * ABx + (rLat - a.lat) * ABy) / AB2;
    if (t < 0.25 || t > 0.75) return false;

    // Perpendicular distance from the projection point to the restaurant
    const projLat = a.lat + t * ABy;
    const projLng = a.lng + t * ABx;
    return haversineKm(rLat, rLng, projLat, projLng) <= bufKm;
  });
}

// --- Map ---

function initMap(center) {
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  mapboxgl.accessToken = MAPBOX_TOKEN;
  state.map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [center.lng, center.lat],
    zoom: 11,
  });
  state.map.addControl(new mapboxgl.NavigationControl(), 'top-right');
  return state.map;
}

// Corridor: buffer the 25%-to-75% line segment by corridorBufferKm.
// Stays entirely within the A-B bounding box.
function corridorGeoJSON(a, b, distanceKm) {
  const p25 = [a.lng + 0.25 * (b.lng - a.lng), a.lat + 0.25 * (b.lat - a.lat)];
  const p75 = [a.lng + 0.75 * (b.lng - a.lng), a.lat + 0.75 * (b.lat - a.lat)];
  const line = turf.lineString([p25, p75]);
  return turf.buffer(line, corridorBufferKm(distanceKm), { units: 'kilometers', steps: 16 });
}

function drawZone(map, a, b, distanceKm) {
  const geojson = corridorGeoJSON(a, b, distanceKm);
  if (!geojson) return;
  if (map.getSource('zone')) {
    map.getSource('zone').setData(geojson);
    return;
  }
  map.addSource('zone', { type: 'geojson', data: geojson });
  map.addLayer({
    id: 'zone-fill',
    type: 'fill',
    source: 'zone',
    paint: { 'fill-color': '#4f46e5', 'fill-opacity': 0.07 },
  });
  map.addLayer({
    id: 'zone-border',
    type: 'line',
    source: 'zone',
    paint: { 'line-color': '#4f46e5', 'line-width': 2, 'line-dasharray': [4, 3] },
  });
}

function placeMarker(map, lat, lng, className, title) {
  const el = document.createElement('div');
  el.className = 'marker ' + className;
  el.title = title;
  const m = new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
  state.markers.push(m);
  return el;
}

function addMarkers(map, a, b, restaurants) {
  state.markers.forEach(m => m.remove());
  state.markers = [];

  placeMarker(map, a.lat, a.lng, 'marker-a', 'You: ' + a.name);
  placeMarker(map, b.lat, b.lng, 'marker-b', 'Friend: ' + b.name);

  restaurants.forEach((r, i) => {
    const el = placeMarker(
      map,
      r.geometry.location.lat,
      r.geometry.location.lng,
      'marker-restaurant',
      r.name
    );
    el.dataset.index = i;
    el.addEventListener('click', () => highlightResult(i));
  });

  const bounds = new mapboxgl.LngLatBounds();
  bounds.extend([a.lng, a.lat]);
  bounds.extend([b.lng, b.lat]);
  restaurants.forEach(r => bounds.extend([r.geometry.location.lng, r.geometry.location.lat]));
  map.fitBounds(bounds, { padding: 70, maxZoom: 14 });
}

// --- Results rendering ---

const SKIP_TYPES = new Set(['restaurant', 'food', 'point_of_interest', 'establishment']);

function formatCuisine(types) {
  const t = (types || []).find(x => !SKIP_TYPES.has(x));
  return t ? t.replace(/_/g, ' ') : 'restaurant';
}

function renderResults(restaurants, a, b) {
  const header = document.getElementById('results-header');
  const list = document.getElementById('results-list');

  const n = restaurants.length;
  const total = state.allResults.length;
  const filtered = total > 0 && n < total;
  header.textContent = n === 0
    ? (total > 0 ? 'No restaurants match the current filters.' : 'No restaurants found in the corridor. Try locations farther apart.')
    : `${n}${filtered ? ` of ${total}` : ''} restaurant${n !== 1 ? 's' : ''} found`;

  list.innerHTML = '';
  restaurants.forEach((r, i) => {
    const rLat = r.geometry.location.lat;
    const rLng = r.geometry.location.lng;
    const dA = haversineKm(a.lat, a.lng, rLat, rLng).toFixed(1);
    const dB = haversineKm(b.lat, b.lng, rLat, rLng).toFixed(1);

    const rating = r.rating ? `★${r.rating} (${r.user_ratings_total.toLocaleString()})` : 'No rating';
    const price = r.price_level ? '$'.repeat(r.price_level) : '';
    const isOpen = r.opening_hours?.open_now;
    const cuisine = formatCuisine(r.types);
    const mapsUrl = `https://www.google.com/maps/place/?q=place_id:${r.place_id}`;

    const card = document.createElement('div');
    card.className = 'restaurant-card';
    card.dataset.index = i;
    card.innerHTML = `
      <div class="card-main">
        <div class="card-name">${escapeHtml(r.name)}</div>
        <div class="card-meta">
          <span class="card-cuisine">${escapeHtml(cuisine)}</span>
          ${price ? `<span class="card-price">${price}</span>` : ''}
          <span class="card-rating">${rating}</span>
          ${isOpen !== undefined
            ? `<span class="card-open ${isOpen ? 'open' : 'closed'}">${isOpen ? 'Open now' : 'Closed'}</span>`
            : ''}
        </div>
        <div class="card-distances">
          <span>${dA} km from you</span>
          <span>${dB} km from friend</span>
        </div>
      </div>
      <a class="card-link" href="${mapsUrl}" target="_blank" rel="noopener noreferrer">View on Maps</a>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-link')) return;
      highlightResult(i);
    });

    list.appendChild(card);
  });
}

function highlightResult(index) {
  document.querySelectorAll('.restaurant-card').forEach((c, i) => {
    c.classList.toggle('highlighted', i === index);
  });
  document.querySelectorAll('.marker-restaurant').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.index) === index);
  });
  document.querySelector(`.restaurant-card[data-index="${index}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Search flow ---

const searchBtn = document.getElementById('search-btn');

async function runSearch() {
  const a = state.a;
  const b = state.b;
  if (!a || !b) return;

  searchBtn.disabled = true;

  try {
    const distanceKm = haversineKm(a.lat, a.lng, b.lat, b.lng);
    const midpoint = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };

    let raw;
    if (distanceKm < 100) {
      raw = await fetchAllCandidates(a, b, distanceKm);
    } else {
      const routeMid = await getMidpoint(a, b, distanceKm);
      raw = await fetchRestaurants(routeMid.lat, routeMid.lng, 15000);
    }

    const filtered = filterByCorridor(raw, a, b, distanceKm);
    filtered.sort((x, y) => (y.rating || 0) - (x.rating || 0));

    // Cache full results so filters can re-run without re-fetching
    state.allResults = filtered;

    document.getElementById('map-section').hidden = false;
    document.getElementById('results-section').hidden = false;

    const map = initMap(midpoint);
    map.on('load', () => {
      drawZone(map, a, b, distanceKm);
      addMarkers(map, a, b, applyFilters(filtered));
    });

    renderResults(applyFilters(filtered), a, b);

    if (filtered.length > 0) {
      document.getElementById('results-section').scrollIntoView({ behavior: 'smooth' });
    }
  } catch (err) {
    console.error(err);
    alert('Something went wrong: ' + err.message);
  } finally {
    searchBtn.disabled = false;
    updateControls();
  }
}

searchBtn.addEventListener('click', runSearch);

// --- Startup ---

async function init() {
  if (!MAPBOX_TOKEN || !MAPBOX_TOKEN.startsWith('pk.')) {
    document.querySelector('main').innerHTML =
      '<p style="padding:2rem;color:#dc2626">Configuration error: Mapbox token is missing or invalid. Check config.js.php loaded correctly and that MAPBOX_TOKEN in config.php starts with pk.</p>';
    return;
  }

  setupFilters();

  setupInput(
    document.getElementById('location-a'),
    document.getElementById('autocomplete-a'),
    'a'
  );
  setupInput(
    document.getElementById('location-b'),
    document.getElementById('autocomplete-b'),
    'b'
  );
  setupLocateButton(
    document.querySelector('.locate-btn[data-target="a"]'),
    document.getElementById('location-a'),
    'a'
  );

  // Restore from share link
  const p = new URLSearchParams(location.search);
  if (p.get('alat') && p.get('alng') && p.get('blat') && p.get('blng')) {
    state.a = { lat: +p.get('alat'), lng: +p.get('alng'), name: p.get('aname') || 'Location A' };
    state.b = { lat: +p.get('blat'), lng: +p.get('blng'), name: p.get('bname') || 'Location B' };
    document.getElementById('location-a').value = state.a.name;
    document.getElementById('location-b').value = state.b.name;
    updateControls();
    runSearch();
  }
}

init();
