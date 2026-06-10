// Mapbox token is injected by config.js.php at page load as window.MAPBOX_TOKEN
let MAPBOX_TOKEN = window.MAPBOX_TOKEN || '';

// --- State ---

const state = {
  a: null,         // { lat, lng, name }
  b: null,
  map: null,
  markers: [],
  markerElements: [],
  allResults: [],  // full unfiltered result set, preserved for filter re-runs
  activeFilters: new Set(),
  sortBy: 'rating',
  midpoint: null,
  searching: false,
  userLocation: null,
  aIsAutoFilled: false,
  nearMeMode: false,
};

// --- Utilities ---

let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2200);
}

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

async function autocompleteSuggest(query, proximity, signal) {
  const params = new URLSearchParams({ action: 'autocomplete', input: query });
  if (proximity) {
    params.set('lat', proximity.lat);
    params.set('lng', proximity.lng);
  }
  const res = await fetch('api.php?' + params, { signal });
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
  let autocompleteController = null;

  const debouncedSearch = debounce(async (query) => {
    if (query.length < 3) { listEl.innerHTML = ''; return; }
    autocompleteController?.abort();
    autocompleteController = new AbortController();
    try {
      const predictions = await autocompleteSuggest(query, state[otherKey], autocompleteController.signal);
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
          } catch (err) {
            console.error('fetchPlaceDetails failed:', err);
          } finally {
            inputEl.disabled = false;
          }
        });
        listEl.appendChild(li);
      });
    } catch (err) {
      if (err.name !== 'AbortError') listEl.innerHTML = '';
    }
  }, 500);

  inputEl.addEventListener('input', () => {
    state[targetKey] = null;
    updateControls();
    debouncedSearch(inputEl.value.trim());
  });

  inputEl.addEventListener('keydown', (e) => {
    const items = listEl.querySelectorAll('li');
    const current = listEl.querySelector('li[aria-selected="true"]');
    const idx = current ? [...items].indexOf(current) : -1;

    if (e.key === 'ArrowDown') {
      if (!items.length) return;
      e.preventDefault();
      const next = items[Math.min(idx + 1, items.length - 1)];
      if (current) current.removeAttribute('aria-selected');
      next.setAttribute('aria-selected', 'true');
      next.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      if (idx <= 0) return;
      const prev = items[idx - 1];
      current.removeAttribute('aria-selected');
      prev.setAttribute('aria-selected', 'true');
      prev.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const target = current || items[0];
      if (target) {
        e.preventDefault();
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }
    } else if (e.key === 'Tab') {
      const target = current || items[0];
      if (target) target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    } else if (e.key === 'Escape') {
      listEl.innerHTML = '';
    }
  });

  inputEl.addEventListener('blur', () => {
    setTimeout(() => { listEl.innerHTML = ''; }, 150);
  });

  if (targetKey === 'a') {
    inputEl.addEventListener('focus', () => {
      if (state.aIsAutoFilled) {
        inputEl.value = '';
        state.a = null;
        state.aIsAutoFilled = false;
        updateControls();
      }
    });
  }
}

function setupLocateButton(btn, inputEl, targetKey) {
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser.');
      return;
    }
    btn.innerHTML = '<span class="material-icons">hourglass_empty</span>';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        state[targetKey] = { lat, lng, name: 'My location' };
        inputEl.value = 'My location';
        btn.innerHTML = '<span class="material-icons">pin_drop</span>';
        updateControls();
        if (state.a && state.b) runSearch();
      },
      () => {
        btn.innerHTML = '<span class="material-icons">pin_drop</span>';
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

function applySort(restaurants) {
  const sorted = [...restaurants];
  if (state.sortBy === 'distance' && state.midpoint) {
    sorted.sort((x, y) => (x._dMidpoint || 0) - (y._dMidpoint || 0));
  } else if (state.sortBy === 'price') {
    sorted.sort((x, y) => (x.price_level || 99) - (y.price_level || 99));
  } else {
    sorted.sort((x, y) => {
      const rd = (y.rating || 0) - (x.rating || 0);
      return rd !== 0 ? rd : (y.user_ratings_total || 0) - (x.user_ratings_total || 0);
    });
  }
  return sorted;
}

function refreshResults() {
  const visible = applySort(applyFilters(state.allResults));
  renderResults(visible, state.a, state.b);
  if (state.map) {
    if (state.map.isStyleLoaded()) {
      addMarkers(state.map, state.a, state.b, visible);
    }
  }
}

function setupSort() {
  document.getElementById('sort-select').addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    refreshResults();
  });
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
    alat: state.a.lat.toFixed(5),
    alng: state.a.lng.toFixed(5),
    aname: state.a.name.split(',')[0].trim(),
    blat: state.b.lat.toFixed(5),
    blng: state.b.lng.toFixed(5),
    bname: state.b.name.split(',')[0].trim(),
  });
  const url = location.origin + location.pathname + '?' + params;
  navigator.clipboard.writeText(url).then(() => showToast('Link copied to clipboard'));
});

