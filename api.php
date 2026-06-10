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
        error_log('meet-n-eat httpGet error: ' . $err);
        http_response_code(502);
        echo json_encode(['error' => 'Service temporarily unavailable']);
        exit;
    }
    return $result;
}

function httpPost($url, $body, $headers = []) {
    if (!function_exists('curl_init')) {
        http_response_code(502);
        echo json_encode(['error' => 'Service temporarily unavailable']);
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
        error_log('meet-n-eat httpPost error: ' . $err);
        http_response_code(502);
        echo json_encode(['error' => 'Service temporarily unavailable']);
        exit;
    }
    return $result;
}

$authHeader = 'X-Goog-Api-Key: ' . GOOGLE_API_KEY;

// --- Actions ---

if ($action === 'autocomplete') {
    $input = trim($_GET['input'] ?? '');
    if ($input === '' || strlen($input) > 200) { echo json_encode(['predictions' => []]); exit; }

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
    if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid coordinates']);
        exit;
    }

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
                'excludedTypes'   => ['fast_food_restaurant', 'coffee_shop', 'cafe'],
                'rankPreference'  => 'DISTANCE',
                'maxResultCount'  => 20,
            ],
            [
                $authHeader,
                'X-Goog-FieldMask: places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.types,places.primaryTypeDisplayName,places.formattedAddress,places.location',
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
    // Skip price_level 1 (INEXPENSIVE) — fast food / budget chains not suitable for meetups.
    $results = [];
    foreach ($data['places'] ?? [] as $p) {
        $pl = isset($p['priceLevel']) ? ($priceMap[$p['priceLevel']] ?? null) : null;
        if ($pl === 1) continue;
        // Filter to 3+ stars only
        if (($p['rating'] ?? 0) < 3.0) continue;
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
            'primary_type'      => $p['primaryTypeDisplayName']['text'] ?? null,
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
    $trimmed    = trimPolylinePoints($decoded, $totalMeters, 0.25, 0.75);
    $p33        = findRoutePoint($decoded, $totalMeters, 1/3);
    $p50        = findRoutePoint($decoded, $totalMeters, 0.5);
    $p67        = findRoutePoint($decoded, $totalMeters, 2/3);

    // Radius scales with straight-line distance (same formula as the old JS side).
    $distanceKm = haversineKm($oLat, $oLng, $dLat, $dLng);
    $radiusKm   = max(min($distanceKm * 0.35, 15.0), 1.5);
    $radiusM    = (int) round($radiusKm * 1000);

    // Three sequential Nearby Searches done server-side so the browser only
    // makes one request — avoids the mod_evasive rate-limit on rapid GETs.
    $excludedTypes = ['fast_food_restaurant', 'coffee_shop', 'cafe'];
    $priceMap = [
        'PRICE_LEVEL_FREE'           => 0,
        'PRICE_LEVEL_INEXPENSIVE'    => 1,
        'PRICE_LEVEL_MODERATE'       => 2,
        'PRICE_LEVEL_EXPENSIVE'      => 3,
        'PRICE_LEVEL_VERY_EXPENSIVE' => 4,
    ];

    $seen    = [];
    $results = [];
    foreach ([$p33, $p50, $p67] as $pt) {
        $pData = json_decode(
            httpPost(
                'https://places.googleapis.com/v1/places:searchNearby',
                [
                    'locationRestriction' => [
                        'circle' => [
                            'center' => ['latitude' => $pt['lat'], 'longitude' => $pt['lng']],
                            'radius' => $radiusM,
                        ],
                    ],
                    'includedTypes'  => ['restaurant'],
                    'excludedTypes'  => $excludedTypes,
                    'rankPreference' => 'DISTANCE',
                    'maxResultCount' => 20,
                ],
                [
                    $authHeader,
                    'X-Goog-FieldMask: places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.types,places.primaryTypeDisplayName,places.formattedAddress,places.location',
                ]
            ),
            true
        );

        foreach ($pData['places'] ?? [] as $p) {
            $id = $p['id'] ?? '';
            if (!$id || isset($seen[$id])) continue;
            $seen[$id] = true;
            $pl = isset($p['priceLevel']) ? ($priceMap[$p['priceLevel']] ?? null) : null;
            if ($pl === 1) continue;
            // Filter to 3+ stars only
            if (($p['rating'] ?? 0) < 3.0) continue;
            $types = $p['types'] ?? [];
            $results[] = [
                'place_id'           => $id,
                'name'               => $p['displayName']['text'] ?? '',
                'rating'             => $p['rating'] ?? null,
                'user_ratings_total' => $p['userRatingCount'] ?? 0,
                'price_level'        => $pl,
                'opening_hours'      => isset($p['currentOpeningHours']['openNow'])
                                         ? ['open_now' => $p['currentOpeningHours']['openNow']]
                                         : null,
                'types'              => $types,
                'primary_type'       => $p['primaryTypeDisplayName']['text'] ?? null,
                'vicinity'           => $p['formattedAddress'] ?? '',
                'geometry'           => [
                    'location' => [
                        'lat' => $p['location']['latitude']  ?? 0,
                        'lng' => $p['location']['longitude'] ?? 0,
                    ],
                ],
            ];
        }
    }

    echo json_encode([
        'midpoint'        => $p50,
        'p33'             => $p33,
        'p67'             => $p67,
        'polyline'        => $decoded,
        'trimmedPolyline' => $trimmed,
        'radiusKm'        => $radiusKm,
        'results'         => $results,
    ]);

} elseif ($action === 'mylocation') {
    $ip = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '';
    if (!$ip) {
        echo json_encode(['lat' => 43.8, 'lng' => -79.3]);
        exit;
    }

    $result = @httpGet('http://ip-api.com/json/' . urlencode($ip) . '?fields=lat,lon,status');
    if (!$result) {
        echo json_encode(['lat' => 43.8, 'lng' => -79.3]);
        exit;
    }

    $data = json_decode($result, true);
    if (($data['status'] ?? '') === 'success') {
        echo json_encode(['lat' => $data['lat'] ?? 43.8, 'lng' => $data['lon'] ?? -79.3]);
    } else {
        echo json_encode(['lat' => 43.8, 'lng' => -79.3]);
    }

} elseif ($action === 'nearbyme') {
    $lat    = floatval($_GET['lat']    ?? 0);
    $lng    = floatval($_GET['lng']    ?? 0);
    if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid coordinates']);
        exit;
    }

    $radius = 5000;

    $priceMap = [
        'PRICE_LEVEL_FREE'          => 0,
        'PRICE_LEVEL_INEXPENSIVE'   => 1,
        'PRICE_LEVEL_MODERATE'      => 2,
        'PRICE_LEVEL_EXPENSIVE'     => 3,
        'PRICE_LEVEL_VERY_EXPENSIVE'=> 4,
    ];

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
                'excludedTypes'   => ['fast_food_restaurant', 'coffee_shop', 'cafe'],
                'rankPreference'  => 'DISTANCE',
                'maxResultCount'  => 20,
            ],
            [
                $authHeader,
                'X-Goog-FieldMask: places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.types,places.primaryTypeDisplayName,places.formattedAddress,places.location',
            ]
        ),
        true
    );

    error_log('nearbyme response places count: ' . count($data['places'] ?? []));
    if (!empty($data['places'])) {
        error_log('First place from Google: ' . json_encode($data['places'][0]));
    }

    $results = [];
    foreach ($data['places'] ?? [] as $p) {
        $pl = isset($p['priceLevel']) ? ($priceMap[$p['priceLevel']] ?? null) : null;
        error_log('places action - place: ' . ($p['displayName']['text'] ?? 'unknown') . ', rating: ' . ($p['rating'] ?? 'null') . ', has priceLevel: ' . (isset($p['priceLevel']) ? 'yes (' . $p['priceLevel'] . ')' : 'no'));
        if ($pl === 1) continue;
        // Filter to 3+ stars only
        if (($p['rating'] ?? 0) < 3.0) continue;
        $results[] = [
            'place_id'          => $p['id'] ?? '',
            'name'              => $p['displayName']['text'] ?? '',
            'rating'            => $p['rating'] ?? null,
            'user_ratings_total'=> $p['userRatingCount'] ?? 0,
            'price_level'       => $pl,
            'opening_hours'     => isset($p['currentOpeningHours']['openNow'])
                                    ? ['open_now' => $p['currentOpeningHours']['openNow']]
                                    : null,
            'types'             => $p['types'] ?? [],
            'primary_type'      => $p['primaryTypeDisplayName']['text'] ?? null,
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

function trimPolylinePoints($points, $totalMeters, $fromFraction, $toFraction) {
    $fromKm      = ($totalMeters / 1000) * $fromFraction;
    $toKm        = ($totalMeters / 1000) * $toFraction;
    $accumulated = 0.0;
    $result      = [];

    for ($i = 1; $i < count($points); $i++) {
        $seg    = haversineKm(
            $points[$i-1]['lat'], $points[$i-1]['lng'],
            $points[$i]['lat'],   $points[$i]['lng']
        );
        $segEnd = $accumulated + $seg;

        if ($segEnd > $fromKm && $accumulated < $toKm) {
            if (empty($result)) {
                $frac     = $seg > 0 ? max(0.0, ($fromKm - $accumulated) / $seg) : 0.0;
                $result[] = [
                    'lat' => $points[$i-1]['lat'] + $frac * ($points[$i]['lat'] - $points[$i-1]['lat']),
                    'lng' => $points[$i-1]['lng'] + $frac * ($points[$i]['lng'] - $points[$i-1]['lng']),
                ];
            }
            if ($segEnd <= $toKm) {
                $result[] = $points[$i];
            } else {
                $frac     = $seg > 0 ? min(1.0, ($toKm - $accumulated) / $seg) : 1.0;
                $result[] = [
                    'lat' => $points[$i-1]['lat'] + $frac * ($points[$i]['lat'] - $points[$i-1]['lat']),
                    'lng' => $points[$i-1]['lng'] + $frac * ($points[$i]['lng'] - $points[$i-1]['lng']),
                ];
                break;
            }
        }

        $accumulated += $seg;
    }

    return $result ?: $points;
}

function encodePolylineValue($v) {
    $v   = $v < 0 ? ~($v << 1) : ($v << 1);
    $out = '';
    while ($v >= 0x20) {
        $out .= chr((0x20 | ($v & 0x1f)) + 63);
        $v >>= 5;
    }
    return $out . chr($v + 63);
}

function encodePolyline($points) {
    $encoded = '';
    $prevLat = 0;
    $prevLng = 0;
    foreach ($points as $p) {
        $lat     = (int) round($p['lat'] * 1e5);
        $lng     = (int) round($p['lng'] * 1e5);
        $encoded .= encodePolylineValue($lat - $prevLat);
        $encoded .= encodePolylineValue($lng - $prevLng);
        $prevLat = $lat;
        $prevLng = $lng;
    }
    return $encoded;
}

function findRoutePoint($points, $totalMeters, $fraction) {
    $targetKm    = ($totalMeters / 1000) * $fraction;
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
