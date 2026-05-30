# Meet 'n Eat

Find a restaurant roughly halfway between two people's locations.

## How it works

Enter two addresses — yours and a friend's — and the app finds restaurants in the corridor between you. Results are filtered to places between 25% and 75% of the straight-line distance from each person, so nobody has to backtrack. When the two locations are more than 100 km apart, the midpoint is calculated along the driving route instead.

## Features

- Fuzzy address input with Google Places autocomplete (postal codes, transit stations, neighbourhoods, landmarks)
- 📍 button to use device geolocation
- Auto-searches as soon as both locations are selected
- Map with a shaded corridor zone and colour-coded pins for each person and each restaurant
- Side-by-side layout on wide screens — map stays sticky while results scroll
- Restaurant cards showing cuisine type, rating, price level, open/closed status, and distance from each person
- Hovering a card highlights the corresponding map marker
- Sort results by rating, distance from midpoint, or price
- Filter by open now, minimum rating (3.5★ / 4.0★ / 4.5★), and price level ($–$$$$)
- Share button that copies a URL — opening it auto-populates both fields and runs the search
- Responsive layout (desktop side-by-side, mobile stacked)

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML / CSS / JS |
| Map | Mapbox GL JS (CDN) |
| Geocoding / autocomplete | Google Places API (New) — Autocomplete |
| Restaurant data | Google Places API (New) — Nearby Search |
| Route midpoint (>100 km) | Google Directions API |
| Backend proxy | PHP (single `api.php` file) |

All Google API calls are proxied through `api.php` so the key never reaches the browser.

## Setup

### Prerequisites

- A web host running PHP 7.4+ with `curl` enabled (any standard Apache/cPanel host works)
- A [Google Maps Platform](https://developers.google.com/maps) API key with these APIs enabled:
  - Places API (New)
  - Directions API
- A [Mapbox](https://mapbox.com) account and public access token

### Google API key hardening (do before going live)

1. **Set a daily quota limit** — Google Cloud Console → APIs & Services → Quotas → cap "Places API (New) – Nearby Search requests per day" to something safe (e.g. 100–200 for personal use)
2. **Set a budget alert** — Billing → Budgets & alerts → create a $5 budget with email alerts at 50% and 100%
3. **Restrict the key** — Credentials → edit key → restrict to Places API (New) and Directions API only; restrict by server IP address (not HTTP referrer, since calls are made server-side via PHP/curl)

### Local development

```bash
# Clone the repo
git clone https://github.com/sanjayvsingh/meet-n-eat.git
cd meet-n-eat

# Create your local config (excluded from git)
cp config.example.php config.php
# Edit config.php and paste your keys

# Start a local PHP server
php -S localhost:8080

# Open http://localhost:8080 in your browser
```

### Configuration

Create `config.php` in the project root (it is gitignored):

```php
<?php
define('GOOGLE_API_KEY', 'AIza...');
define('MAPBOX_TOKEN',   'pk.eyJ1...');
```

A template is provided in `config.example.php`.

## File structure

```
meet-n-eat/
├── index.php         # Single-page app shell (injects Mapbox token server-side)
├── style.css         # All styles (responsive)
├── app.js            # All client-side logic
├── api.php           # Server-side proxy for Google APIs
├── .htaccess         # Sets index.php as directory index; blocks config files
├── config.php        # API keys — never committed (gitignored)
├── config.example.php
└── .gitignore
```

## Search algorithm

1. Geocode both inputs via Google Places Autocomplete → coordinates
2. Compute straight-line distance D with the Haversine formula
3. **If D < 75 km (short route):**
   - Search at the 25%, 37.5%, 50%, 62.5%, and 75% points along the A→B straight line in parallel, each with a radius proportional to the corridor width
   - Filter: keep only restaurants whose projection onto A→B falls between 25% and 75%, and whose perpendicular distance from the line is within the corridor buffer (20% of D, capped at 10 km)
   - Zone overlay: buffered capsule from the 25% to 75% mark along A→B
4. **If D ≥ 75 km (long route):**
   - Fetch the traffic-aware driving route via Google Directions (`departure_time=now`)
   - Find the 33%, 50%, and 67% waypoints along the driving route
   - Search at each waypoint sequentially with a 15 km radius (up to 60 results)
   - No additional filtering — the geographic search already constrains the area
   - Zone overlay: 15 km-buffered corridor through the three waypoints
   - Route line drawn on the map showing the actual driving path
   - If no driveable route exists (cross-ocean etc.), show a friendly message
5. Deduplicate results by `place_id`
6. Sort by rating (with review count as tiebreaker), distance from midpoint, or price

## Zone overlay

- **Short routes:** stadium/capsule shape (Turf.js buffered line) from the 25% to 75% mark along the straight A→B line. Width = 2 × corridor buffer.
- **Long routes:** 15 km-buffered corridor through the 33%, 50%, and 67% driving-route waypoints, drawn as a sausage shape along the actual road path.

## Roadmap

- Pagination to surface more results in dense areas
- Walking / transit travel time estimates
- Dark mode