// --- Midpoint ---

async function getRouteData(a, b) {
  const params = new URLSearchParams({
    action: 'route',
    originLat: a.lat,
    originLng: a.lng,
    destLat: b.lat,
    destLng: b.lng,
  });
  const res = await fetch('api.php?' + params);
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error);
    err.noRoute = true;
    throw err;
  }
  return data; // { midpoint, p33, p67 }
}

// --- Restaurant fetch & filter ---



// --- Map ---

function initMap(center) {
  if (state.map) {
    state.map.jumpTo({ center: [center.lng, center.lat], zoom: 12 });
    return state.map;
  }

  if (!mapboxgl) {
    console.error('Mapbox GL not loaded');
    return null;
  }

  const mapContainer = document.getElementById('map');
  if (!mapContainer) {
    console.error('Map container not found');
    return null;
  }

  mapboxgl.accessToken = MAPBOX_TOKEN;
  console.log('Creating map with token, center:', center);

  try {
    state.map = new mapboxgl.Map({
      container: 'map',
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [center.lng, center.lat],
      zoom: 12,
    });
    console.log('Map created successfully');
    state.map.addControl(new mapboxgl.NavigationControl(), 'top-right');
  } catch (err) {
    console.error('Error creating map:', err);
    return null;
  }

  return state.map;
}



function drawRoute(map, polylinePoints) {
  const geojson = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: polylinePoints.map(p => [p.lng, p.lat]) },
  };
  if (map.getSource('route')) { map.getSource('route').setData(geojson); return; }
  map.addSource('route', { type: 'geojson', data: geojson });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#4f46e5', 'line-width': 3, 'line-opacity': 0.45 },
  });
}


function drawZone(map, geojson) {
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
  state.markerElements = [];

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
    state.markerElements.push(el);
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
  const noResultsMsg = state.nearMeMode
    ? 'No restaurants found nearby. Try expanding your search area.'
    : 'No restaurants found in the corridor. Try locations farther apart.';
  header.textContent = n === 0
    ? (total > 0 ? 'No restaurants match the current filters.' : noResultsMsg)
    : `${n}${filtered ? ` of ${total}` : ''} restaurant${n !== 1 ? 's' : ''} found`;

  list.innerHTML = '';
  restaurants.forEach((r, i) => {
    const dA = (r._dA ?? haversineKm(a.lat, a.lng, r.geometry.location.lat, r.geometry.location.lng)).toFixed(1);
    const dB = (r._dB ?? haversineKm(b.lat, b.lng, r.geometry.location.lat, r.geometry.location.lng)).toFixed(1);

    const rating = r.rating ? `★${r.rating} (${r.user_ratings_total.toLocaleString()})` : 'No rating';
    const price = r.price_level ? '$'.repeat(r.price_level) : '';
    const isOpen = r.opening_hours?.open_now;
    const cuisine = r.primary_type || formatCuisine(r.types);
    const mapsUrl = `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(r.place_id)}`;

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

    card.addEventListener('mouseenter', () => hoverResult(i));
    card.addEventListener('mouseleave', () => unhoverResult());
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-link')) return;
      highlightResult(i);
    });

    list.appendChild(card);
  });
}

function hoverResult(index) {
  state.markerElements.forEach(el => {
    el.classList.toggle('hover', parseInt(el.dataset.index) === index);
  });
}

function unhoverResult() {
  state.markerElements.forEach(el => el.classList.remove('hover'));
}

