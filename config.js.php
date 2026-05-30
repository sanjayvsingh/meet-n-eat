<?php
header('Content-Type: application/javascript');
require_once __DIR__ . '/config.php';
echo "window.MAPBOX_TOKEN = '" . addslashes(MAPBOX_TOKEN) . "';";
