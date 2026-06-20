<?php
ini_set('display_errors', 0);
error_reporting(0);
if (file_exists(__DIR__ . '/config.php')) require_once __DIR__ . '/config.php';
$mapboxToken = defined('MAPBOX_TOKEN') ? MAPBOX_TOKEN : '';
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Meet 'n Eat</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍽️</text></svg>">
  <link href="https://api.mapbox.com/mapbox-gl-js/v3.24.0/mapbox-gl.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
  <link rel="stylesheet" href="style.css">
</head>
<body>

  <header>
    <h1>Meet 'n Eat</h1>
    <p>Find a restaurant halfway between you and a friend</p>
  </header>

  <main>

    <section class="search-row">

      <div class="input-group">
        <label for="location-a">You</label>
        <div class="input-row">
          <input
            type="text"
            id="location-a"
            placeholder="Address, postal code, or landmark"
            autocomplete="off"
            spellcheck="false"
          >
        </div>
        <ul class="autocomplete-list" id="autocomplete-a" role="listbox"></ul>
      </div>

      <div class="input-group">
        <label for="location-b">Friend</label>
        <div class="input-row">
          <input
            type="text"
            id="location-b"
            placeholder="Address, postal code, or landmark"
            autocomplete="off"
            spellcheck="false"
          >
        </div>
        <ul class="autocomplete-list" id="autocomplete-b" role="listbox"></ul>
      </div>

      <div class="action-buttons">
        <button id="search-btn" disabled>Go</button>
        <button id="nearbyme-btn" title="Search nearby restaurants">
          <span class="material-icons">pin_drop</span>
        </button>
        <button id="share-btn" hidden title="Copy share link">
          <span class="material-icons">share</span>
        </button>
      </div>

    </section>

    <div class="content-area">

    <section class="map-section" id="map-section">
      <div id="map"></div>
    </section>

    <section class="results-section" id="results-section" hidden>
      <div class="results-bar">
        <div class="results-bar-left">
          <div id="results-header"></div>
          <div class="sort-controls">
            <span class="sort-label">Sort:</span>
            <button id="sort-rating" class="sort-btn active" title="Sort by rating">
              <span class="material-icons">star</span>
              <span>Rating</span>
            </button>
            <button id="sort-distance" class="sort-btn" title="Sort by distance">
              <span class="material-icons">directions</span>
              <span>Distance</span>
            </button>
            <input type="range" id="distance-bias" class="distance-slider" min="0" max="100" value="50" title="Adjust distance preference">
          </div>
        </div>
        <div class="filters" id="filters">
          <button class="filter-btn" id="filter-open" data-filter="open">Open now</button>
          <span class="filter-divider"></span>
          <button class="filter-btn" id="filter-rating-35" data-filter="rating-35">3.5★+</button>
          <button class="filter-btn" id="filter-rating-40" data-filter="rating-40">4.0★+</button>
          <button class="filter-btn" id="filter-rating-45" data-filter="rating-45">4.5★+</button>
          <span class="filter-divider"></span>
          <button class="filter-btn" id="filter-price-1" data-filter="price-1">$</button>
          <button class="filter-btn" id="filter-price-2" data-filter="price-2">$$</button>
          <button class="filter-btn" id="filter-price-3" data-filter="price-3">$$$</button>
          <button class="filter-btn" id="filter-price-4" data-filter="price-4">$$$$</button>
        </div>
      </div>
      <div id="results-list"></div>
    </section>

    </div><!-- .content-area -->

  </main>

  <div id="toast" role="status" aria-live="polite"></div>

  <script src="https://api.mapbox.com/mapbox-gl-js/v3.24.0/mapbox-gl.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js"></script>
  <script>window.MAPBOX_TOKEN = <?php echo json_encode($mapboxToken); ?>;</script>
  <script src="app.js"></script>

</body>
</html>