function highlightResult(index) {
  document.querySelectorAll('.restaurant-card').forEach((c, i) => {
    c.classList.toggle('highlighted', i === index);
  });
  state.markerElements.forEach(el => {
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
  if (!a || !b || state.searching) return;
  if (!isFinite(a.lat) || !isFinite(a.lng) || !isFinite(b.lat) || !isFinite(b.lng)) return;

  removeNearMeCircle(state.map);
  state.nearMeMode = false;
  state.searching = true;
  searchBtn.disabled = true;

  try {
    const midpoint = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
    state.midpoint = midpoint;

    // Show loading state immediately — user sees feedback during API calls
    document.getElementById('map-section').hidden = false;
    document.getElementById('results-section').hidden = false;
    document.getElementById('results-header').textContent = 'Searching…';
    document.getElementById('results-list').innerHTML = '<div class="search-loading">Finding restaurants in the middle…</div>';
    const map = initMap(midpoint);

    const routeData = await getRouteData(a, b);
    state.midpoint = routeData.midpoint;
    const routePolyline = routeData.polyline || null;

    // Results and radius are returned by the route action (searches run server-side).
    const raw = routeData.results || [];
    const radiusKm = routeData.radiusKm;

    // Bounding box from the trimmed route extent plus both endpoints.
    // Using the route (not just A and B) prevents clipping on routes where
    // the endpoints share a similar lat/lng (e.g. NJ→Pittsburgh curves north).
    const routeLats = routeData.trimmedPolyline.map(p => p.lat);
    const routeLngs = routeData.trimmedPolyline.map(p => p.lng);
    const minLat = Math.min(a.lat, b.lat, ...routeLats);
    const maxLat = Math.max(a.lat, b.lat, ...routeLats);
    const minLng = Math.min(a.lng, b.lng, ...routeLngs);
    const maxLng = Math.max(a.lng, b.lng, ...routeLngs);

    // Zone: buffer the trimmed road path, clipped to route bounding box.
    const bboxPoly = turf.bboxPolygon([minLng, minLat, maxLng, maxLat]);
    const zoneBuffer = turf.buffer(
      turf.lineString(routeData.trimmedPolyline.map(p => [p.lng, p.lat])),
      radiusKm, { units: 'kilometers', steps: 32 }
    );
    const zoneGeoJSON = turf.intersect(zoneBuffer, bboxPoly) || zoneBuffer;

    const inBounds = raw.filter(r => {
      const { lat, lng } = r.geometry.location;
      return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
    });

    state.allResults = inBounds;

    // Pre-compute distances so sort and render don't repeat haversine calls
    inBounds.forEach(r => {
      const rLat = r.geometry.location.lat;
      const rLng = r.geometry.location.lng;
      r._dA        = haversineKm(a.lat, a.lng, rLat, rLng);
      r._dB        = haversineKm(b.lat, b.lng, rLat, rLng);
      r._dMidpoint = haversineKm(state.midpoint.lat, state.midpoint.lng, rLat, rLng);
    });

    const displayResults = applySort(applyFilters(inBounds));

    const applyMapLayers = () => {
      if (routePolyline) drawRoute(map, routePolyline);
      drawZone(map, zoneGeoJSON);
      addMarkers(map, a, b, displayResults);
    };
    if (map.isStyleLoaded()) applyMapLayers();
    else map.once('load', applyMapLayers);

    renderResults(displayResults, a, b);
  } catch (err) {
    console.error(err);
    document.getElementById('map-section').hidden = false;
    document.getElementById('results-section').hidden = false;
    if (err.noRoute) {
      document.getElementById('results-header').textContent = 'No driveable route found between these locations.';
      document.getElementById('results-list').innerHTML = '';
      // Still show the two pins so the user can see what was searched
      const map = state.map || initMap({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
      const showPins = () => { placeMarker(map, a.lat, a.lng, 'marker-a', 'You: ' + a.name); placeMarker(map, b.lat, b.lng, 'marker-b', 'Friend: ' + b.name); map.fitBounds([[a.lng, a.lat], [b.lng, b.lat]], { padding: 70 }); };
      if (map.isStyleLoaded()) showPins(); else map.once('load', showPins);
    } else {
      document.getElementById('results-header').textContent = 'Search failed — please try again.';
      document.getElementById('results-list').innerHTML = '';
    }
  } finally {
    state.searching = false;
    searchBtn.disabled = false;
    updateControls();
  }
}

searchBtn.addEventListener('click', runSearch);

// --- Location determination ---

async function determineUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      console.log('Geolocation not available, using IP fallback');
      fetchIPLocation().then(resolve).catch(() => resolve({ lat: 43.8, lng: -79.3 }));
      return;
    }

    const geolocationTimeout = setTimeout(() => {
      console.log('Geolocation timeout, using IP fallback');
      fetchIPLocation().then(resolve).catch(() => resolve({ lat: 43.8, lng: -79.3 }));
    }, 5000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(geolocationTimeout);
        console.log('Got geolocation:', pos.coords.latitude, pos.coords.longitude);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      (err) => {
        clearTimeout(geolocationTimeout);
        console.log('Geolocation error:', err, 'using IP fallback');
        fetchIPLocation().then(resolve).catch(() => resolve({ lat: 43.8, lng: -79.3 }));
      }
    );
  });
}

