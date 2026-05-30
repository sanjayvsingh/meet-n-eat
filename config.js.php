<?php
ini_set('display_errors', 0);
error_reporting(0);
header('Content-Type: application/javascript');
require_once __DIR__ . '/config.php';
$token = defined('MAPBOX_TOKEN') ? trim(MAPBOX_TOKEN) : '';
echo 'window.MAPBOX_TOKEN = ' . json_encode($token) . ';';
