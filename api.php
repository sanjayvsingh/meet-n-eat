<?php
header('Content-Type: application/json');

if (!file_exists(__DIR__ . '/config.php')) {
    http_response_code(500);
    echo json_encode(['error' => 'config.php not found on server']);
    exit;
}
require_once 'config.php';

$action = $_GET['action'] ?? '';

function httpGet($url) {
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        $result = curl_exec($ch);
        curl_close($ch);
        return $result;
    }
    return file_get_contents($url);
}

if ($action === 'autocomplete') {
    $input = trim($_GET['input'] ?? '');
    if ($input === '') { echo json_encode(['predictions' => []]); exit; }

    $params = [
        'input'      => $input,
        'components' => 'country:ca|country:us',
        'key'        => GOOGLE_API_KEY,
    ];
    $lat = floatval($_GET['lat'] ?? 0);
    $lng = floatval($_GET['lng'] ?? 0);
    if ($lat !== 0.0 || $lng !== 0.0) {
        $params['location'] = "$lat,$lng";
        $params['radius']   = 50000;
    }

    $url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json?' . http_build_query($params);
    echo httpGet($url);

} elseif ($action === 'placedetails') {
    $placeId = trim($_GET['place_id'] ?? '');
    if ($placeId === '') { http_response_code(400); echo json_encode(['error' => 'Missing place_id']); exit; }

    $url = 'https://maps.googleapis.com/maps/api/place/details/json?' . http_build_query([
        'place_id' => $placeId,
        'fields'   => 'geometry,name,formatted_address',
        'key'      => GOOGLE_API_KEY,
    ]);
    echo httpGet($url);

} elseif ($action === 'places') {
    $lat = floatval($_GET['lat'] ?? 0);
    $lng = floatval($_GET['lng'] ?? 0);

    // rankby=distance returns the 20 nearest restaurants rather than the 20 most
    // prominent, so local spots aren't buried under chain brands.
    $url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json?' . http_build_query([
        'location' => "$lat,$lng",
        'rankby'   => 'distance',
        'type'     => 'restaurant',
        'key'      => GOOGLE_API_KEY,
    ]);

    echo httpGet($url);

} elseif ($action === 'route') {
    $oLat = floatval($_GET['originLat'] ?? 0);
    $oLng = floatval($_GET['originLng'] ?? 0);
    $dLat = floatval($_GET['destLat'] ?? 0);
    $dLng = floatval($_GET['destLng'] ?? 0);

    $url = 'https://maps.googleapis.com/maps/api/directions/json?' . http_build_query([
        'origin'      => "$oLat,$oLng",
        'destination' => "$dLat,$dLng",
        'mode'        => 'driving',
        'key'         => GOOGLE_API_KEY,
    ]);

    $response = json_decode(httpGet($url), true);

    if (($response['status'] ?? '') !== 'OK') {
        echo json_encode(['error' => 'Route not found: ' . ($response['status'] ?? 'unknown')]);
        exit;
    }

    $polyline  = $response['routes'][0]['overview_polyline']['points'];
    $totalMeters = $response['routes'][0]['legs'][0]['distance']['value'];
    $decoded   = decodePolyline($polyline);
    $midpoint  = findRouteMidpoint($decoded, $totalMeters);

    echo json_encode(['midpoint' => $midpoint]);

} else {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid action']);
}

// --- Helpers ---

function decodePolyline($encoded) {
    $points = [];
    $index  = 0;
    $len    = strlen($encoded);
    $lat    = 0;
    $lng    = 0;

    while ($index < $len) {
        $shift = 0; $result = 0;
        do {
            $b = ord($encoded[$index++]) - 63;
            $result |= ($b & 0x1f) << $shift;
            $shift += 5;
        } while ($b >= 0x20);
        $lat += ($result & 1) ? ~($result >> 1) : ($result >> 1);

        $shift = 0; $result = 0;
        do {
            $b = ord($encoded[$index++]) - 63;
            $result |= ($b & 0x1f) << $shift;
            $shift += 5;
        } while ($b >= 0x20);
        $lng += ($result & 1) ? ~($result >> 1) : ($result >> 1);

        $points[] = ['lat' => $lat / 1e5, 'lng' => $lng / 1e5];
    }
    return $points;
}

function haversineKm($lat1, $lng1, $lat2, $lng2) {
    $R    = 6371;
    $dLat = deg2rad($lat2 - $lat1);
    $dLng = deg2rad($lng2 - $lng1);
    $a    = sin($dLat/2)**2 + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLng/2)**2;
    return $R * 2 * atan2(sqrt($a), sqrt(1 - $a));
}

function findRouteMidpoint($points, $totalMeters) {
    $targetKm    = ($totalMeters / 1000) / 2;
    $accumulated = 0.0;

    for ($i = 1; $i < count($points); $i++) {
        $seg = haversineKm(
            $points[$i-1]['lat'], $points[$i-1]['lng'],
            $points[$i]['lat'],   $points[$i]['lng']
        );
        if ($accumulated + $seg >= $targetKm) {
            $frac = $seg > 0 ? ($targetKm - $accumulated) / $seg : 0;
            return [
                'lat' => $points[$i-1]['lat'] + $frac * ($points[$i]['lat'] - $points[$i-1]['lat']),
                'lng' => $points[$i-1]['lng'] + $frac * ($points[$i]['lng'] - $points[$i-1]['lng']),
            ];
        }
        $accumulated += $seg;
    }
    return end($points);
}