async function fetchIPLocation() {
  try {
    const res = await fetch('api.php?action=mylocation');
    const data = await res.json();
    console.log('IP location response:', data);
    return { lat: data.lat ?? 43.8, lng: data.lng ?? -79.3 };
  } catch (err) {
    console.error('fetchIPLocation error:', err);
    throw err;
  }
}

function drawNearMeCircle(map, lat, lng, radiusKm) {
  if (map.getSource('nearbyme-circle')) {
    map.getSource('nearbyme-circle').setData(makeCircleGeoJSON(lat, lng, radiusKm));
    return;
  }

  const geojson = makeCircleGeoJSON(lat, lng, radiusKm);
  map.addSource('nearbyme-circle', { type: 'geojson', data: geojson });
  map.addLayer({
    id: 'nearbyme-circle-fill',
    type: 'fill',
    source: 'nearbyme-circle',
    paint: { 'fill-color': '#ec4899', 'fill-opacity': 0.08 },
  });
  map.addLayer({
    id: 'nearbyme-circle-border',
    type: 'line',
    source: 'nearbyme-circle',
    paint: { 'line-color': '#ec4899', 'line-width': 2 },
  });
}

function makeCircleGeoJSON(lat, lng, radiusKm) {
  const points = [];
  const numSegments = 64;
  for (let i = 0; i < numSegments; i++) {
    const angle = (i / numSegments) * 2 * Math.PI;
    const dx = radiusKm * Math.cos(angle);
    const dy = radiusKm * Math.sin(angle);

    const latOffset = dy / 111.0;
    const lngOffset = dx / (111.0 * Math.cos(lat * Math.PI / 180));

    points.push([lng + lngOffset, lat + latOffset]);
  }
  points.push(points[0]);

  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [points] },
  };
}

function removeNearMeCircle(map) {
  if (!map) return;
  if (map.getLayer('nearbyme-circle-fill')) map.removeLayer('nearbyme-circle-fill');
  if (map.getLayer('nearbyme-circle-border')) map.removeLayer('nearbyme-circle-border');
  if (map.getSource('nearbyme-circle')) map.removeSource('nearbyme-circle');
}

function removeRouteLayers(map) {
  if (!map) return;
  if (map.getLayer('route-line')) map.removeLayer('route-line');
  if (map.getSource('route')) map.removeSource('route');
  if (map.getLayer('zone-fill')) map.removeLayer('zone-fill');
  if (map.getLayer('zone-border')) map.removeLayer('zone-border');
  if (map.getSource('zone')) map.removeSource('zone');
}

