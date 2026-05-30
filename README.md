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
3. **If D < 100 km:** search at the 25%, 37.5%, 50%, 62.5%, and 75% points along the A→B line in parallel, each with a radius proportional to the corridor width
4. **If D ≥ 100 km:** fetch the driving route via Google Directions, find the road-distance midpoint, search there with a 15 km radius
5. Deduplicate results by `place_id`
6. Filter: keep only restaurants whose projection onto the A→B segment falls between 25% and 75%, and whose perpendicular distance from the segment is within the corridor buffer (20% of D, capped at 10 km)
7. Sort by rating descending

## Corridor zone

The shaded zone on the map is a buffered line segment (stadium/capsule shape) drawn with Turf.js, running from the 25% to the 75% mark along A→B. Its width is 2 × corridor buffer (40% of D, capped at 20 km). This shape stays within the bounding box of the two locations and accurately represents the filter boundary.

## Roadmap

- Pagination to surface more results in dense areas
- Walking / transit travel time estimates
- Dark mode
