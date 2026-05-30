<?php
ini_set('display_errors', 0);
error_reporting(0);

header('Content-Type: application/json');

if (!file_exists(__DIR__ . '/config.php')) {
    http_response_code(500);
    echo json_encode(['error' => 'config.php not found on server']);
    exit;
}
require_once 'config.php';

$action = $_GET['action'] ?? '';

// --- HTTP helpers ---

function httpGet($url, $headers = []) {
    if (!function_exists('curl_init')) {
        if (ini_get('allow_url_fopen') && empty($headers)) {
            return file_get_contents($url);
        }
        http_response_code(502);
        echo json_encode(['error' => 'curl unavailable']);
        exit;
    }
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    if ($headers) curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    $result = curl_exec($ch);
    $err    = curl_error($ch);
    curl_close($ch);
    if ($result === false) {
        http_response_code(502);
        echo json_encode(['error' => 'curl failed: ' . $err]);
        exit;
    }
    return $result;
}

function httpPost($url, $body, $headers = []) {
    if (!function_exists('curl_init')) {
        http_response_code(502);
        echo json_encode(['error' => 'curl unavailable']);
        exit;
    }
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    curl_setopt($ch, CURLOPT_HTTPHEADER, array_merge(['Content-Type: application/json'], $headers));
    $result = curl_exec($ch);
    $err    = curl_error($ch);
    curl_close($ch);
    if ($result === false) {
        http_response_code(502);
        echo json_encode(['error' => 'curl failed: ' . $err]);
        exit;
    }
    return $result;
}

$authHeader = 'X-Goog-Api-Key: ' . GOOGLE_API_KEY;

// --- Actions ---

if ($action === 'autocomplete') {
    $input = trim($_GET['input'] ?? '');
    if ($input === '') { echo json_encode(['predictions' => []]); exit; }

    $body = [
        'input'               => $input,
        'includedRegionCodes' => ['ca', 'us'],
    ];
    $lat = floatval($_GET['lat'] ?? 0);
    $lng = floatval($_GET['lng'] ?? 0);
    if ($lat !== 0.0 || $lng !== 0.0) {
        $body['locationBias'] = [
            'circle' => [
                'center' => ['latitude' => $lat, 'longitude' => $lng],
                'radius' => 50000.0,
            ],
        ];
    }

    $data = json_decode(
        httpPost('https://places.googleapis.com/v1/places:autocomplete', $body, [$authHeader]),
        true
    );

    // Normalize to legacy format — app.js expects predictions[].place_id + .description
    $predictions = [];
    foreach ($data['suggestions'] ?? [] as $s) {
        $pp = $s['placePrediction'] ?? null;
        if (!$pp) continue;
        $predictions[] = [
            'place_id'              => $pp['placeId'] ?? '',
            'description'           => $pp['text']['text'] ?? '',
            'structured_formatting' => [
                'main_text'      => $pp['structuredFormat']['mainText']['text'] ?? '',
                'secondary_text' => $pp['structuredFormat']['secondaryText']['text'] ?? '',
            ],
        ];
    }
    echo json_encode(['predictions' => $predictions]);

} elseif ($action === 'placedetails') {
    $placeId = trim($_GET['place_id'] ?? '');
    if ($placeId === '') { http_response_code(400); echo json_encode(['error' => 'Missing place_id']); exit; }

    $p = json_decode(
        httpGet(
            'https://places.googleapis.com/v1/places/' . urlencode($placeId),
            [$authHeader, 'X-Goog-FieldMask: location,displayName,formattedAddress']
        ),
        true
    );

    // Normalize to legacy format — app.js expects result.geometry.location + result.formatted_address
    echo json_encode([
        'result' => [
            'geometry'          => [
                'location' => [
                    'lat' => $p['location']['latitude']  ?? 0,
                    'lng' => $p['location']['longitude'] ?? 0,
                ],
            ],
            'name'              => $p['displayName']['text'] ?? '',
            'formatted_address' => $p['formattedAddress']   ?? '',
        ],
    ]);

} elseif ($action === 'places') {
    $lat    = floatval($_GET['lat']    ?? 0);
    $lng    = floatval($_GET['lng']    ?? 0);
    $radius = min(max(floatval($_GET['radius'] ?? 5000), 500), 50000);

    $data = json_decode(
        httpPost(
            'https://places.googleapis.com/v1/places:searchNearby',
            [
                'locationRestriction' => [
                    'circle' => [
                        'center' => ['latitude' => $lat, 'longitude' => $lng],
                        'radius' => $radius,
                    ],
                ],
                'includedTypes'   => ['restaurant'],
                'rankPreference'  => 'DISTANCE',
                'maxResultCount'  => 20,
            ],
            [
                $authHeader,
                'X-Goog-FieldMask: places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.types,places.formattedAddress,places.location',
            ]
        ),
        true
    );

    $priceMap = [
        'PRICE_LEVEL_FREE'          => 0,
        'PRICE_LEVEL_INEXPENSIVE'   => 1,
        'PRICE_LEVEL_MODERATE'      => 2,
        'PRICE_LEVEL_EXPENSIVE'     => 3,
        'PRICE_LEVEL_VERY_EXPENSIVE'=> 4,
    ];

    // Normalize to legacy field names — app.js uses place_id, name, geometry.location, etc.
    $results = [];
    foreach ($data['places'] ?? [] as $p) {
        $results[] = [
            'place_id'          => $p['id'] ?? '',
            'name'              => $p['displayName']['text'] ?? '',
            'rating'            => $p['rating'] ?? null,
            'user_ratings_total'=> $p['userRatingCount'] ?? 0,
            'price_level'       => isset($p['priceLevel']) ? ($priceMap[$p['priceLevel']] ?? null) : null,
            'opening_hours'     => isset($p['currentOpeningHours']['openNow'])
                                    ? ['open_now' => $p['currentOpeningHours']['openNow']]
                                    : null,
            'types'             => $p['types'] ?? [],
            'vicinity'          => $p['formattedAddress'] ?? '',
            'geometry'          => [
                'location' => [
                    'lat' => $p['location']['latitude']  ?? 0,
                    'lng' => $p['location']['longitude'] ?? 0,
                ],
            ],
        ];
    }
    echo json_encode(['status' => 'OK', 'results' => $results]);

} elseif ($action === 'route') {
    $oLat = floatval($_GET['originLat'] ?? 0);
    $oLng = floatval($_GET['originLng'] ?? 0);
    $dLat = floatval($_GET['destLat']   ?? 0);
    $dLng = floatval($_GET['destLng']   ?? 0);

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

    $polyline    = $response['routes'][0]['overview_polyline']['points'];
    $totalMeters = $response['routes'][0]['legs'][0]['distance']['value'];
    $decoded     = decodePolyline($polyline);
    $midpoint    = findRouteMidpoint($decoded, $totalMeters);

    echo json_encode(['midpoint' => $midpoint]);

} else {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid action']);
}

// --- Helpers (route midpoint) ---

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