async function runNearMeSearch(lat, lng) {
  const nearmeBtn = document.getElementById('nearbyme-btn');
  if (state.searching) return;

  removeRouteLayers(state.map);
  state.searching = true;
  state.nearMeMode = true;
  if (nearmeBtn) nearmeBtn.innerHTML = '<span class="material-icons">hourglass_empty</span>';

  try {
    document.getElementById('map-section').hidden = false;
    document.getElementById('results-section').hidden = false;
    document.getElementById('results-header').textContent = 'Searching…';
    document.getElementById('results-list').innerHTML = '<div class="search-loading">Finding nearby restaurants…</div>';

    const map = initMap({ lat, lng });

    const res = await fetch(`api.php?action=nearbyme&lat=${lat}&lng=${lng}`);
    const data = await res.json();
    console.log('nearbyme API response:', data);
    if (data.error) throw new Error(data.error);

    const results = data.results || [];
    console.log('Found', results.length, 'restaurants');
    if (results.length > 0) {
      const priceLevels = results.map(r => r.price_level).filter(p => p !== null);
      console.log('Price levels found:', new Set(priceLevels), 'distribution:', priceLevels.reduce((acc, p) => {acc[p] = (acc[p]||0)+1; return acc}, {}));
    }
    state.allResults = results;

    const radiusKm = 5;
    results.forEach(r => {
      const rLat = r.geometry.location.lat;
      const rLng = r.geometry.location.lng;
      r._dA        = haversineKm(lat, lng, rLat, rLng);
      r._dB        = 0;
      r._dMidpoint = haversineKm(lat, lng, rLat, rLng);
    });

    state.midpoint = { lat, lng };

    const displayResults = applySort(applyFilters(results));

    const applyMapLayers = () => {
      drawNearMeCircle(map, lat, lng, radiusKm);
      placeMarker(map, lat, lng, 'marker-a', 'You: My location');
      results.forEach((r, i) => {
        const el = placeMarker(
          map,
          r.geometry.location.lat,
          r.geometry.location.lng,
          'marker-restaurant',
          r.name
        );
        el.dataset.index = i;
        el.addEventListener('click', () => highlightResult(i));
        state.markerElements.push(el);
      });

      const circleBounds = [
        [lng - (radiusKm / 111.0), lat - (radiusKm / 111.0)],
        [lng + (radiusKm / 111.0), lat + (radiusKm / 111.0)],
      ];
      map.fitBounds(circleBounds, { padding: 70, maxZoom: 14 });
    };

    if (map.isStyleLoaded()) applyMapLayers();
    else map.once('load', applyMapLayers);

    renderResults(displayResults, { lat, lng, name: 'You' }, { lat, lng, name: 'You' });
  } catch (err) {
    console.error(err);
    document.getElementById('map-section').hidden = false;
    document.getElementById('results-section').hidden = false;
    document.getElementById('results-header').textContent = 'Search failed — please try again.';
    document.getElementById('results-list').innerHTML = '';
  } finally {
    state.searching = false;
    nearmeBtn.innerHTML = '<span class="material-icons">pin_drop</span>';
  }
}

function setupNearMeButton() {
  const btn = document.getElementById('nearbyme-btn');
  btn.addEventListener('click', () => {
    if (state.userLocation) {
      runNearMeSearch(state.userLocation.lat, state.userLocation.lng);
    }
  });
}

// --- Startup ---

async function init() {
  if (!MAPBOX_TOKEN || !MAPBOX_TOKEN.startsWith('pk.')) {
    document.querySelector('main').innerHTML =
      '<p style="padding:2rem;color:#dc2626">Configuration error: Mapbox token is missing or invalid. Check config.js.php loaded correctly and that MAPBOX_TOKEN in config.php starts with pk.</p>';
    return;
  }

  setupSort();
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

  state.userLocation = await determineUserLocation();
  console.log('User location determined:', state.userLocation);

  initMap(state.userLocation);
  console.log('Map initialized');

  state.a = { ...state.userLocation, name: 'My location' };
  state.aIsAutoFilled = true;
  document.getElementById('location-a').value = 'My location';
  document.getElementById('location-b').focus();
  updateControls();
  console.log('Initialization complete, map should be visible');

  setupNearMeButton();

  // Restore from share link
  const p = new URLSearchParams(location.search);
  const alat = +p.get('alat'), alng = +p.get('alng'), blat = +p.get('blat'), blng = +p.get('blng');
  if (isFinite(alat) && isFinite(alng) && isFinite(blat) && isFinite(blng) && (alat || alng) && (blat || blng)) {
    state.a = { lat: alat, lng: alng, name: escapeHtml(p.get('aname') || 'Location A') };
    state.aIsAutoFilled = false;
    state.b = { lat: blat, lng: blng, name: escapeHtml(p.get('bname') || 'Location B') };
    document.getElementById('location-a').value = state.a.name;
    document.getElementById('location-b').value = state.b.name;
    updateControls();
    runSearch();
  } else {
    // Auto-trigger Near me search on page load
    runNearMeSearch(state.userLocation.lat, state.userLocation.lng);
  }
}

init();
