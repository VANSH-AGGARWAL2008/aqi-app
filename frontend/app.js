// ─────────────────────────────────────────────
// app.js
// Main application logic for the Delhi AQI Map.
// ─────────────────────────────────────────────

// ── Backend URL Configuration ────────────────────────────────────────────────
// If opened on port 5500 (Live Server during local development), use "http://localhost:8000".
// Otherwise, use "" (same server, relative URLs like /api/stations).
const API_BASE = (window.location.port === "5500")
  ? "http://localhost:8000"
  : "";


// ── IDW tuning constants ──────────────────────────────────────────────────────
// Change IDW_POWER to experiment with how fast station influence drops off.
//   Lower  (e.g. 1.0) → farther stations still matter a lot → very smooth.
//   Higher (e.g. 3.0) → influence drops sharply → tighter halos around stations.
var IDW_POWER = 2.2;

// Maximum radius (km) within which a station influences a cell.
// Stations farther than this are ignored, UNLESS fewer than IDW_MIN_STATIONS
// are in range – in that case the nearest IDW_MIN_STATIONS are used instead.
var IDW_MAX_DIST_KM   = 12;
var IDW_MIN_STATIONS  = 3;

// 1 degree of latitude ≈ 111 km. Used to convert km threshold → degrees.
var KM_PER_DEG = 111;


// ── 1. AQI Scales: India NAQI (CPCB) & US EPA Standards ──────────────────────

// Active AQI scale: "india" (default) or "us"
// Stored in localStorage so user preference persists across reloads
var currentAqiScale = "india";
try {
  var storedScale = localStorage.getItem("preferred_aqi_scale");
  if (storedScale === "us" || storedScale === "india") {
    currentAqiScale = storedScale;
  }
} catch (e) {}

// ══════════════════════════════════════════════════════════════════════════════
// INDIA NATIONAL AIR QUALITY INDEX (NAQI) CONFIGURATION & BREAKPOINTS (CPCB)
// ══════════════════════════════════════════════════════════════════════════════
// Official standard established by Central Pollution Control Board (CPCB),
// Ministry of Environment, Forest & Climate Change, Government of India.
//
// Categories & AQI Bands:
//   Good:           0 – 50    (Green #00b050)
//   Satisfactory:  51 – 100   (Light Green #92d050)
//   Moderate:     101 – 200   (Yellow #eab308)
//   Poor:         201 – 300   (Orange #ff9900)
//   Very Poor:    301 – 400   (Red #ff0000)
//   Severe:       401 – 500   (Purple #7030a0)
//
// Breakpoint tables for 24-hour concentration averages in µg/m³:
var INDIA_NAQI_CONFIG = {
  categories: [
    { min: 0,   max: 50,  label: "Good",         color: "#00b050", textColor: "#ffffff" },
    { min: 51,  max: 100, label: "Satisfactory", color: "#92d050", textColor: "#111111" },
    { min: 101, max: 200, label: "Moderate",     color: "#eab308", textColor: "#111111" },
    { min: 201, max: 300, label: "Poor",         color: "#ff9900", textColor: "#ffffff" },
    { min: 301, max: 400, label: "Very Poor",    color: "#ff0000", textColor: "#ffffff" },
    { min: 401, max: 500, label: "Severe",       color: "#7030a0", textColor: "#ffffff" }
  ],
  breakpoints: {
    // PM2.5 breakpoints (µg/m³) -> AQI sub-index range
    pm25: [
      { bLo: 0,   bHi: 30,  iLo: 0,   iHi: 50 },
      { bLo: 31,  bHi: 60,  iLo: 51,  iHi: 100 },
      { bLo: 61,  bHi: 90,  iLo: 101, iHi: 200 },
      { bLo: 91,  bHi: 120, iLo: 201, iHi: 300 },
      { bLo: 121, bHi: 250, iLo: 301, iHi: 400 },
      { bLo: 251, bHi: 500, iLo: 401, iHi: 500 }
    ],
    // PM10 breakpoints (µg/m³) -> AQI sub-index range
    pm10: [
      { bLo: 0,   bHi: 50,  iLo: 0,   iHi: 50 },
      { bLo: 51,  bHi: 100, iLo: 51,  iHi: 100 },
      { bLo: 101, bHi: 250, iLo: 101, iHi: 200 },
      { bLo: 251, bHi: 350, iLo: 201, iHi: 300 },
      { bLo: 351, bHi: 430, iLo: 301, iHi: 400 },
      { bLo: 431, bHi: 600, iLo: 401, iHi: 500 }
    ]
  }
};

// Sub-index linear interpolation formula:
// Ip = [ (I_hi - I_lo) / (B_hi - B_lo) ] * (Cp - B_lo) + I_lo
function calcSubIndex(concentration, breakpoints) {
  if (concentration === null || concentration === undefined || isNaN(concentration) || concentration < 0) {
    return null;
  }
  for (var i = 0; i < breakpoints.length; i++) {
    var bp = breakpoints[i];
    if (concentration >= bp.bLo && concentration <= bp.bHi) {
      var sub = ((bp.iHi - bp.iLo) / (bp.bHi - bp.bLo)) * (concentration - bp.bLo) + bp.iLo;
      return Math.round(sub);
    }
  }
  // When concentration exceeds top boundary, clamp to top sub-index (500)
  var last = breakpoints[breakpoints.length - 1];
  if (concentration > last.bHi) {
    return last.iHi;
  }
  return null;
}

// Compute India NAQI as maximum of PM2.5 and PM10 sub-indices
function computeIndiaNaqi(pm25, pm10) {
  var sub25 = calcSubIndex(pm25, INDIA_NAQI_CONFIG.breakpoints.pm25);
  var sub10 = calcSubIndex(pm10, INDIA_NAQI_CONFIG.breakpoints.pm10);

  if (sub25 !== null && sub10 !== null) {
    return Math.max(sub25, sub10);
  }
  if (sub25 !== null) return sub25;
  if (sub10 !== null) return sub10;
  return null;
}

// Determine station AQI according to active scale, with automatic US fallback
function getStationAqi(station, scale) {
  scale = scale || currentAqiScale || "india";
  var usAqi = (station.usAqi !== undefined && station.usAqi !== null)
    ? station.usAqi
    : ((station.aqi !== undefined && station.aqi !== null) ? station.aqi : 0);

  if (scale === "india") {
    var pm25 = (station.pm25 !== undefined && station.pm25 !== null && !isNaN(station.pm25)) ? Number(station.pm25) : null;
    var pm10 = (station.pm10 !== undefined && station.pm10 !== null && !isNaN(station.pm10)) ? Number(station.pm10) : null;

    var indNaqi = computeIndiaNaqi(pm25, pm10);
    if (indNaqi !== null) {
      return {
        value: indNaqi,
        scale: "india",
        isFallback: false,
        label: getAqiLabel(indNaqi, "india"),
        color: getAqiColor(indNaqi, "india")
      };
    }

    // Credibility requirement: If PM values are missing for a station,
    // fall back to the US scale for that station and label it.
    return {
      value: usAqi,
      scale: "us",
      isFallback: true,
      label: getAqiLabel(usAqi, "us"),
      color: getAqiColor(usAqi, "us")
    };
  }

  // Scale is US EPA
  return {
    value: usAqi,
    scale: "us",
    isFallback: false,
    label: getAqiLabel(usAqi, "us"),
    color: getAqiColor(usAqi, "us")
  };
}

// Color coding according to standard
function getAqiColor(aqi, scale) {
  scale = scale || currentAqiScale || "india";

  if (scale === "india") {
    if (aqi <= 50)  return "#00b050"; // Good          – green
    if (aqi <= 100) return "#92d050"; // Satisfactory  – light green
    if (aqi <= 200) return "#eab308"; // Moderate      – yellow/amber
    if (aqi <= 300) return "#ff9900"; // Poor          – orange
    if (aqi <= 400) return "#ff0000"; // Very Poor     – red
    return                 "#7030a0"; // Severe        – purple
  }

  // US EPA AQI categories
  if (aqi <= 50)  return "#00e400"; // Good          – green
  if (aqi <= 100) return "#ffff00"; // Moderate      – yellow
  if (aqi <= 150) return "#ff7e00"; // Unhealthy/Sens– orange
  if (aqi <= 200) return "#ff0000"; // Unhealthy     – red
  if (aqi <= 300) return "#8f3f97"; // Very Unhealthy– purple
  return                 "#7e0023"; // Hazardous     – maroon
}

// Category text labels
function getAqiLabel(aqi, scale) {
  scale = scale || currentAqiScale || "india";

  if (scale === "india") {
    if (aqi <= 50)  return "Good";
    if (aqi <= 100) return "Satisfactory";
    if (aqi <= 200) return "Moderate";
    if (aqi <= 300) return "Poor";
    if (aqi <= 400) return "Very Poor";
    return                 "Severe";
  }

  // US EPA
  if (aqi <= 50)  return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy (Sensitive)";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return                 "Hazardous";
}

// ── Continuous AQI color interpolators (for IDW estimate layer) ──────────────
var AQI_RAMP_US = [
  { aqi:   0, r:   0, g: 228, b:   0 }, // green (#00e400)
  { aqi:  50, r:   0, g: 228, b:   0 },
  { aqi: 100, r: 255, g: 255, b:   0 }, // yellow (#ffff00)
  { aqi: 150, r: 255, g: 126, b:   0 }, // orange (#ff7e00)
  { aqi: 200, r: 255, g:   0, b:   0 }, // red (#ff0000)
  { aqi: 300, r: 143, g:  63, b: 151 }, // purple (#8f3f97)
  { aqi: 500, r: 126, g:   0, b:  35 }, // maroon (#7e0023)
];

var AQI_RAMP_INDIA = [
  { aqi:   0, r:   0, g: 176, b:  80 }, // #00b050
  { aqi:  50, r:   0, g: 176, b:  80 },
  { aqi: 100, r: 146, g: 208, b:  80 }, // #92d050
  { aqi: 200, r: 234, g: 179, b:   8 }, // #eab308
  { aqi: 300, r: 255, g: 153, b:   0 }, // #ff9900
  { aqi: 400, r: 255, g:   0, b:   0 }, // #ff0000
  { aqi: 500, r: 112, g:  48, b: 160 }, // #7030a0
];

function getAqiColorContinuous(aqi, scale) {
  scale = scale || currentAqiScale || "india";
  var ramp = (scale === "india") ? AQI_RAMP_INDIA : AQI_RAMP_US;
  aqi = Math.max(0, Math.min(aqi, 500));

  for (var i = 0; i < ramp.length - 1; i++) {
    var lo = ramp[i];
    var hi = ramp[i + 1];
    if (aqi <= hi.aqi) {
      var t = (aqi - lo.aqi) / (hi.aqi - lo.aqi);
      return [
        Math.round(lo.r + t * (hi.r - lo.r)),
        Math.round(lo.g + t * (hi.g - lo.g)),
        Math.round(lo.b + t * (hi.b - lo.b)),
      ];
    }
  }
  var top = ramp[ramp.length - 1];
  return [top.r, top.g, top.b];
}


// ── IDW (Inverse Distance Weighting) estimator ──────────────────────────────
// Estimates the AQI at any lat/lng from the surrounding station readings.
//
// Influence radius: only stations within IDW_MAX_DIST_KM are used.
// If fewer than IDW_MIN_STATIONS qualify, the nearest IDW_MIN_STATIONS
// are used instead (so edge areas still get a reasonable estimate).
//
// You can reuse this function later (e.g. to score air quality along a route).
//
// Parameters:
//   lat, lng  – the point you want an estimate for
//   stations  – array of objects: [{ lat, lng, aqi }, …]
//   power     – how fast influence drops with distance (uses IDW_POWER if omitted)
//
// Returns: estimated AQI (a number).

function computeIdw(lat, lng, stations, power) {
  if (typeof power === "undefined") power = IDW_POWER;

  // Convert the km radius threshold to degrees (approximate, fine for a city).
  var maxDistDeg = IDW_MAX_DIST_KM / KM_PER_DEG;

  // Build a list of {dist, aqi} for every station, sorted by distance.
  var candidates = [];
  for (var i = 0; i < stations.length; i++) {
    var s = stations[i];
    var dLat = lat - s.lat;
    var dLng = lng - s.lng;
    var dist = Math.sqrt(dLat * dLat + dLng * dLng);

    var aqiVal = (s.displayAqi !== undefined && s.displayAqi !== null) ? s.displayAqi : s.aqi;

    // If the point sits almost exactly on a station, return its AQI directly
    // (also avoids dividing by ~zero).
    if (dist < 0.0001) return aqiVal;

    candidates.push({ dist: dist, aqi: aqiVal });
  }

  // Sort by distance so we can easily pick the nearest IDW_MIN_STATIONS.
  candidates.sort(function (a, b) { return a.dist - b.dist; });

  // Keep stations inside the radius; fall back to nearest IDW_MIN_STATIONS.
  var inRadius = candidates.filter(function (c) { return c.dist <= maxDistDeg; });
  var used = inRadius.length >= IDW_MIN_STATIONS
    ? inRadius
    : candidates.slice(0, IDW_MIN_STATIONS);

  var weightedSum = 0;
  var totalWeight = 0;

  for (var j = 0; j < used.length; j++) {
    // Weight = 1 / distance^power.  Closer → bigger weight.
    var w = 1 / Math.pow(used[j].dist, power);
    weightedSum += w * used[j].aqi;
    totalWeight += w;
  }

  // Weighted average.
  return totalWeight === 0 ? 0 : weightedSum / totalWeight;
}


// ── 2. Error banner helper ───────────────────────────────────────────────────
// Shows a red banner at the top of the screen with a message.

function showError(message) {
  const banner = document.getElementById("error-banner");
  banner.textContent = message;
  banner.style.display = "block";
}

function hideError() {
  const banner = document.getElementById("error-banner");
  if (banner) banner.style.display = "none";
}

// HTML escaping helper to prevent XSS when inserting dynamic text into DOM
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── 3. Leaflet Map Setup ──────────────────────────────────────────────────


// ── 4. Initialise the Leaflet map ────────────────────────────────────────────
// Restrict view strictly to Delhi NCR:
// - Bounds: [[28.20, 76.70], [29.00, 77.60]]
// - maxBoundsViscosity: 1.0 (hard wall prevents panning outside NCR)
// - minZoom: 9 (prevents zooming out past the NCR region)
// - maxZoom: 17 (street-level detail)
// - Initial view fits the full Delhi NCR bounding box

const DELHI_NCR_BOUNDS = L.latLngBounds([
  [28.20, 76.70], // South-West (min_lat, min_lon)
  [29.00, 77.60]  // North-East (max_lat, max_lon)
]);

const map = L.map("map", {
  maxBounds: DELHI_NCR_BOUNDS,
  maxBoundsViscosity: 1.0,
  minZoom: 9,
  maxZoom: 17
});

// Fit the map view to the Delhi NCR bounds on load
map.fitBounds(DELHI_NCR_BOUNDS);

// Add OpenStreetMap tiles as the background layer.
// Attribution is required by the OSM licence.
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  minZoom: 9,
  maxZoom: 17,
}).addTo(map);


// ── 5. Legend ────────────────────────────────────────────────────────────────
// Displays standard AQI category bands and colors for India NAQI or US EPA AQI.

const legend = L.control({ position: "bottomright" });
var legendContainer = null;

function updateLegend() {
  if (!legendContainer) return;
  var isIndia = (currentAqiScale === "india");
  var title = isIndia ? "India NAQI (CPCB)" : "US AQI (EPA)";
  var bands = isIndia ? [
    ["#00b050", "0 – 50: Good"],
    ["#92d050", "51 – 100: Satisfactory"],
    ["#eab308", "101 – 200: Moderate"],
    ["#ff9900", "201 – 300: Poor"],
    ["#ff0000", "301 – 400: Very Poor"],
    ["#7030a0", "401+: Severe"]
  ] : [
    ["#00e400", "0 – 50: Good"],
    ["#ffff00", "51 – 100: Moderate"],
    ["#ff7e00", "101 – 150: Unhealthy (Sens.)"],
    ["#ff0000", "151 – 200: Unhealthy"],
    ["#8f3f97", "201 – 300: Very Unhealthy"],
    ["#7e0023", "301+: Hazardous"]
  ];

  var html = '<div class="legend-title">' + title + '</div>';
  bands.forEach(function (b) {
    html +=
      '<div class="legend-item">' +
        '<div class="legend-swatch" style="background:' + b[0] + '"></div>' +
        '<span>' + b[1] + '</span>' +
      '</div>';
  });

  if (isIndia) {
    html += '<div style="font-size:10px;color:var(--text-secondary);margin-top:6px;border-top:1px solid var(--border-color);padding-top:4px;">*Stations without raw PM data show US scale fallback.</div>';
  }

  legendContainer.innerHTML = html;
}

legend.onAdd = function () {
  legendContainer = L.DomUtil.create("div", "legend");
  legendContainer.id = "map-legend-box";
  updateLegend();
  return legendContainer;
};

legend.addTo(map);


// ── 6. Station stats box ─────────────────────────────────────────────────────
// A small info box in the top-left corner that shows how many stations
// were returned by the API and how many were skipped (no valid AQI).
// The text is filled in after the API call finishes (see section 7 below).

const statsBox = L.control({ position: "topleft" });

statsBox.onAdd = function () {
  // Create the container div; "stats-box" is styled in style.css
  const div = L.DomUtil.create("div", "stats-box");
  div.id = "stats-box";
  div.textContent = "Loading stations…";
  return div;
};

statsBox.addTo(map);


// ── 7. Fetch AQI stations and draw markers ───────────────────────────────────
// The WAQI "map/bounds" endpoint returns all monitoring stations
// within the given bounding box (lat/lng rectangle around Delhi).

const DELHI_BOUNDS = "28.40,76.84,28.88,77.35"; // south,west,north,east
const API_URL = API_BASE + "/api/stations?bounds=" + encodeURIComponent(DELHI_BOUNDS);

// A Leaflet LayerGroup holds all station markers.
// Clearing this group removes every old marker before we draw fresh ones,
// so markers don't pile up on each refresh.
const stationMarkers = L.layerGroup().addTo(map);


// ── IDW estimate grid layer ──────────────────────────────────────────────────
// A custom canvas-based tile layer that paints the IDW colour grid.
// Using L.GridLayer with canvas tiles is fast: Leaflet only creates tiles
// for the visible area and caches them automatically.

// Create a custom map pane so the IDW grid draws BELOW the station markers.
// Default overlayPane z-index is 400; we use 350 so markers sit on top.
map.createPane("idwPane");
map.getPane("idwPane").style.zIndex = 350;
map.getPane("idwPane").style.pointerEvents = "none"; // clicks pass through

// Grid cell size in degrees (~500 m at Delhi's latitude).
var IDW_CELL = 0.005;

// Delhi bounding box edges (same rectangle used for the API call).
var DELHI_SOUTH = 28.40;
var DELHI_NORTH = 28.88;
var DELHI_WEST  = 76.84;
var DELHI_EAST  = 77.35;

// ── Helper: hex color string → [r, g, b] integers ───────────────────────────
// Needed so we can embed RGB values into rgba() strings.
function hexToRgb(hex) {
  var n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ── Helper: build and smooth the full AQI grid ──────────────────────────────
// Returns a 2-D array grid[row][col] = { r, g, b, alpha }.
//
// Steps:
//   1. Raw IDW – compute an AQI estimate for every cell.
//   2. 4-neighbour blur – average each cell with its N/S/E/W neighbours once.
//   3. Continuous colour – map the smoothed AQI to interpolated RGB.
//   4. Edge fade – cells near the grid border get lower alpha so the layer
//      dissolves instead of ending in a hard rectangle.

function buildSmoothedGrid(stations) {
  // Grid dimensions.
  var cols = Math.ceil((DELHI_EAST  - DELHI_WEST)  / IDW_CELL);
  var rows = Math.ceil((DELHI_NORTH - DELHI_SOUTH) / IDW_CELL);

  // ── Step 1: raw IDW pass ──────────────────────────────────────────────────
  var rawAqi = [];
  for (var r = 0; r < rows; r++) {
    rawAqi[r] = [];
    var lat = DELHI_SOUTH + (r + 0.5) * IDW_CELL;
    for (var c = 0; c < cols; c++) {
      var lng = DELHI_WEST + (c + 0.5) * IDW_CELL;
      rawAqi[r][c] = computeIdw(lat, lng, stations);
    }
  }

  // ── Step 2: one 4-neighbour (N/S/E/W) box-blur ───────────────────────────
  // Averages each cell with its immediate up/down/left/right neighbours only
  // (not diagonals). This is gentler than the old 3×3 blur so the layer
  // stays closer to the real station values while still removing block edges.
  var smoothAqi = [];
  for (var r = 0; r < rows; r++) {
    smoothAqi[r] = [];
    for (var c = 0; c < cols; c++) {
      var sum   = rawAqi[r][c];
      var count = 1;
      if (r > 0)       { sum += rawAqi[r - 1][c]; count++; } // north
      if (r < rows-1)  { sum += rawAqi[r + 1][c]; count++; } // south
      if (c > 0)       { sum += rawAqi[r][c - 1]; count++; } // west
      if (c < cols-1)  { sum += rawAqi[r][c + 1]; count++; } // east
      smoothAqi[r][c] = sum / count;
    }
  }

  // ── Step 3 + 4: continuous colour and edge-fade alpha ────────────────────
  // Edge fade: cells within FADE_CELLS of any border ramp their opacity from
  // 0 (at the very edge) up to full (IDW_ALPHA) at FADE_CELLS inward.
  var FADE_CELLS = 5;   // number of cells over which to fade
  var IDW_ALPHA  = 0.45;

  var grid = [];
  for (var r = 0; r < rows; r++) {
    grid[r] = [];
    for (var c = 0; c < cols; c++) {
      // How many cells from the nearest edge?
      var edgeDist = Math.min(r, rows - 1 - r, c, cols - 1 - c);
      // Ramp alpha from 0 → IDW_ALPHA over FADE_CELLS.
      var alpha = IDW_ALPHA * Math.min(1, edgeDist / FADE_CELLS);

      var rgb = getAqiColorContinuous(smoothAqi[r][c]);
      grid[r][c] = { r: rgb[0], g: rgb[1], b: rgb[2], alpha: alpha };
    }
  }

  return { grid: grid, rows: rows, cols: cols };
}

// Define a custom Leaflet GridLayer subclass for the IDW canvas tiles.
var IdwGridLayer = L.GridLayer.extend({
  options: {
    pane: "idwPane",   // draw on our custom pane (behind markers)
    opacity: 1,        // we set per-cell alpha on the canvas instead
  },

  // Call this whenever station data changes (e.g. on each 10-min refresh).
  // Precomputes the full smoothed grid once so every tile can read from it
  // instantly without re-running IDW per tile.
  setStations: function (stations) {
    if (stations && stations.length > 0) {
      var result = buildSmoothedGrid(stations);
      this._grid = result.grid;
      this._gridRows = result.rows;
      this._gridCols = result.cols;
    } else {
      this._grid = null;
    }
    if (this._map) this.redraw();
    return this;
  },

  // Leaflet calls createTile() for every 256×256 tile it needs to show.
  // We look up precomputed grid values and paint each cell onto the canvas.
  createTile: function (coords) {
    var tile = document.createElement("canvas");
    var size = this.getTileSize();
    tile.width  = size.x;
    tile.height = size.y;

    if (!this._grid) return tile; // nothing to draw yet

    var ctx = tile.getContext("2d");

    // Pixel origin of this tile in the global pixel grid at this zoom.
    var nwPoint = L.point(coords.x * size.x, coords.y * size.y);

    // Geographic bounds of this tile.
    var nw = this._map.unproject(nwPoint, coords.z);
    var se = this._map.unproject(nwPoint.add(size), coords.z);

    // Clamp to Delhi bounds so we don't waste time outside the city.
    var south = Math.max(se.lat, DELHI_SOUTH);
    var north = Math.min(nw.lat, DELHI_NORTH);
    var west  = Math.max(nw.lng, DELHI_WEST);
    var east  = Math.min(se.lng, DELHI_EAST);

    if (south >= north || west >= east) return tile; // tile is outside Delhi

    // Find the range of grid row/col indices that overlap this tile.
    var colStart = Math.max(0, Math.floor((west  - DELHI_WEST)  / IDW_CELL));
    var colEnd   = Math.min(this._gridCols - 1, Math.floor((east  - DELHI_WEST)  / IDW_CELL));
    var rowStart = Math.max(0, Math.floor((south - DELHI_SOUTH) / IDW_CELL));
    var rowEnd   = Math.min(this._gridRows - 1, Math.floor((north - DELHI_SOUTH) / IDW_CELL));

    for (var row = rowStart; row <= rowEnd; row++) {
      for (var col = colStart; col <= colEnd; col++) {
        var cell = this._grid[row][col];

        // Geographic corners of this grid cell.
        var cellLat = DELHI_SOUTH + row * IDW_CELL;
        var cellLng = DELHI_WEST  + col * IDW_CELL;

        // Project cell corners to pixel positions relative to tile origin.
        // Using Math.round on all four values removes the 1-px seams
        // that appear when adjacent fillRects have float boundaries.
        var cellNW = this._map
          .project([cellLat + IDW_CELL, cellLng], coords.z)
          .subtract(nwPoint);
        var cellSE = this._map
          .project([cellLat, cellLng + IDW_CELL], coords.z)
          .subtract(nwPoint);

        var px = Math.round(cellNW.x);
        var py = Math.round(cellNW.y);
        var pw = Math.round(cellSE.x) - px;
        var ph = Math.round(cellSE.y) - py;

        // Paint the cell. Alpha comes from the precomputed edge-fade value.
        // No stroke, no outline – just a filled rectangle.
        ctx.fillStyle = "rgba(" + cell.r + "," + cell.g + "," + cell.b + "," + cell.alpha.toFixed(3) + ")";
        ctx.fillRect(px, py, pw, ph);
      }
    }

    return tile;
  },
});

// Create the IDW layer and add it to the map (on by default).
var idwLayer = new IdwGridLayer();
idwLayer.addTo(map);


// ── IDW toggle control ───────────────────────────────────────────────────────
// A checkbox in the top-right corner to show / hide the estimate layer.

var toggleControl = L.control({ position: "topright" });

toggleControl.onAdd = function () {
  var div = L.DomUtil.create("div", "idw-toggle");
  div.innerHTML =
    '<label><input type="checkbox" id="idw-checkbox" checked /> ' +
    "Show AQI estimate layer</label>";

  // Stop the map from panning / zooming when the user clicks the control.
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);

  return div;
};

toggleControl.addTo(map);

// Toggle the IDW layer visibility when the checkbox changes.
document.getElementById("idw-checkbox").addEventListener("change", function () {
  if (this.checked) {
    map.addLayer(idwLayer);
  } else {
    map.removeLayer(idwLayer);
  }
});


// ── Helper: format the current time as HH:MM (24-hour) ──
function formatTime(date) {
  var hh = String(date.getHours()).padStart(2, "0");
  var mm = String(date.getMinutes()).padStart(2, "0");
  return hh + ":" + mm;
}

// ── Helper: format a station measurement time for the popup ─────────────────
// The WAQI API returns the measurement time as an ISO string like
// "2026-10-30T12:30:00+05:30" (or sometimes in UTC).
// This function converts it to IST, formats it as "30 Oct, 6:00 PM IST",
// and also appends how old the reading is (e.g. "41 min ago").
// If the reading is more than 3 hours old the age is shown in red.
//
// Parameters:
//   rawTime – the time string from station.station.time
//
// Returns: an HTML string ready to embed in the popup.

function formatMeasuredTime(rawTime) {
  // Parse the raw string into a JS Date object.
  // new Date() handles ISO 8601 strings with timezone offsets.
  var measured = new Date(rawTime);

  // If parsing failed (invalid string) fall back to showing the raw value.
  if (isNaN(measured.getTime())) {
    return "Measured: " + rawTime;
  }

  // ── Friendly date + time in IST ─────────────────────────────────────────
  // We use toLocaleString() with the Asia/Kolkata timezone so the browser
  // displays the correct IST time regardless of the visitor's local timezone.
  var months = ["Jan","Feb","Mar","Apr","May","Jun",
                "Jul","Aug","Sep","Oct","Nov","Dec"];

  // Convert to IST by formatting in Asia/Kolkata then re-parsing the parts.
  // toLocaleString returns locale-sensitive text; we extract pieces safely.
  var istOptions = {
    timeZone: "Asia/Kolkata",
    day:      "numeric",
    month:    "numeric",   // we'll map to short name ourselves
    hour:     "numeric",
    minute:   "2-digit",
    hour12:   true,
  };

  // Build each part individually to stay format-agnostic.
  var pDay   = parseInt(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day:   "numeric" }).format(measured), 10);
  var pMonth = parseInt(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", month: "numeric" }).format(measured), 10);
  var pHour  = parseInt(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour:  "numeric", hour12: true }).format(measured), 10);
  var pMin   = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", minute: "2-digit" }).format(measured);
  var pAmpm  = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour:   "numeric", hour12: true })
                 .format(measured).toLowerCase().indexOf("pm") !== -1 ? "PM" : "AM";

  var friendly = pDay + " " + months[pMonth - 1] + ", " + pHour + ":" + pMin + " " + pAmpm + " IST";

  // ── Age of reading ───────────────────────────────────────────────────────
  var ageMs  = Date.now() - measured.getTime();  // milliseconds since measurement
  var ageMins = Math.round(ageMs / 60000);        // convert to whole minutes

  var ageText;
  if (ageMins < 1) {
    ageText = "just now";
  } else if (ageMins < 60) {
    ageText = ageMins + " min ago";
  } else {
    var ageHrs = Math.floor(ageMins / 60);
    var remMins = ageMins % 60;
    ageText = ageHrs + "h " + (remMins > 0 ? remMins + "m " : "") + "ago";
  }

  // Readings older than 3 hours get the age shown in red as a warning.
  var stale    = ageMs > 3 * 60 * 60 * 1000;
  var ageColor = stale ? "#c0392b" : "#666";

  return "Measured: " + friendly +
         " <span style='color:" + ageColor + ";'>(" + ageText + ")</span>";
}

// ── 3. Time Helpers & Relative Update Formatter ──────────────────────────────
var lastStationFetchTimestamp = null;
var totalStationsCount = 0;
var skippedStationsCount = 0;

function getUpdatedTimeAgoString(timestamp) {
  if (!timestamp) return "Data updated just now";
  var diffMs = Date.now() - timestamp.getTime();
  var diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 45) {
    return "Data updated just now";
  }
  var diffMin = Math.floor(diffSec / 60);
  if (diffMin === 1) {
    return "Data updated 1 min ago";
  }
  if (diffMin < 60) {
    return "Data updated " + diffMin + " min ago";
  }
  var diffHours = Math.floor(diffMin / 60);
  if (diffHours === 1) {
    return "Data updated 1 hr ago";
  }
  return "Data updated " + diffHours + " hrs ago";
}

function updateRelativeTimeLabels() {
  if (!lastStationFetchTimestamp) return;
  var agoStr = getUpdatedTimeAgoString(lastStationFetchTimestamp);

  // Map badge
  var mapBadge = document.getElementById("map-data-updated-badge");
  if (mapBadge) {
    mapBadge.innerHTML = '<span class="status-pulse-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;margin-right:6px;"></span>' + agoStr;
  }

  // Delhi AQI Now page hero badge
  var nowUpdatedEl = document.getElementById("now-updated-time");
  if (nowUpdatedEl) {
    var timeStr = lastStationFetchTimestamp.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
    nowUpdatedEl.textContent = agoStr + " (" + timeStr + " IST)";
  }

  // Map stats box
  var statsTextEl = document.getElementById("stats-last-updated-text");
  if (statsTextEl) {
    statsTextEl.textContent = agoStr;
  }
}

// Tick relative time every 30 seconds
setInterval(updateRelativeTimeLabels, 30000);

// ── Scale Toggle Controller ──────────────────────────────────────────────────
function setAqiScale(scale) {
  if (scale !== "india" && scale !== "us") scale = "india";
  currentAqiScale = scale;
  try {
    localStorage.setItem("preferred_aqi_scale", scale);
  } catch (e) {}

  var btnIndia = document.getElementById("scale-btn-india");
  var btnUs = document.getElementById("scale-btn-us");
  if (btnIndia && btnUs) {
    if (scale === "india") {
      btnIndia.classList.add("active");
      btnUs.classList.remove("active");
    } else {
      btnUs.classList.add("active");
      btnIndia.classList.remove("active");
    }
  }

  updateLegend();

  if (currentValidStations && currentValidStations.length > 0) {
    currentValidStations.forEach(function (s) {
      var res = getStationAqi(s, currentAqiScale);
      s.displayAqi = res.value;
      s.displayScale = res.scale;
      s.isFallback = res.isFallback;
    });
    applyStationsToMap(currentValidStations, totalStationsCount, skippedStationsCount);
  }
}

// ── 3. Apply Station Data to Map & Layers ─────────────────────────────────────
function applyStationsToMap(stations, totalCount, skippedCount) {
  stationMarkers.clearLayers();
  currentValidStations = stations;
  if (totalCount !== undefined) totalStationsCount = totalCount;
  if (skippedCount !== undefined) skippedStationsCount = skippedCount;

  stations.forEach(function (station) {
    var res = getStationAqi(station, currentAqiScale);
    station.displayAqi = res.value;
    station.displayScale = res.scale;
    station.isFallback = res.isFallback;

    var aqi = station.displayAqi;
    var color = res.color;
    var label = res.label;

    var marker = L.circleMarker([station.lat, station.lng], {
      radius: 10,           // size of the circle in pixels
      fillColor: color,
      color: "#333",        // thin dark border
      weight: 1,
      opacity: 1,
      fillOpacity: 0.85,
    });

    var scaleName = (currentAqiScale === "india") ? "India NAQI" : "US AQI";
    var fallbackBadge = station.isFallback
      ? '<span class="scale-fallback-tag" title="Raw PM values unavailable from sensor; fell back to US EPA AQI">(US scale fallback)</span>'
      : '<span style="font-size:0.85em;color:var(--text-secondary);">(' + scaleName + ')</span>';

    var popupContent =
      "<strong>" + escapeHtml(station.name) + "</strong><br>" +
      "AQI: <strong style='color:" + color + ";font-size:1.2em'>" + aqi + "</strong> " + fallbackBadge + "<br>" +
      "Category: <strong>" + escapeHtml(label) + "</strong>";

    if (station.time) {
      popupContent +=
        "<br><span style='font-size:0.85em;color:#555'>" +
        escapeHtml(formatMeasuredTime(station.time)) +
        "</span>";
    }

    marker.bindPopup(popupContent);
    stationMarkers.addLayer(marker);
  });

  // Update IDW estimate layer with active stations
  idwLayer.setStations(stations);

  // Re-score currently active routes if any are displayed
  if (lastDirectionsGeojson) {
    renderRoutes(lastDirectionsGeojson, false, lastDirectionsMode);
  }

  // Phase 7: Update health advice panel & saved places live AQIs
  updateHealthAdvicePanel();
  renderSavedPlaces();

  // Multi-page updates (Delhi AQI Now & Areas Table)
  updateDelhiAqiNow();
  renderAreasTable();
  var liveCountEl = document.getElementById("live-stations-count");
  if (liveCountEl) liveCountEl.textContent = stations.length + " Live";

  // Update top-left stats box
  var statsBoxEl = document.getElementById("stats-box");
  if (statsBoxEl) {
    var scaleInfo = (currentAqiScale === "india") ? "India NAQI" : "US AQI";
    var ago = getUpdatedTimeAgoString(lastStationFetchTimestamp);
    statsBoxEl.innerHTML =
      "Stations: " + totalStationsCount + " returned, " + skippedStationsCount + " skipped" +
      "<br>Scale: <strong>" + scaleInfo + "</strong>" +
      "<br><span id='stats-last-updated-text'>" + ago + "</span>";
  }

  updateRelativeTimeLabels();
}

// ── WAQI Fetcher (Proxied via /api/stations with 10-min cache) ───────────────
function fetchWaqiStations() {
  fetch(API_URL)
    .then(function (response) {
      if (response.status === 429) {
        throw new Error("RATE_LIMIT: Too many requests, please try again in a minute.");
      }
      if (!response.ok) throw new Error("HTTP error " + response.status);
      return response.json();
    })
    .then(function (data) {
      if (data.status !== "ok") throw new Error("API error: " + (data.data || "Unknown error from WAQI API"));

      var stations = data.data || [];
      var validList = [];
      var skippedCount = 0;

      stations.forEach(function (station) {
        var aqi = parseInt(station.aqi, 10);
        if (isNaN(aqi)) {
          skippedCount++;
          return;
        }

        var pm25 = null;
        if (station.pm25 !== undefined && station.pm25 !== null && !isNaN(station.pm25)) {
          pm25 = Number(station.pm25);
        } else if (station.iaqi && station.iaqi.pm25 && station.iaqi.pm25.v !== undefined) {
          pm25 = Number(station.iaqi.pm25.v);
        }

        var pm10 = null;
        if (station.pm10 !== undefined && station.pm10 !== null && !isNaN(station.pm10)) {
          pm10 = Number(station.pm10);
        } else if (station.iaqi && station.iaqi.pm10 && station.iaqi.pm10.v !== undefined) {
          pm10 = Number(station.iaqi.pm10.v);
        }

        var stObj = {
          id: station.uid,
          name: station.station.name,
          lat: station.lat,
          lng: station.lon,
          usAqi: aqi,
          aqi: aqi,
          pm25: pm25,
          pm10: pm10,
          time: station.station && station.station.time ? station.station.time : null
        };

        var aqiInfo = getStationAqi(stObj, currentAqiScale);
        stObj.displayAqi = aqiInfo.value;
        stObj.displayScale = aqiInfo.scale;
        stObj.isFallback = aqiInfo.isFallback;

        validList.push(stObj);
      });

      lastStationFetchTimestamp = new Date();
      totalStationsCount = stations.length;
      skippedStationsCount = skippedCount;

      // PWA: Cache station dataset in localStorage for offline resilience
      try {
        localStorage.setItem("delhi_aqi_station_cache_v1", JSON.stringify({
          timestamp: lastStationFetchTimestamp.getTime(),
          data: validList,
          totalCount: stations.length,
          skippedCount: skippedCount
        }));
      } catch (cacheErr) {}

      hideOfflineBanner();
      console.log("WAQI stations returned: " + stations.length + ", valid: " + validList.length);
      applyStationsToMap(validList, stations.length, skippedCount);
      updateRelativeTimeLabels();
      if (typeof checkSavedPlacesAlerts === "function") {
        checkSavedPlacesAlerts();
      }
    })
    .catch(function (err) {
      console.warn("WAQI fetch error:", err);

      // PWA Offline Guard: If network is unavailable or server is unreachable,
      // load last cached station data and display an honest "Offline" label
      var cached = null;
      try {
        var rawCache = localStorage.getItem("delhi_aqi_station_cache_v1");
        if (rawCache) cached = JSON.parse(rawCache);
      } catch (e) {}

      if (cached && Array.isArray(cached.data) && cached.data.length > 0) {
        console.log("[PWA] Using offline cached station data (" + cached.data.length + " stations).");
        lastStationFetchTimestamp = new Date(cached.timestamp || Date.now());
        totalStationsCount = cached.totalCount || cached.data.length;
        skippedStationsCount = cached.skippedCount || 0;
        applyStationsToMap(cached.data, totalStationsCount, skippedStationsCount);
        showOfflineBanner(lastStationFetchTimestamp);
        hideError();
        return;
      }

      if (err.message && err.message.indexOf("RATE_LIMIT") !== -1) {
        showError("⚠️ Too many requests, please try again in a minute.");
      } else if (err.message && err.message.indexOf("Failed to fetch") !== -1) {
        showError("❌ Could not connect to backend at " + API_BASE + ". Please start the backend: 'uvicorn app:app --reload --port 8000' inside backend/.");
      } else {
        showError("❌ Could not load WAQI data: " + escapeHtml(err.message));
      }
    });
}

// ── PWA Offline Banner Helpers ────────────────────────────────────────────────
function showOfflineBanner(date) {
  var banner = document.getElementById("offline-status-banner");
  var ageEl = document.getElementById("offline-data-age");
  if (!banner) return;
  if (ageEl) {
    ageEl.textContent = getUpdatedTimeAgoString(date);
  }
  banner.style.display = "flex";
}

function hideOfflineBanner() {
  var banner = document.getElementById("offline-status-banner");
  if (banner) banner.style.display = "none";
}

// Online / Offline Connectivity Listeners
window.addEventListener("online", function () {
  console.log("[Network] Connection restored, re-fetching live data…");
  hideOfflineBanner();
  fetchWaqiStations();
});

window.addEventListener("offline", function () {
  console.log("[Network] Connection lost, switching to offline mode…");
  showOfflineBanner(lastStationFetchTimestamp);
});

// Initial fetch and auto-refresh every 10 minutes
fetchWaqiStations();

var REFRESH_MS = 10 * 60 * 1000;
setInterval(fetchWaqiStations, REFRESH_MS);


// ─────────────────────────────────────────────────────────────────────────────
// ── 9. Phase 3: Destination Search, Geocoding & Route Options ────────────────
// ─────────────────────────────────────────────────────────────────────────────

// Local backend proxy endpoints (all external calls routed through backend/app.py)
var ROUTE_API_URL = API_BASE + "/api/route";
var GEOCODE_API_URL = API_BASE + "/api/geocode";
var FORECAST_API_URL = API_BASE + "/api/forecast";

// Delhi NCR Bounding box for geocoding
var DELHI_GEO_RECT = {
  min_lon: 76.70,
  max_lon: 77.60,
  min_lat: 28.20,
  max_lat: 29.00
};

// Colors to distinguish Route 1, Route 2, and Route 3
var ROUTE_COLORS = ["#2563eb", "#8b5cf6", "#f59e0b"]; // Blue, Violet, Amber

// State variables for routing
var startLocation = null;       // { lat, lng, name }
var destLocation = null;        // { lat, lng, name }
var startMarker = null;         // Leaflet marker for start (green)
var destMarker = null;          // Leaflet marker for destination (red)
var routeLayerGroup = L.layerGroup().addTo(map);
var activeRoutePolylines = [];  // Array of { polyline, index, color }
var selectedRouteIndex = 0;
var currentValidStations = [];  // Array of valid AQI stations used for IDW sampling
var lastDirectionsGeojson = null; // Stored to allow re-scoring when stations update
var lastDirectionsMode = "driving-car"; // Active mode for rendered routes

// Phase 6: Mode breathing factors (exertion multipliers)
// Walking = 2.5, Cycling = 2.2, Driving = 1.0
// People breathe faster and deeper during physical exertion, inhaling more air (and pollution) per minute.
var MODE_BREATHING_FACTORS = {
  "foot-walking": 2.5,
  "cycling-regular": 2.2,
  "driving-car": 1.0
};

function getModeLabel(mode) {
  if (mode === "foot-walking") return "Walking";
  if (mode === "cycling-regular") return "Cycling";
  return "Driving";
}

// ── Global route coordinates variable for Phase 4 AQI sampling ───────────────
// This array is refreshed whenever routes are fetched and holds the clean
// coordinates [[lat, lng], [lat, lng], ...] for each alternative route.
window.currentRoutesData = [];

// Custom map pin icons for Start (green) and Destination (red)
var startIcon = L.divIcon({
  className: "custom-marker-wrapper",
  html: '<div class="custom-pin pin-start"><span>S</span></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -28]
});

var destIcon = L.divIcon({
  className: "custom-marker-wrapper",
  html: '<div class="custom-pin pin-dest"><span>D</span></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -28]
});

// Update the small status caption below the search row
function updateSearchStatus(msg) {
  var statusEl = document.getElementById("search-status");
  if (statusEl) {
    statusEl.textContent = msg;
  }
}

// ── Helper: route service check ──────────────────────────────────────────────
function checkOrsKey() {
  return true; // Handled securely by backend/app.py
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 7: HEALTH ADVICE, HEALTH PROFILES & SAVED PLACES
// ══════════════════════════════════════════════════════════════════════════════

// ── Part A: Health Advice by AQI Category (India NAQI & US EPA) ──────────────
// Returns tailored guidance, category label, severity level, and styling
function getHealthAdvice(aqi, scale) {
  scale = scale || currentAqiScale || "india";

  if (scale === "india") {
    if (aqi <= 50) {
      return {
        category: "Good",
        severity: "low",
        advice: "Air quality is good. Minimal impact on health. Enjoy outdoor activities.",
        color: "#00b050",
        textColor: "#ffffff"
      };
    } else if (aqi <= 100) {
      return {
        category: "Satisfactory",
        severity: "low",
        advice: "Air quality is acceptable. May cause minor breathing discomfort to sensitive people.",
        color: "#92d050",
        textColor: "#111111"
      };
    } else if (aqi <= 200) {
      return {
        category: "Moderate",
        severity: "moderate",
        advice: "May cause breathing discomfort to people with lung disease, asthma, and heart conditions.",
        color: "#eab308",
        textColor: "#111111"
      };
    } else if (aqi <= 300) {
      return {
        category: "Poor",
        severity: "warning",
        advice: "May cause breathing discomfort to most people on prolonged outdoor exposure.",
        color: "#ff9900",
        textColor: "#ffffff"
      };
    } else if (aqi <= 400) {
      return {
        category: "Very Poor",
        severity: "very_unhealthy",
        advice: "Respiratory illness on prolonged exposure. Avoid strenuous outdoor activities.",
        color: "#ff0000",
        textColor: "#ffffff"
      };
    } else {
      return {
        category: "Severe",
        severity: "hazardous",
        advice: "Affects healthy people and seriously impacts those with existing diseases. Stay indoors.",
        color: "#7030a0",
        textColor: "#ffffff"
      };
    }
  }

  // US EPA Standards
  if (aqi <= 50) {
    return {
      category: "Good",
      severity: "low",
      advice: "Air quality is good. Enjoy outdoor activities.",
      color: "#00e400",
      textColor: "#111"
    };
  } else if (aqi <= 100) {
    return {
      category: "Moderate",
      severity: "moderate",
      advice: "Air quality is acceptable. Unusually sensitive people should consider reducing prolonged outdoor exertion.",
      color: "#ffff00",
      textColor: "#111"
    };
  } else if (aqi <= 150) {
    return {
      category: "Unhealthy (Sensitive)",
      severity: "warning",
      advice: "Sensitive groups should reduce prolonged outdoor exertion.",
      color: "#ff7e00",
      textColor: "#fff"
    };
  } else if (aqi <= 200) {
    return {
      category: "Unhealthy",
      severity: "unhealthy",
      advice: "Everyone should reduce prolonged outdoor exertion. Consider a mask outdoors.",
      color: "#ff0000",
      textColor: "#fff"
    };
  } else if (aqi <= 300) {
    return {
      category: "Very Unhealthy",
      severity: "very_unhealthy",
      advice: "Avoid outdoor exertion. Wear an N95 mask if you must go outside.",
      color: "#8f3f97",
      textColor: "#fff"
    };
  } else {
    return {
      category: "Hazardous",
      severity: "hazardous",
      advice: "Hazardous. Stay indoors with windows closed. Avoid all outdoor activity.",
      color: "#7e0023",
      textColor: "#fff"
    };
  }
}

// ── Part B: Health Profiles & Alert Thresholds ────────────────────────────────
var HEALTH_PROFILES = {
  "healthy_adult": { key: "healthy_adult", label: "Healthy Adult", threshold: 250 },
  "elderly": { key: "elderly", label: "Elderly", threshold: 150 },
  "asthma": { key: "asthma", label: "Asthma", threshold: 100 },
  "child": { key: "child", label: "Child", threshold: 100 }
};

function getActiveHealthProfile() {
  try {
    var stored = localStorage.getItem("aqi_health_profile");
    if (stored && HEALTH_PROFILES[stored]) {
      return HEALTH_PROFILES[stored];
    }
  } catch (e) {}
  var selectEl = document.getElementById("profile-select");
  var key = (selectEl && selectEl.value && HEALTH_PROFILES[selectEl.value]) ? selectEl.value : "healthy_adult";
  return HEALTH_PROFILES[key];
}

function setActiveHealthProfile(profileKey) {
  if (HEALTH_PROFILES[profileKey]) {
    try {
      localStorage.setItem("aqi_health_profile", profileKey);
    } catch (e) {}
    var selectEl = document.getElementById("profile-select");
    if (selectEl && selectEl.value !== profileKey) {
      selectEl.value = profileKey;
    }
    updateHealthAdvicePanel();
    if (lastDirectionsGeojson) {
      renderRoutes(lastDirectionsGeojson, false, lastDirectionsMode);
    }
  }
}

// State for health alert dismissal (persists in-memory until AQI category changes or reload)
var healthAlertDismissedCategory = null;

function bindHealthAlertClose(category) {
  var closeBtn = document.getElementById("close-health-alert-btn");
  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = "true";
    closeBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var alertBanner = document.getElementById("health-alert-banner");
      if (alertBanner) {
        alertBanner.style.display = "none";
      }
      healthAlertDismissedCategory = closeBtn.dataset.category || category || "dismissed";
      if (map) {
        setTimeout(function () { map.invalidateSize(); }, 60);
      }
    });
  }
  if (closeBtn && category) {
    closeBtn.dataset.category = category;
  }
}

// Update the Health Advice Panel and screen-top Red Alert Banner
function updateHealthAdvicePanel() {
  var advicePanel = document.getElementById("health-advice-panel");
  var labelEl = document.getElementById("advice-location-label");
  var pillEl = document.getElementById("advice-aqi-pill");
  var msgEl = document.getElementById("advice-message");
  var alertBanner = document.getElementById("health-alert-banner");

  if (!advicePanel || !labelEl || !pillEl || !msgEl) return;

  if (!currentValidStations || currentValidStations.length === 0) {
    msgEl.textContent = "Loading AQI station data for local advice…";
    pillEl.textContent = "--";
    pillEl.style.backgroundColor = "#888";
    if (alertBanner) alertBanner.style.display = "none";
    return;
  }

  var targetLat, targetLng, locTitle;
  if (startLocation) {
    targetLat = startLocation.lat;
    targetLng = startLocation.lng;
    locTitle = "📍 Start Area: " + startLocation.name;
  } else {
    var center = map.getCenter();
    targetLat = center.lat;
    targetLng = center.lng;
    locTitle = "📍 Delhi Map Center";
  }

  var aqi = Math.round(computeIdw(targetLat, targetLng, currentValidStations));
  var adviceObj = getHealthAdvice(aqi, currentAqiScale);
  var scalePrefix = (currentAqiScale === "india") ? "India NAQI " : "US AQI ";

  labelEl.textContent = locTitle;
  pillEl.textContent = scalePrefix + aqi + " (" + adviceObj.category + ")";
  pillEl.style.backgroundColor = adviceObj.color;
  pillEl.style.color = adviceObj.textColor;
  msgEl.textContent = adviceObj.advice;

  // Screen-top red warning banner if AQI exceeds active profile threshold
  var activeProfile = getActiveHealthProfile();
  if (alertBanner) {
    // If AQI category changed since last dismissal, reset dismissal so new category alert can show
    if (healthAlertDismissedCategory && healthAlertDismissedCategory !== adviceObj.category) {
      healthAlertDismissedCategory = null;
    }

    if (aqi >= activeProfile.threshold) {
      if (healthAlertDismissedCategory === adviceObj.category) {
        // User dismissed the banner for this category: keep it hidden
        if (alertBanner.style.display !== "none") {
          alertBanner.style.display = "none";
          if (map) setTimeout(function () { map.invalidateSize(); }, 60);
        }
      } else {
        var contentEl = document.getElementById("health-alert-content");
        var bannerText =
          "⚠️ <strong>Health Alert (" + escapeHtml(activeProfile.label) + "):</strong> " +
          "Local AQI is <strong>" + aqi + "</strong> (exceeds your " +
          activeProfile.threshold + " threshold). " + escapeHtml(adviceObj.advice);

        if (contentEl) {
          contentEl.innerHTML = bannerText;
        } else {
          alertBanner.innerHTML =
            '<div id="health-alert-content" class="health-alert-content">' + bannerText + '</div>' +
            '<button type="button" id="close-health-alert-btn" class="health-alert-close" aria-label="Dismiss health alert" title="Dismiss health alert">✕</button>';
        }
        bindHealthAlertClose(adviceObj.category);

        var wasHidden = (alertBanner.style.display === "none" || !alertBanner.style.display);
        alertBanner.style.display = "flex";
        if (wasHidden && map) {
          setTimeout(function () { map.invalidateSize(); }, 60);
        }
      }
    } else {
      var wasVisible = (alertBanner.style.display !== "none");
      alertBanner.style.display = "none";
      healthAlertDismissedCategory = null;
      if (wasVisible && map) {
        setTimeout(function () { map.invalidateSize(); }, 60);
      }
    }
  }
}

// ── Part C: Saved Places ──────────────────────────────────────────────────────
var STORAGE_KEY_SAVED_PLACES = "delhi_aqi_saved_places";

function getSavedPlaces() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY_SAVED_PLACES);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}
  return [];
}

function saveSavedPlaces(places) {
  try {
    localStorage.setItem(STORAGE_KEY_SAVED_PLACES, JSON.stringify(places));
  } catch (e) {}
}

function renderSavedPlaces() {
  var listEl = document.getElementById("saved-places-list");
  var badgeEl = document.getElementById("saved-places-badge");
  if (!listEl) return;

  var places = getSavedPlaces();
  if (badgeEl) badgeEl.textContent = places.length;

  if (places.length === 0) {
    listEl.innerHTML =
      '<div style="color:#64748b;font-style:italic;padding:6px;text-align:center;">' +
      'No saved places yet.<br>Click "+ Save Current Location" to bookmark home, work, or college.' +
      '</div>';
    return;
  }

  listEl.innerHTML = "";
  places.forEach(function (place) {
    var aqiVal = (currentValidStations && currentValidStations.length > 0)
      ? Math.round(computeIdw(place.lat, place.lng, currentValidStations))
      : null;
    var aqiColor = (aqiVal !== null) ? getAqiColor(aqiVal) : "#888";
    var aqiTextColor = (aqiVal !== null && aqiVal <= 100) ? "#111" : "#fff";
    var aqiDisplay = (aqiVal !== null) ? "AQI " + aqiVal : "AQI --";

    var item = document.createElement("div");
    item.className = "saved-place-item";
    item.innerHTML =
      '<div class="saved-place-info">' +
        '<div class="saved-place-name">' + escapeHtml(place.name) + '</div>' +
        '<span class="saved-place-aqi" style="background:' + aqiColor + ';color:' + aqiTextColor + ';">' +
          aqiDisplay +
        '</span>' +
      '</div>' +
      '<div class="saved-place-actions">' +
        '<button type="button" class="action-chip btn-place-start" title="Set as trip start point">Start</button>' +
        '<button type="button" class="action-chip btn-place-dest" title="Set as trip destination">Dest</button>' +
        '<button type="button" class="action-chip del-btn btn-place-delete" title="Delete this saved place">✕</button>' +
      '</div>';

    // Set as Start
    item.querySelector(".btn-place-start").addEventListener("click", function (ev) {
      ev.stopPropagation();
      setStartPoint(place.lat, place.lng, place.name);
    });

    // Set as Destination
    item.querySelector(".btn-place-dest").addEventListener("click", function (ev) {
      ev.stopPropagation();
      setDestPoint(place.lat, place.lng, place.name);
    });

    // Delete place
    item.querySelector(".btn-place-delete").addEventListener("click", function (ev) {
      ev.stopPropagation();
      deleteSavedPlace(place.id);
    });

    // Clicking card item defaults to setting destination
    item.addEventListener("click", function () {
      setDestPoint(place.lat, place.lng, place.name);
    });

    listEl.appendChild(item);
  });
}

function addNewSavedPlace() {
  var defaultName = startLocation ? startLocation.name : (destLocation ? destLocation.name : "Home");
  var name = window.prompt("Enter a label for this saved place (e.g. Home, Office, College):", defaultName);
  if (!name || !name.trim()) return;

  var targetLat, targetLng;
  if (startLocation) {
    targetLat = startLocation.lat;
    targetLng = startLocation.lng;
  } else if (destLocation) {
    targetLat = destLocation.lat;
    targetLng = destLocation.lng;
  } else {
    var c = map.getCenter();
    targetLat = c.lat;
    targetLng = c.lng;
  }

  var places = getSavedPlaces();
  places.push({
    id: "place_" + Date.now(),
    name: name.trim(),
    lat: targetLat,
    lng: targetLng
  });
  saveSavedPlaces(places);
  renderSavedPlaces();

  // If panel is closed, open it to show the newly added place
  var panel = document.getElementById("saved-places-panel");
  if (panel && panel.style.display === "none") {
    panel.style.display = "block";
    var toggleBtn = document.getElementById("toggle-saved-places-btn");
    if (toggleBtn) toggleBtn.classList.add("active");
  }
}

function deleteSavedPlace(id) {
  var places = getSavedPlaces().filter(function (p) { return p.id !== id; });
  saveSavedPlaces(places);
  renderSavedPlaces();
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 8: LEAVE-TIME SUGGESTION (OPEN-METEO AIR QUALITY FORECAST)
// ══════════════════════════════════════════════════════════════════════════════

function fetchLeaveTimeSuggestion(lat, lng, route) {
  var box = document.getElementById("leave-time-box");
  var textEl = document.getElementById("leave-time-text");
  if (!box || !textEl || !route) return;

  box.style.display = "block";
  textEl.innerHTML = "Checking air quality forecast…";

  var url = FORECAST_API_URL + "?lat=" + lat.toFixed(4) + "&lng=" + lng.toFixed(4);

  fetch(url)
    .then(function (res) {
      if (!res.ok) throw new Error("Forecast API HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data || !data.hourly || !data.hourly.time || !data.hourly.us_aqi) {
        box.style.display = "none";
        return;
      }

      var times = data.hourly.time;
      var aqis = data.hourly.us_aqi;
      var pm25s = data.hourly.pm2_5 || [];

      var forecastEntries = [];
      for (var i = 0; i < times.length; i++) {
        var t = new Date(times[i]).getTime();
        var val = aqis[i];
        if (val === null || val === undefined || isNaN(val)) {
          if (pm25s[i] !== null && pm25s[i] !== undefined) {
            val = Math.round(pm25s[i] * 2.5); // fallback approximation
          } else {
            continue;
          }
        }
        if (!isNaN(t)) {
          forecastEntries.push({ timeMs: t, aqi: val });
        }
      }

      if (forecastEntries.length < 2) {
        box.style.display = "none";
        return;
      }

      // Linear interpolation between forecast hourly steps
      function getForecastAqi(targetMs) {
        if (targetMs <= forecastEntries[0].timeMs) return forecastEntries[0].aqi;
        if (targetMs >= forecastEntries[forecastEntries.length - 1].timeMs) {
          return forecastEntries[forecastEntries.length - 1].aqi;
        }
        for (var j = 0; j < forecastEntries.length - 1; j++) {
          var t0 = forecastEntries[j].timeMs;
          var t1 = forecastEntries[j + 1].timeMs;
          if (targetMs >= t0 && targetMs <= t1) {
            var frac = (targetMs - t0) / (t1 - t0);
            return forecastEntries[j].aqi + frac * (forecastEntries[j + 1].aqi - forecastEntries[j].aqi);
          }
        }
        return forecastEntries[forecastEntries.length - 1].aqi;
      }

      function getTripExposure(startMs, durationMin) {
        var durationMs = (durationMin || 30) * 60 * 1000;
        var stepMs = 5 * 60 * 1000;
        var sum = 0;
        var count = 0;
        for (var cur = startMs; cur <= startMs + durationMs; cur += stepMs) {
          sum += getForecastAqi(cur);
          count++;
        }
        return count > 0 ? (sum / count) * (durationMin || 30) : getForecastAqi(startMs) * (durationMin || 30);
      }

      var nowMs = Date.now();
      var nowExposure = getTripExposure(nowMs, route.durationMin);

      // Check departure candidate delays: 30 min, 60 min, 90 min, 120 min, 180 min
      var candidates = [30, 60, 90, 120, 180];
      var bestCandidate = null;
      var maxReductionPct = 0;

      candidates.forEach(function (delayMin) {
        var candidateStartMs = nowMs + delayMin * 60 * 1000;
        var candExposure = getTripExposure(candidateStartMs, route.durationMin);
        if (nowExposure > 0) {
          var reductionPct = Math.round(((nowExposure - candExposure) / nowExposure) * 100);
          if (reductionPct > maxReductionPct) {
            maxReductionPct = reductionPct;
            bestCandidate = {
              delayMin: delayMin,
              startMs: candidateStartMs,
              reductionPct: reductionPct,
              candExposure: candExposure
            };
          }
        }
      });

      if (bestCandidate && bestCandidate.reductionPct >= 15) {
        var bestDate = new Date(bestCandidate.startMs);
        var timeStr = bestDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        var savedMinsHighPollution = Math.round(route.durationMin * (bestCandidate.reductionPct / 100));

        textEl.innerHTML =
          '<strong>Leave at ' + timeStr + ' instead of now: ~' + bestCandidate.reductionPct + '% less exposure.</strong>' +
          '<br><span style="font-size:0.85em;color:#555;">Waiting ' + bestCandidate.delayMin + ' min saves ~' +
          savedMinsHighPollution + ' min of high pollution exposure during your ' + route.durationMin + ' min trip.</span>';
        box.style.display = "block";
      } else if (!bestCandidate || maxReductionPct < 5) {
        textEl.innerHTML =
          '<strong>Now is already a good time to leave.</strong>' +
          '<br><span style="font-size:0.85em;color:#555;">Air quality is forecasted to stay steady or rise over the next 3 hours.</span>';
        box.style.display = "block";
      } else {
        var bestDateMid = new Date(bestCandidate.startMs);
        var timeStrMid = bestDateMid.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        textEl.innerHTML =
          '<strong>Leaving now is reasonable.</strong>' +
          '<br><span style="font-size:0.85em;color:#555;">Leaving at ' + timeStrMid + ' offers only a modest ~' +
          bestCandidate.reductionPct + '% reduction in exposure.</span>';
        box.style.display = "block";
      }
    })
    .catch(function (err) {
      // If forecast fails, hide the box silently without showing an error banner
      console.warn("Forecast API error (ignored silently):", err);
      box.style.display = "none";
    });
}

// ── Set Start Point ──────────────────────────────────────────────────────────
function setStartPoint(lat, lng, name) {
  startLocation = { lat: lat, lng: lng, name: name || "Start Point" };

  if (startMarker) {
    map.removeLayer(startMarker);
  }

  startMarker = L.marker([lat, lng], { icon: startIcon }).addTo(map);
  startMarker.bindPopup("<strong>Start:</strong> " + escapeHtml(startLocation.name));

  // Update health advice panel anchored to start point
  updateHealthAdvicePanel();

  var statusMsg = "Start: " + startLocation.name;
  if (!destLocation) {
    statusMsg += " | Enter a destination above to find routes.";
  } else {
    statusMsg += " | Destination: " + destLocation.name;
    // Both points available, calculate route!
    calculateRoutes();
  }
  updateSearchStatus(statusMsg);
}

// ── Set Destination Point ────────────────────────────────────────────────────
function setDestPoint(lat, lng, name) {
  destLocation = { lat: lat, lng: lng, name: name || "Destination" };

  if (destMarker) {
    map.removeLayer(destMarker);
  }

  destMarker = L.marker([lat, lng], { icon: destIcon }).addTo(map);
  destMarker.bindPopup("<strong>Destination:</strong> " + escapeHtml(destLocation.name));

  var statusMsg = "Destination: " + destLocation.name;
  if (!startLocation) {
    statusMsg += " | Click 'Use my location' or click anywhere on the map to set your start.";
  } else {
    statusMsg = "Start: " + startLocation.name + " | Destination: " + destLocation.name;
    // Both points available, calculate route!
    calculateRoutes();
  }
  updateSearchStatus(statusMsg);
}

// ── 1. Geolocation: "Use my location" button ─────────────────────────────────
var locateBtn = document.getElementById("locate-btn");
if (locateBtn) {
  locateBtn.addEventListener("click", function () {
    hideError();
    if (!navigator.geolocation) {
      showError("❌ Geolocation is not supported by your browser.");
      return;
    }

    updateSearchStatus("Locating your current position…");

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var lat = pos.coords.latitude;
        var lng = pos.coords.longitude;
        setStartPoint(lat, lng, "My Location");
        map.setView([lat, lng], 13);
      },
      function (err) {
        var msg = "Could not get your location.";
        if (err.code === err.PERMISSION_DENIED) {
          msg = "Location permission denied. Please click anywhere on the map to set your start point.";
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          msg = "Location information is unavailable. Click on the map to set your start point.";
        } else if (err.code === err.TIMEOUT) {
          msg = "Location request timed out. Click on the map to set your start point.";
        }
        showError("📍 " + msg);
        updateSearchStatus("Start: Not set (click anywhere on the map to set start point)");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

// ── 2. Click on map to set start or destination point ────────────────────────
var isWaitingForDestClick = false;
var pickDestBtn = document.getElementById("pick-dest-btn");

if (pickDestBtn) {
  pickDestBtn.addEventListener("click", function () {
    isWaitingForDestClick = !isWaitingForDestClick;
    if (isWaitingForDestClick) {
      pickDestBtn.classList.add("active");
      pickDestBtn.textContent = "🎯 Click map now…";
      updateSearchStatus("Click anywhere on the map to set your destination.");
    } else {
      pickDestBtn.classList.remove("active");
      pickDestBtn.textContent = "🎯 Set dest on map";
      updateSearchStatus("Destination map selection cancelled.");
    }
  });
}

map.on("click", function (e) {
  // If the user clicked a marker or popup or search panel, don't override
  if (e.originalEvent && e.originalEvent.target && e.originalEvent.target.closest &&
      (e.originalEvent.target.closest(".leaflet-popup") || e.originalEvent.target.closest("#search-panel"))) {
    return;
  }
  var lat = e.latlng.lat;
  var lng = e.latlng.lng;

  if (isWaitingForDestClick) {
    // Mode: Next map click is the destination
    isWaitingForDestClick = false;
    if (pickDestBtn) {
      pickDestBtn.classList.remove("active");
      pickDestBtn.textContent = "🎯 Set dest on map";
    }
    setDestPoint(lat, lng, "Map Point (" + lat.toFixed(3) + ", " + lng.toFixed(3) + ")");
  } else {
    // Default mode: Map click sets start point
    setStartPoint(lat, lng, "Map Point (" + lat.toFixed(3) + ", " + lng.toFixed(3) + ")");
  }
});

// Update health advice on map pan/zoom if no start location is set
map.on("moveend", function () {
  if (!startLocation) {
    updateHealthAdvicePanel();
  }
});

// Phase 7: Profile selector listener
var profileSelectEl = document.getElementById("profile-select");
if (profileSelectEl) {
  var storedProfile = localStorage.getItem("aqi_health_profile");
  if (storedProfile && HEALTH_PROFILES[storedProfile]) {
    profileSelectEl.value = storedProfile;
  }
  profileSelectEl.addEventListener("change", function () {
    setActiveHealthProfile(this.value);
  });
}

// Phase 7: Saved places toggle and add listeners
var toggleSavedPlacesBtn = document.getElementById("toggle-saved-places-btn");
var savedPlacesPanel = document.getElementById("saved-places-panel");
if (toggleSavedPlacesBtn && savedPlacesPanel) {
  toggleSavedPlacesBtn.addEventListener("click", function () {
    var isHidden = savedPlacesPanel.style.display === "none";
    savedPlacesPanel.style.display = isHidden ? "block" : "none";
    if (isHidden) {
      toggleSavedPlacesBtn.classList.add("active");
    } else {
      toggleSavedPlacesBtn.classList.remove("active");
    }
  });
}

var addSavedPlaceBtn = document.getElementById("add-saved-place-btn");
if (addSavedPlaceBtn) {
  addSavedPlaceBtn.addEventListener("click", function () {
    addNewSavedPlace();
  });
}

// Phase 7: Initial render of saved places and health advice
renderSavedPlaces();
updateHealthAdvicePanel();


// ── 3. Improved Destination Autocomplete (ORS + Photon Dual-Source) ──────────
var destInput = document.getElementById("dest-input");
var searchBtn = document.getElementById("search-btn");
var suggestionsList = document.getElementById("dest-suggestions");
var autocompleteTimer = null;
var hoverPreviewMarker = null;

// Temporary marker shown on map when hovering over an autocomplete result
var previewIcon = L.divIcon({
  className: "custom-marker-wrapper",
  html: '<div class="custom-pin pin-preview"><span>?</span></div>',
  iconSize: [24, 24],
  iconAnchor: [12, 24],
  popupAnchor: [0, -24]
});

function showHoverPreview(lat, lng, name) {
  if (!hoverPreviewMarker) {
    hoverPreviewMarker = L.marker([lat, lng], { icon: previewIcon }).addTo(map);
  } else {
    hoverPreviewMarker.setLatLng([lat, lng]);
    if (!map.hasLayer(hoverPreviewMarker)) {
      hoverPreviewMarker.addTo(map);
    }
  }
  hoverPreviewMarker.bindTooltip("<strong>" + escapeHtml(name) + "</strong> (hover preview)", {
    permanent: false,
    direction: "top"
  }).openTooltip();
}

function hideHoverPreview() {
  if (hoverPreviewMarker && map.hasLayer(hoverPreviewMarker)) {
    map.removeLayer(hoverPreviewMarker);
  }
}

// Distance helper between two lat/lng coordinates in meters
function getPointDistanceMeters(lat1, lon1, lat2, lon2) {
  var p1 = latLngToMeters(lat1, lon1);
  var p2 = latLngToMeters(lat2, lon2);
  var dx = p1.x - p2.x;
  var dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Check if two names are similar (case-insensitive, ignoring special characters)
function arePlaceNamesSimilar(nameA, nameB) {
  if (!nameA || !nameB) return false;
  var a = nameA.toLowerCase().replace(/[^a-z0-9]/g, "");
  var b = nameB.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1)) {
    return true;
  }
  return false;
}

// Perform merged autocomplete search using ORS and Photon
function executeMergedSearch(query) {
  hideError();
  query = (query || "").trim();
  if (query.length < 3) {
    suggestionsList.style.display = "none";
    hideHoverPreview();
    return;
  }

  if (!navigator.onLine) {
    suggestionsList.innerHTML = '<div class="suggestion-error">❌ No internet connection. Please check your network.</div>';
    suggestionsList.style.display = "block";
    return;
  }

  updateSearchStatus("Searching: '" + query + "'…");

  var center = map.getCenter();
  var focusLat = center.lat;
  var focusLon = center.lng;

  // Call backend geocode proxy (proxies ORS autocomplete + Photon, no API keys on client)
  var geocodeUrl = GEOCODE_API_URL +
    "?q=" + encodeURIComponent(query) +
    "&lat=" + focusLat.toFixed(4) +
    "&lon=" + focusLon.toFixed(4);

  fetch(geocodeUrl)
    .then(function (res) {
      if (res.status === 429) throw new Error("RATE_LIMIT");
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      var orsData = { features: data.ors_features || [] };
      var photonData = { features: data.photon_features || [] };

      // Check if both hit rate limit
      if (orsData.error === "RATE_LIMIT" && photonData.error === "RATE_LIMIT") {
        suggestionsList.innerHTML = '<div class="suggestion-error">⚠️ Too many requests, please try again in a minute.</div>';
        suggestionsList.style.display = "block";
        updateSearchStatus("Too many requests, please try again in a minute.");
        return;
      }

      var rawCandidates = [];

      // Parse ORS features
      if (orsData && orsData.features) {
        orsData.features.forEach(function (f) {
          var coords = f.geometry ? f.geometry.coordinates : null;
          if (!coords) return;
          var props = f.properties || {};
          var name = props.name || (props.label ? props.label.split(",")[0] : "");
          if (!name) return;

          var locality = [props.neighbourhood || props.county, props.locality || props.region]
            .filter(Boolean)
            .join(", ") || (props.label ? props.label.split(",").slice(1, 3).join(",").trim() : "Delhi NCR");

          var type = props.layer || props.category || props.type || "place";

          rawCandidates.push({
            name: name,
            locality: locality,
            type: type,
            lat: coords[1],
            lng: coords[0],
            source: "ors"
          });
        });
      }

      // Parse Photon features
      if (photonData && photonData.features) {
        photonData.features.forEach(function (f) {
          var coords = f.geometry ? f.geometry.coordinates : null;
          if (!coords) return;
          var props = f.properties || {};
          var name = props.name;
          if (!name) return;

          var locality = [props.district, props.locality || props.city, props.state]
            .filter(Boolean)
            .join(", ") || "Delhi NCR";

          var type = props.osm_value || props.osm_key || props.type || "location";

          rawCandidates.push({
            name: name,
            locality: locality,
            type: type,
            lat: coords[1],
            lng: coords[0],
            source: "photon"
          });
        });
      }

      // Remove near-duplicates: within 150m of each other with similar names
      var merged = [];
      rawCandidates.forEach(function (cand) {
        var isDupe = merged.some(function (existing) {
          var dist = getPointDistanceMeters(cand.lat, cand.lng, existing.lat, existing.lng);
          return (dist <= 150 && arePlaceNamesSimilar(cand.name, existing.name));
        });
        if (!isDupe) {
          merged.push(cand);
        }
      });

      // Show up to 8 distinct results
      var finalResults = merged.slice(0, 8);

      if (finalResults.length === 0) {
        suggestionsList.innerHTML =
          '<div class="suggestion-empty">' +
            'No exact match. Try a nearby landmark or click on the map.' +
          '</div>';
        suggestionsList.style.display = "block";
        updateSearchStatus("No exact match found.");
        return;
      }

      // Render up to 8 rows
      suggestionsList.innerHTML = "";
      finalResults.forEach(function (res) {
        var item = document.createElement("div");
        item.className = "suggestion-item";
        item.innerHTML =
          '<div class="suggestion-title-row">' +
            '<span class="suggestion-name">' + escapeHtml(res.name) + '</span>' +
            '<span class="suggestion-type">' + escapeHtml(res.type) + '</span>' +
          '</div>' +
          '<div class="suggestion-locality">' + escapeHtml(res.locality) + '</div>';

        // Requirement 4: Hovering over a result shows it on the map
        item.addEventListener("mouseenter", function () {
          showHoverPreview(res.lat, res.lng, res.name);
        });

        item.addEventListener("mouseleave", function () {
          hideHoverPreview();
        });

        // Clicking it sets the red destination marker and zooms to it
        item.addEventListener("click", function () {
          hideHoverPreview();
          destInput.value = res.name;
          suggestionsList.style.display = "none";
          setDestPoint(res.lat, res.lng, res.name);
          map.setView([res.lat, res.lng], 14);
        });

        suggestionsList.appendChild(item);
      });

      suggestionsList.style.display = "block";
      updateSearchStatus("Found " + finalResults.length + " destination options. Click one to select.");
    })
    .catch(function (err) {
      var isRateLimit = err && err.message && (err.message.indexOf("RATE_LIMIT") !== -1 || err.message.indexOf("429") !== -1);
      if (isRateLimit) {
        suggestionsList.innerHTML = '<div class="suggestion-error">⚠️ Too many requests, please try again in a minute.</div>';
        updateSearchStatus("Too many requests, please try again in a minute.");
      } else {
        suggestionsList.innerHTML =
          '<div class="suggestion-error">❌ Search error: ' + escapeHtml(err.message || "Failed to fetch") + '</div>';
        updateSearchStatus("Search failed.");
      }
      suggestionsList.style.display = "block";
    });
}

// ── Event Listeners for Autocomplete & Search ────────────────────────────────
// Debounce: After 3 characters, wait 400ms after last keystroke before querying
if (destInput) {
  destInput.addEventListener("input", function () {
    if (autocompleteTimer) {
      clearTimeout(autocompleteTimer);
    }
    var q = destInput.value.trim();
    if (q.length < 3) {
      suggestionsList.style.display = "none";
      hideHoverPreview();
      return;
    }
    autocompleteTimer = setTimeout(function () {
      executeMergedSearch(q);
    }, 400);
  });

  destInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (autocompleteTimer) clearTimeout(autocompleteTimer);
      executeMergedSearch(destInput.value);
    }
  });
}

if (searchBtn) {
  searchBtn.addEventListener("click", function () {
    if (autocompleteTimer) clearTimeout(autocompleteTimer);
    executeMergedSearch(destInput.value);
  });
}

// Hide dropdown and hover preview when clicking outside
document.addEventListener("click", function (e) {
  if (!e.target.closest(".input-wrapper")) {
    if (suggestionsList) suggestionsList.style.display = "none";
    hideHoverPreview();
  }
});

// Mode dropdown changed: re-calculate route if points exist
var modeSelect = document.getElementById("mode-select");
if (modeSelect) {
  modeSelect.addEventListener("change", function () {
    if (startLocation && destLocation) {
      calculateRoutes();
    }
  });
}

// Close / Clear routes button
var closeRoutesBtn = document.getElementById("close-routes-btn");
if (closeRoutesBtn) {
  closeRoutesBtn.addEventListener("click", function () {
    routeLayerGroup.clearLayers();
    activeRoutePolylines = [];
    window.currentRoutesData = [];
    lastDirectionsGeojson = null;
    var routeCard = document.getElementById("route-options-card");
    if (routeCard) routeCard.style.display = "none";
    var compEl = document.getElementById("route-comparison");
    if (compEl) compEl.style.display = "none";
    var hintEl = document.getElementById("route-hint");
    if (hintEl) hintEl.style.display = "none";
    var leaveBox = document.getElementById("leave-time-box");
    if (leaveBox) leaveBox.style.display = "none";
    updateSearchStatus("Routes cleared.");
  });
}

// ── 4. Calculate Routes with ORS Directions API ──────────────────────────────
function calculateRoutes() {
  hideError();
  if (!startLocation || !destLocation) {
    return;
  }

  if (!navigator.onLine) {
    showError("❌ No internet connection. Cannot calculate route.");
    return;
  }

  if (!checkOrsKey()) return;

  var mode = modeSelect ? modeSelect.value : "driving-car";
  var modeLabel = getModeLabel(mode);
  var noticeEl = document.getElementById("route-notice");
  if (noticeEl) noticeEl.style.display = "none";

  // Provide immediate visual feedback while routes are loading
  routeLayerGroup.clearLayers();
  activeRoutePolylines = [];
  var routeCard = document.getElementById("route-options-card");
  var routesList = document.getElementById("routes-list");
  var compEl = document.getElementById("route-comparison");
  var hintEl = document.getElementById("route-hint");

  if (routeCard) routeCard.style.display = "flex";
  if (routesList) {
    routesList.innerHTML = '<div style="padding:12px;color:#6b7280;font-size:13px;">Calculating ' + modeLabel.toLowerCase() + ' routes…</div>';
  }
  if (compEl) compEl.style.display = "none";
  if (hintEl) hintEl.style.display = "none";

  updateSearchStatus("Calculating " + modeLabel.toLowerCase() + " routes…");

  // First try requesting with alternative_routes
  requestDirectionsWithAlternatives(mode, true);
}

function requestDirectionsWithAlternatives(mode, allowAlternatives) {
  var url = ROUTE_API_URL;
  var modeLabel = getModeLabel(mode);
  var modeLower = modeLabel.toLowerCase();

  var bodyPayload = {
    mode: mode,
    coordinates: [
      [startLocation.lng, startLocation.lat],
      [destLocation.lng, destLocation.lat]
    ]
  };

  // Only request alternatives when permitted
  if (allowAlternatives) {
    bodyPayload.alternative_routes = {
      target_count: 3,
      share_factor: 0.6,
      weight_factor: 1.6
    };
  }

  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(bodyPayload)
  })
    .then(function (res) {
      if (res.status === 429) {
        throw new Error("RATE_LIMIT: Too many requests, please try again in a minute.");
      }
      if (!res.ok) {
        // If requesting alternatives failed (e.g. 400 Bad Request for walking/cycling),
        // gracefully fall back to requesting a single route
        if (allowAlternatives) {
          console.warn("Alternative routes not supported for " + mode + ", falling back to single route...");
          return requestDirectionsWithAlternatives(mode, false);
        }
        return res.json().then(function (errJson) {
          var msg = (errJson && (errJson.error || errJson.message || (errJson.error && errJson.error.message))) || ("HTTP " + res.status);
          throw new Error("NO_ROUTE: " + msg);
        }).catch(function (fallbackErr) {
          throw new Error(fallbackErr.message || "Could not calculate route.");
        });
      }
      return res.json().then(function (data) {
        lastDirectionsGeojson = data;
        lastDirectionsMode = mode;
        renderRoutes(data, !allowAlternatives, mode);
      });
    })
    .catch(function (err) {
      var msg = err.message || "";
      if (msg.indexOf("RATE_LIMIT") !== -1 || msg.indexOf("Too many requests") !== -1) {
        showError("⚠️ Too many requests, please try again in a minute.");
      } else if (msg.indexOf("NO_ROUTE") !== -1) {
        if (mode === "foot-walking") {
          showError("❌ No walking path found between these locations in Delhi NCR (pedestrians may be restricted on highways or expressways along this corridor). Try cycling or driving.");
        } else if (mode === "cycling-regular") {
          showError("❌ No cycling path found between these locations in Delhi NCR (bicycles may be prohibited on certain flyovers or expressways). Try walking or driving.");
        } else {
          showError("❌ No driving route found between these locations.");
        }
      } else if (msg.indexOf("Failed to fetch") !== -1 || msg.indexOf("NetworkError") !== -1) {
        showError("❌ Could not connect to backend at " + API_BASE + ". Please ensure uvicorn is running.");
      } else {
        showError("❌ Route calculation error for " + modeLower + ": " + msg);
      }
      updateSearchStatus("No " + modeLower + " route found.");
      var routesList = document.getElementById("routes-list");
      if (routesList) {
        routesList.innerHTML = '<div style="padding:12px;color:#ef4444;font-size:13px;">No ' + modeLower + ' route found between these points.</div>';
      }
    });
}

// ── 5. Render Routes on the Map & in the Routes List ─────────────────────────

// Geometry helpers for route deduplication (approximated meters in Delhi area)
var M_PER_LAT = 110852;
var M_PER_LNG = 97750; // 111320 * cos(28.6 degrees)

function latLngToMeters(lat, lng) {
  return {
    x: lng * M_PER_LNG,
    y: lat * M_PER_LAT
  };
}

// Distance in meters from point P to line segment AB
function distPointToSegment(p, a, b) {
  var dx = b.x - a.x;
  var dy = b.y - a.y;
  var lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    var ex = p.x - a.x;
    var ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  var projX = a.x + t * dx;
  var projY = a.y + t * dy;
  var rx = p.x - projX;
  var ry = p.y - projY;
  return Math.sqrt(rx * rx + ry * ry);
}

// Find minimum distance in meters from point P to any segment along a path
function minDistanceToPath(p, path) {
  var minD = Infinity;
  for (var i = 0; i < path.length - 1; i++) {
    var d = distPointToSegment(p, path[i], path[i + 1]);
    if (d < minD) {
      minD = d;
      if (minD <= 10) break; // early exit if practically on the segment
    }
  }
  return minD;
}

// Fraction of sampled points in sourceLatLngs that lie within thresholdMeters of targetLatLngs
function getOverlapFraction(sourceLatLngs, targetLatLngs, thresholdMeters) {
  if (!sourceLatLngs || sourceLatLngs.length === 0) return 0;
  if (!targetLatLngs || targetLatLngs.length === 0) return 0;

  var step = Math.max(1, Math.floor(sourceLatLngs.length / 100));
  var sampleCount = 0;
  var withinCount = 0;

  var targetMeters = targetLatLngs.map(function (pt) {
    return latLngToMeters(pt[0], pt[1]);
  });

  for (var i = 0; i < sourceLatLngs.length; i += step) {
    var pt = sourceLatLngs[i];
    var pMeters = latLngToMeters(pt[0], pt[1]);
    sampleCount++;

    var minDist = minDistanceToPath(pMeters, targetMeters);
    if (minDist <= thresholdMeters) {
      withinCount++;
    }
  }

  return sampleCount === 0 ? 0 : (withinCount / sampleCount);
}

// Check if two routes are near-duplicates:
// Distances differ by less than 3% AND more than 85% of sample points of one lie within 100 m of the other
function areRoutesNearDuplicates(routeA, routeB) {
  var dA = routeA.distanceMeters;
  var dB = routeB.distanceMeters;
  var maxD = Math.max(dA, dB);
  if (maxD === 0) return true;

  var distDiffRatio = Math.abs(dA - dB) / maxD;
  if (distDiffRatio >= 0.03) {
    return false; // Distance differs by 3% or more
  }

  // Check point proximity (100 m threshold)
  var overlapAonB = getOverlapFraction(routeA.latlngs, routeB.latlngs, 100);
  if (overlapAonB > 0.85) return true;

  var overlapBonA = getOverlapFraction(routeB.latlngs, routeA.latlngs, 100);
  return (overlapBonA > 0.85);
}

// Deduplicate routes list, keeping the fastest route of each duplicate pair
function deduplicateRoutes(routes) {
  if (routes.length <= 1) return routes;

  var isDuplicate = new Array(routes.length).fill(false);

  for (var i = 0; i < routes.length; i++) {
    if (isDuplicate[i]) continue;
    for (var j = i + 1; j < routes.length; j++) {
      if (isDuplicate[j]) continue;

      if (areRoutesNearDuplicates(routes[i], routes[j])) {
        // Keep the fastest one of the pair (lowest duration in seconds)
        if (routes[j].durationSeconds < routes[i].durationSeconds) {
          isDuplicate[i] = true;
          break; // routes[i] is discarded, move to next i
        } else {
          isDuplicate[j] = true; // routes[j] is discarded
        }
      }
    }
  }

  return routes.filter(function (_, idx) {
    return !isDuplicate[idx];
  });
}


// ── Phase 4 & 6: Route Pollution Scoring with IDW & Breathing Factor ──────────
// Samples points every 200m along the route, computes AQI at each point using
// the existing computeIdw() function, and calculates:
//   1. Average AQI along the route
//   2. Highest (peak) AQI along the route
//   3. Base exposure = sum of (AQI at segment * minutes spent on segment)
//   4. Mode-adjusted exposure = Base exposure * Breathing Factor
//      (Walking: 2.5, Cycling: 2.2, Driving: 1.0)
// Minutes per segment are estimated from the route's total duration spread
// proportionally over its total length.
function scoreRoutePollution(latlngs, durationMin, stations, mode) {
  var breathingFactor = (mode && MODE_BREATHING_FACTORS[mode]) ? MODE_BREATHING_FACTORS[mode] : 1.0;

  if (!stations || stations.length === 0 || !latlngs || latlngs.length < 2) {
    return {
      avgAqi: 0,
      maxAqi: 0,
      exposure: 0,
      baseExposure: 0,
      breathingFactor: breathingFactor,
      sampleCount: 0
    };
  }

  // Calculate cumulative segment lengths in meters
  var segments = [];
  var totalLengthMeters = 0;

  for (var i = 0; i < latlngs.length - 1; i++) {
    var p1 = latLngToMeters(latlngs[i][0], latlngs[i][1]);
    var p2 = latLngToMeters(latlngs[i + 1][0], latlngs[i + 1][1]);
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    segments.push({
      start: latlngs[i],
      end: latlngs[i + 1],
      length: len,
      cumStart: totalLengthMeters,
      cumEnd: totalLengthMeters + len
    });
    totalLengthMeters += len;
  }

  if (totalLengthMeters === 0) {
    var fallbackAqi = Math.round(computeIdw(latlngs[0][0], latlngs[0][1], stations));
    var baseExp = fallbackAqi * durationMin;
    return {
      avgAqi: fallbackAqi,
      maxAqi: fallbackAqi,
      exposure: Math.round(baseExp * breathingFactor),
      baseExposure: Math.round(baseExp),
      breathingFactor: breathingFactor,
      sampleCount: 1
    };
  }

  // Sample a point every 200 meters along the route
  var stepMeters = 200;
  var curDist = 0;
  var segIdx = 0;
  var samples = [];

  while (curDist < totalLengthMeters && segIdx < segments.length) {
    var seg = segments[segIdx];
    if (curDist >= seg.cumStart && curDist <= seg.cumEnd) {
      var segOffset = curDist - seg.cumStart;
      var ratio = seg.length === 0 ? 0 : (segOffset / seg.length);
      var sampleLat = seg.start[0] + ratio * (seg.end[0] - seg.start[0]);
      var sampleLng = seg.start[1] + ratio * (seg.end[1] - seg.start[1]);

      var pieceLen = Math.min(stepMeters, totalLengthMeters - curDist);
      samples.push({
        lat: sampleLat,
        lng: sampleLng,
        lengthMeters: pieceLen
      });

      curDist += stepMeters;
    } else {
      segIdx++;
    }
  }

  // Ensure at least one sample exists
  if (samples.length === 0) {
    samples.push({
      lat: latlngs[0][0],
      lng: latlngs[0][1],
      lengthMeters: totalLengthMeters
    });
  }

  // Compute IDW AQI and segment exposure for each sampled point
  var aqiSum = 0;
  var maxAqi = 0;
  var baseExposure = 0;
  var minutesOverThreshold = 0;
  var activeProfile = getActiveHealthProfile();

  for (var k = 0; k < samples.length; k++) {
    var smp = samples[k];
    // Reusing the existing computeIdw() function without rewriting it!
    var ptAqi = computeIdw(smp.lat, smp.lng, stations);
    aqiSum += ptAqi;
    if (ptAqi > maxAqi) {
      maxAqi = ptAqi;
    }

    // Estimate minutes spent on this segment = total minutes * (segment length / total length)
    var segMinutes = durationMin * (smp.lengthMeters / totalLengthMeters);
    baseExposure += ptAqi * segMinutes;

    // Phase 7: Track minutes exceeding health profile threshold
    if (ptAqi >= activeProfile.threshold) {
      minutesOverThreshold += segMinutes;
    }
  }

  var avgAqi = Math.round(aqiSum / samples.length);
  // Phase 6: Multiply total exposure by breathing factor (Walking: 2.5, Cycling: 2.2, Driving: 1.0)
  var totalExposureWithBreathing = Math.round(baseExposure * breathingFactor);

  return {
    avgAqi: avgAqi,
    maxAqi: Math.round(maxAqi),
    exposure: totalExposureWithBreathing,
    baseExposure: Math.round(baseExposure),
    breathingFactor: breathingFactor,
    sampleCount: samples.length,
    threshold: activeProfile.threshold,
    profileKey: activeProfile.key,
    profileLabel: activeProfile.label,
    minutesOverThreshold: Math.round(minutesOverThreshold)
  };
}

function renderRoutes(geojson, isFallbackSingle, forcedMode) {
  routeLayerGroup.clearLayers();
  activeRoutePolylines = [];
  window.currentRoutesData = [];

  var mode = forcedMode || (modeSelect ? modeSelect.value : "driving-car");
  var modeLabel = getModeLabel(mode);
  var modeLower = modeLabel.toLowerCase();
  var breathingFactor = MODE_BREATHING_FACTORS[mode] || 1.0;

  var features = geojson.features;
  if (!features || features.length === 0) {
    showError("❌ No route found between these locations for " + modeLower + ".");
    updateSearchStatus("No " + modeLower + " route found.");
    return;
  }

  var routeCard = document.getElementById("route-options-card");
  var routesList = document.getElementById("routes-list");
  var noticeEl = document.getElementById("route-notice");
  var comparisonEl = document.getElementById("route-comparison");

  if (routeCard) routeCard.style.display = "flex";
  if (routesList) routesList.innerHTML = "";

  // 1. Parse raw routes
  var rawRoutes = features.map(function (feat, idx) {
    var coords = feat.geometry.coordinates; // array of [lon, lat]
    var latlngs = coords.map(function (c) { return [c[1], c[0]]; }); // convert to [lat, lng]
    var summary = feat.properties.summary || {};
    var distMeters = summary.distance || 0;
    var durSeconds = summary.duration || 0;

    return {
      originalIndex: idx,
      feature: feat,
      latlngs: latlngs,
      summary: summary,
      distanceMeters: distMeters,
      durationSeconds: durSeconds,
      distanceKm: parseFloat((distMeters / 1000).toFixed(1)),
      durationMin: Math.round(durSeconds / 60)
    };
  });

  // 2. Remove near-duplicates, keeping the fastest of each duplicate pair
  var distinctRoutes = deduplicateRoutes(rawRoutes);

  if (distinctRoutes.length === 0) {
    showError("❌ No valid " + modeLower + " routes found.");
    updateSearchStatus("No " + modeLower + " route found.");
    return;
  }

  // 3. Show notice if only 1 or 2 distinct routes remain
  if (noticeEl) {
    if (distinctRoutes.length === 1) {
      noticeEl.textContent = "Only 1 distinct " + modeLower + " route found for this trip";
      noticeEl.style.display = "block";
    } else if (distinctRoutes.length === 2) {
      noticeEl.textContent = "Only 2 distinct " + modeLower + " routes found for this trip";
      noticeEl.style.display = "block";
    } else {
      noticeEl.style.display = "none";
    }
  }

  // 4. Calculate Phase 4 & Phase 6 pollution scores for each distinct route
  // Reuses computeIdw() with currentValidStations and applies breathing factor
  distinctRoutes.forEach(function (r, idx) {
    r.name = modeLabel + " Route " + (idx + 1);
    var score = scoreRoutePollution(r.latlngs, r.durationMin, currentValidStations, mode);
    r.avgAqi = score.avgAqi;
    r.maxAqi = score.maxAqi;
    r.exposure = score.exposure;
    r.baseExposure = score.baseExposure;
    r.breathingFactor = score.breathingFactor;
    r.minutesOverThreshold = score.minutesOverThreshold;
    r.profileLabel = score.profileLabel;
  });

  // Find the cleanest route (lowest exposure) and the fastest route (lowest duration)
  var minExposure = Infinity;
  var cleanestIndex = 0;
  var minDuration = Infinity;
  var fastestIndex = 0;
  var minDistance = Infinity;
  var shortestIndex = 0;

  distinctRoutes.forEach(function (r, idx) {
    if (r.exposure < minExposure) {
      minExposure = r.exposure;
      cleanestIndex = idx;
    }
    if (r.durationSeconds < minDuration) {
      minDuration = r.durationSeconds;
      fastestIndex = idx;
    }
    if (r.distanceMeters < minDistance) {
      minDistance = r.distanceMeters;
      shortestIndex = idx;
    }
  });

  // Assign honest badges: "Cleanest" in green, others in grey
  distinctRoutes.forEach(function (r, idx) {
    var isCleanest = (idx === cleanestIndex);
    var isFastest = (idx === fastestIndex);
    var isShortest = (idx === shortestIndex);

    if (isCleanest) {
      r.badgeText = "Cleanest";
      r.badgeClass = "badge-cleanest"; // green badge
    } else if (isFastest) {
      r.badgeText = "Fastest";
      r.badgeClass = "badge-alt"; // grey badge
    } else if (isShortest) {
      r.badgeText = "Shortest";
      r.badgeClass = "badge-alt"; // grey badge
    } else {
      r.badgeText = "Alternative";
      r.badgeClass = "badge-alt"; // grey badge
    }
    r.isCleanest = isCleanest;
  });

  var allLatLngs = [];
  var cleanestPolyline = null;

  // 5. Render distinct routes and draw polylines
  distinctRoutes.forEach(function (route, idx) {
    var latlngs = route.latlngs;
    allLatLngs = allLatLngs.concat(latlngs);

    var color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
    var isCleanest = route.isCleanest;

    // Draw the cleanest route as a thicker line on top
    var polyline = L.polyline(latlngs, {
      color: color,
      weight: isCleanest ? 7 : 4,
      opacity: isCleanest ? 0.95 : 0.40,
      lineCap: "round",
      lineJoin: "round"
    }).addTo(routeLayerGroup);

    if (isCleanest) {
      cleanestPolyline = polyline;
    }

    activeRoutePolylines.push({
      index: idx,
      polyline: polyline,
      color: color,
      isCleanest: isCleanest
    });

    // Save comprehensive data to window.currentRoutesData
    window.currentRoutesData.push({
      index: idx,
      name: route.name,
      mode: mode,
      badge: route.badgeText,
      color: color,
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      avgAqi: route.avgAqi,
      maxAqi: route.maxAqi,
      exposure: route.exposure,
      baseExposure: route.baseExposure,
      breathingFactor: route.breathingFactor,
      isCleanest: isCleanest,
      coordinates: latlngs, // [[lat, lng], [lat, lng], ...]
      summary: route.summary,
      feature: route.feature
    });

    // AQI badge color using standard AQI scale
    var aqiColor = getAqiColor(route.avgAqi);
    var aqiTextColor = (route.avgAqi <= 100) ? "#111" : "#fff";

    // Create route item card in the UI list
    var routeItem = document.createElement("div");
    routeItem.className = "route-item" + (isCleanest ? " active" : "");
    routeItem.id = "route-item-" + idx;

    // Phase 7: Profile threshold alert line for this route
    var thresholdWarningHtml = "";
    if (route.minutesOverThreshold && route.minutesOverThreshold > 0) {
      thresholdWarningHtml =
        '<div class="route-health-warning">' +
          '⚠️ This route may trigger your ' + escapeHtml(route.profileLabel.toLowerCase()) + ' threshold for ' +
          route.minutesOverThreshold + ' of ' + route.durationMin + ' minutes' +
        '</div>';
    }

    routeItem.innerHTML =
      '<div class="route-item-left">' +
        '<div class="route-color-pill" style="background:' + color + '"></div>' +
        '<div>' +
          '<div class="route-item-title">' +
            escapeHtml(route.name) +
            ' <span class="route-badge ' + escapeHtml(route.badgeClass) + '" title="Cleanest = lowest total pollution exposure (AQI x time), not just lowest average AQI.">' + escapeHtml(route.badgeText) + '</span>' +
          '</div>' +
          '<div class="route-item-stats">' +
            '<span>' + route.distanceKm + ' km • ' + route.durationMin + ' min</span>' +
            '<span class="stat-sep">•</span>' +
            '<span>Avg AQI</span>' +
            '<span class="route-aqi-pill" style="background:' + aqiColor + ';color:' + aqiTextColor + ';">' +
              route.avgAqi +
            '</span>' +
            '<span class="stat-sep">•</span>' +
            '<span title="Cleanest = lowest total pollution exposure (AQI x time), not just lowest average AQI.">Exposure</span>' +
            '<span class="route-exposure-pill" title="Total pollution exposure: AQI × time' + (route.breathingFactor !== 1 ? ' × ' + route.breathingFactor + 'x breathing factor' : '') + '">' +
              route.exposure +
            '</span>' +
          '</div>' +
          thresholdWarningHtml +
        '</div>' +
      '</div>';

    // Click on route item highlights it
    routeItem.addEventListener("click", function () {
      highlightRoute(idx);
    });

    // Click on polyline also highlights it
    polyline.on("click", function () {
      highlightRoute(idx);
    });

    routesList.appendChild(routeItem);
  });

  // Display the explanation hint below the route list
  var hintEl = document.getElementById("route-hint");
  if (hintEl) hintEl.style.display = "block";

  // Ensure the cleanest route is drawn on top
  if (cleanestPolyline) {
    cleanestPolyline.bringToFront();
  }

  selectedRouteIndex = cleanestIndex;

  // 6. Write a plain sentence under the list comparing pollution exposure
  if (comparisonEl) {
    if (distinctRoutes.length <= 1) {
      comparisonEl.textContent = "Only 1 " + modeLower + " route available. Average AQI is " + distinctRoutes[0].avgAqi + ".";
      comparisonEl.style.display = "block";
    } else {
      var cleanestRoute = distinctRoutes[cleanestIndex];
      var fastestRoute = distinctRoutes[fastestIndex];

      if (cleanestIndex === fastestIndex) {
        // Cleanest route is also the fastest
        comparisonEl.textContent = "Fastest " + modeLower + " route is also the cleanest.";
      } else {
        var exposureDiffPct = 0;
        if (fastestRoute.exposure > 0) {
          exposureDiffPct = Math.round(
            ((fastestRoute.exposure - cleanestRoute.exposure) / fastestRoute.exposure) * 100
          );
        }

        if (exposureDiffPct < 5) {
          // Difference under 5%
          comparisonEl.textContent = modeLabel + " routes are about the same in pollution. Take the fastest.";
        } else {
          var timeDiffMin = Math.round(cleanestRoute.durationMin - fastestRoute.durationMin);
          var timePhrase = timeDiffMin > 0 ? "and takes " + timeDiffMin + " min longer." : "with the same travel time.";
          comparisonEl.textContent =
            cleanestRoute.name +
            " has " +
            exposureDiffPct +
            "% lower pollution exposure than the fastest " +
            modeLower +
            " route, " +
            timePhrase;
        }
      }
      comparisonEl.style.display = "block";
    }
  }

  // Phase 8: Fetch leave-time forecast suggestion for the trip
  var cleanestRoute = distinctRoutes[cleanestIndex];
  var startLat = startLocation ? startLocation.lat : (cleanestRoute.latlngs[0] ? cleanestRoute.latlngs[0][0] : null);
  var startLng = startLocation ? startLocation.lng : (cleanestRoute.latlngs[0] ? cleanestRoute.latlngs[0][1] : null);
  if (startLat !== null && startLng !== null && cleanestRoute) {
    fetchLeaveTimeSuggestion(startLat, startLng, cleanestRoute);
  }

  // Feature 9: Show trip cigarette impact for the cleanest route by default
  if (distinctRoutes[cleanestIndex]) {
    updateTripImpactCard(distinctRoutes[cleanestIndex]);
  }

  // Zoom map to fit the full route
  if (allLatLngs.length > 0) {
    map.fitBounds(L.latLngBounds(allLatLngs), { padding: [50, 50] });
  }

  updateSearchStatus("Found " + distinctRoutes.length + " distinct " + modeLower + " route" + (distinctRoutes.length > 1 ? "s" : "") + ".");
}

// ── Highlight a selected route and fade others ───────────────────────────────
function highlightRoute(targetIndex) {
  selectedRouteIndex = targetIndex;

  activeRoutePolylines.forEach(function (item) {
    var isSelected = (item.index === targetIndex);
    if (isSelected) {
      item.polyline.setStyle({
        weight: item.isCleanest ? 7 : 6,
        opacity: 0.95
      });
      item.polyline.bringToFront();
    } else {
      item.polyline.setStyle({
        weight: 4,
        opacity: 0.35
      });
    }

    var card = document.getElementById("route-item-" + item.index);
    if (card) {
      if (isSelected) {
        card.classList.add("active");
      } else {
        card.classList.remove("active");
      }
    }
  });

  // Feature 9: Update Trip Cigarette & Inhalation Exposure Card
  if (window.currentRoutesData && window.currentRoutesData[targetIndex]) {
    updateTripImpactCard(window.currentRoutesData[targetIndex]);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MULTI-PAGE WEBSITE CONTROLLERS (ROUTING, THEME, DELHI AQI NOW, AREAS, SHARE)
// ══════════════════════════════════════════════════════════════════════════════

// ── 1. Dark Mode / Light Mode Controller ─────────────────────────────────────
var currentTheme = localStorage.getItem("aqi_theme") || "dark";

function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem("aqi_theme", theme);
  var iconEl = document.getElementById("theme-icon");
  var labelEl = document.getElementById("theme-label");

  if (theme === "dark") {
    document.body.classList.add("dark-mode");
    if (iconEl) iconEl.textContent = "☀️";
    if (labelEl) labelEl.textContent = "Light";
  } else {
    document.body.classList.remove("dark-mode");
    if (iconEl) iconEl.textContent = "🌙";
    if (labelEl) labelEl.textContent = "Dark";
  }

  // Refresh 24h chart colors if active
  if (window.aqiTrendChart) {
    renderTrendChart();
  }
}

var themeToggleBtn = document.getElementById("theme-toggle-btn");
if (themeToggleBtn) {
  themeToggleBtn.addEventListener("click", function () {
    var nextTheme = currentTheme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
  });
}
applyTheme(currentTheme);


// ── 2. Client-Side Hash Router ────────────────────────────────────────────────
var PAGE_VIEWS = {
  map: document.getElementById("view-map"),
  now: document.getElementById("view-now"),
  commute: document.getElementById("view-commute"),
  advisor: document.getElementById("view-advisor"),
  school: document.getElementById("view-school"),
  compare: document.getElementById("view-compare"),
  areas: document.getElementById("view-areas"),
  guide: document.getElementById("view-guide"),
  about: document.getElementById("view-about")
};

function switchPage(pageKey) {
  var targetKey = (pageKey || "").replace("#", "").trim().toLowerCase();
  if (!PAGE_VIEWS[targetKey]) {
    targetKey = "map";
  }

  // Toggle page visibility
  Object.keys(PAGE_VIEWS).forEach(function (k) {
    if (PAGE_VIEWS[k]) {
      if (k === targetKey) {
        PAGE_VIEWS[k].classList.add("active");
        PAGE_VIEWS[k].style.display = (k === "map") ? "flex" : "block";
      } else {
        PAGE_VIEWS[k].classList.remove("active");
        PAGE_VIEWS[k].style.display = "none";
      }
    }
  });

  // Update navigation bar active pill
  var navLinks = document.querySelectorAll(".nav-link");
  navLinks.forEach(function (link) {
    var page = link.getAttribute("data-page");
    if (page === targetKey) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });

  // Page-specific activation logic
  if (targetKey === "map") {
    setTimeout(function () {
      if (map) {
        map.invalidateSize();
      }
    }, 60);
  } else if (targetKey === "now") {
    updateDelhiAqiNow();
    renderTrendChart();
    updatePollutionPulse();
    updateHealthyHomeHelper();
  } else if (targetKey === "commute") {
    renderCommutePage();
  } else if (targetKey === "advisor") {
    renderPersonalSafetyAdvisor();
  } else if (targetKey === "school") {
    renderSchoolMode();
  } else if (targetKey === "compare") {
    renderStationComparison();
  } else if (targetKey === "areas") {
    renderAreasTable();
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

window.addEventListener("hashchange", function () {
  switchPage(window.location.hash);
});


// ── 3. "Delhi AQI Now" Page Controller ────────────────────────────────────────
function updateDelhiAqiNow() {
  if (!currentValidStations || currentValidStations.length === 0) return;

  var totalAqi = 0;
  var minStation = null;
  var maxStation = null;

  currentValidStations.forEach(function (s) {
    var val = (s.displayAqi !== undefined && s.displayAqi !== null) ? s.displayAqi : s.aqi;
    totalAqi += val;
    if (!minStation || val < ((minStation.displayAqi !== undefined) ? minStation.displayAqi : minStation.aqi)) minStation = s;
    if (!maxStation || val > ((maxStation.displayAqi !== undefined) ? maxStation.displayAqi : maxStation.aqi)) maxStation = s;
  });

  var avgAqi = Math.round(totalAqi / currentValidStations.length);
  var adviceObj = getHealthAdvice(avgAqi, currentAqiScale);
  var aqiColor = getAqiColor(avgAqi, currentAqiScale);
  var aqiTextColor = adviceObj.textColor;

  var valEl = document.getElementById("hero-aqi-value");
  var badgeEl = document.getElementById("hero-category-badge");
  var scaleTagEl = document.getElementById("hero-scale-tag");
  var minEl = document.getElementById("hero-min-station");
  var maxEl = document.getElementById("hero-max-station");
  var adviceEl = document.getElementById("hero-advice-text");
  var dateBadgeEl = document.getElementById("hero-date-badge");
  var updatedTimeEl = document.getElementById("now-updated-time");

  var now = new Date();
  var dateStr = now.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  var timeStr = now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

  if (valEl) valEl.textContent = avgAqi;
  if (scaleTagEl) scaleTagEl.textContent = (currentAqiScale === "india") ? "India NAQI" : "US AQI";
  if (badgeEl) {
    badgeEl.textContent = adviceObj.category;
    badgeEl.style.backgroundColor = aqiColor;
    badgeEl.style.color = aqiTextColor;
  }

  var minAqi = minStation ? ((minStation.displayAqi !== undefined) ? minStation.displayAqi : minStation.aqi) : 0;
  var maxAqi = maxStation ? ((maxStation.displayAqi !== undefined) ? maxStation.displayAqi : maxStation.aqi) : 0;
  var minFallback = (minStation && minStation.isFallback) ? " (US fallback)" : "";
  var maxFallback = (maxStation && maxStation.isFallback) ? " (US fallback)" : "";

  if (minEl && minStation) minEl.textContent = minStation.name + " (" + minAqi + minFallback + ")";
  if (maxEl && maxStation) maxEl.textContent = maxStation.name + " (" + maxAqi + maxFallback + ")";
  if (adviceEl) adviceEl.textContent = adviceObj.advice;
  if (dateBadgeEl) dateBadgeEl.textContent = dateStr;

  var agoStr = getUpdatedTimeAgoString(lastStationFetchTimestamp);
  if (updatedTimeEl) updatedTimeEl.textContent = agoStr + " (" + timeStr + " IST)";

  // KPIs
  var cleanestNameEl = document.getElementById("kpi-cleanest-name");
  var cleanestAqiEl = document.getElementById("kpi-cleanest-aqi");
  if (cleanestNameEl && minStation) cleanestNameEl.textContent = minStation.name + minFallback;
  if (cleanestAqiEl && minStation) cleanestAqiEl.textContent = "AQI " + minAqi;

  var highestNameEl = document.getElementById("kpi-highest-name");
  var highestAqiEl = document.getElementById("kpi-highest-aqi");
  if (highestNameEl && maxStation) highestNameEl.textContent = maxStation.name + maxFallback;
  if (highestAqiEl && maxStation) highestAqiEl.textContent = "AQI " + maxAqi;

  var countEl = document.getElementById("kpi-stations-count");
  if (countEl) countEl.textContent = currentValidStations.length;

  var centerAqiEl = document.getElementById("kpi-center-aqi");
  if (centerAqiEl) {
    var cAqi = Math.round(computeIdw(28.6139, 77.2090, currentValidStations));
    centerAqiEl.textContent = "AQI " + cAqi;
  }
}


// ── 4. 24-Hour Air Quality Forecast Curve (Chart.js) ─────────────────────────
window.aqiTrendChart = null;

function renderTrendChart() {
  var canvas = document.getElementById("trend-chart");
  if (!canvas) return;

  var isDark = document.body.classList.contains("dark-mode");
  var textColor = isDark ? "#94a3b8" : "#475569";
  var gridColor = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";
  var lineColor = "#f59e0b"; // Warm golden/amber line matching inspiration screenshot
  var gradientStart = isDark ? "rgba(245, 158, 11, 0.35)" : "rgba(245, 158, 11, 0.25)";
  var gradientEnd = isDark ? "rgba(245, 158, 11, 0.0)" : "rgba(245, 158, 11, 0.0)";

  var forecastUrl = FORECAST_API_URL + "?lat=28.6139&lng=77.2090";

  fetch(forecastUrl)
    .then(function (res) {
      if (!res.ok) throw new Error("Forecast API HTTP " + res.status);
      return res.json();
    })
    .then(function (data) {
      if (!data || !data.hourly || !data.hourly.time || !data.hourly.us_aqi) return;

      var times = data.hourly.time;
      var aqis = data.hourly.us_aqi;
      var pm25s = data.hourly.pm2_5 || [];

      var nowMs = Date.now();
      var startIdx = 0;
      for (var i = 0; i < times.length; i++) {
        var t = new Date(times[i]).getTime();
        if (t >= nowMs - 30 * 60 * 1000) {
          startIdx = i;
          break;
        }
      }

      var labels = [];
      var values = [];
      for (var j = startIdx; j < startIdx + 24 && j < times.length; j++) {
        var d = new Date(times[j]);
        var hourStr = d.toLocaleTimeString([], { hour: "numeric" });
        labels.push(hourStr);

        var val = aqis[j];
        if (val === null || val === undefined) {
          val = (pm25s[j] != null) ? Math.round(pm25s[j] * 2.5) : 100;
        }
        values.push(val);
      }

      if (window.aqiTrendChart) {
        window.aqiTrendChart.destroy();
      }

      var ctx = canvas.getContext("2d");
      var gradient = ctx.createLinearGradient(0, 0, 0, 200);
      gradient.addColorStop(0, gradientStart);
      gradient.addColorStop(1, gradientEnd);

      window.aqiTrendChart = new Chart(ctx, {
        type: "line",
        data: {
          labels: labels,
          datasets: [{
            label: "Forecast US AQI",
            data: values,
            borderColor: lineColor,
            borderWidth: 3,
            backgroundColor: gradient,
            fill: true,
            tension: 0.45,
            pointRadius: 3,
            pointHoverRadius: 6,
            pointBackgroundColor: lineColor,
            pointBorderColor: "#fff",
            pointBorderWidth: 1.5
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  var v = ctx.parsed.y;
                  var advice = getHealthAdvice(v);
                  return "AQI: " + v + " (" + advice.category + ")";
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: gridColor },
              ticks: { color: textColor, font: { size: 11 } }
            },
            y: {
              grid: { color: gridColor },
              ticks: { color: textColor, font: { size: 11 } },
              suggestedMin: 50
            }
          }
        }
      });
    })
    .catch(function (err) {
      console.warn("Trend chart forecast load warning:", err);
    });
}


// ── 5. "Areas" Page Controller (Sortable Station Table) ──────────────────────
var areasSortColumn = "aqi";
var areasSortAsc = false;

function renderAreasTable() {
  var tbody = document.getElementById("areas-table-body");
  var countLabel = document.getElementById("areas-count-label");
  var searchInput = document.getElementById("areas-search-input");
  if (!tbody) return;

  if (!currentValidStations || currentValidStations.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-loading-cell">Loading stations from backend…</td></tr>';
    return;
  }

  var filterText = (searchInput && searchInput.value) ? searchInput.value.trim().toLowerCase() : "";

  var filtered = currentValidStations.filter(function (s) {
    if (!filterText) return true;
    return s.name.toLowerCase().indexOf(filterText) !== -1;
  });

  // Sort by AQI (in active scale) or Name
  filtered.sort(function (a, b) {
    var valA = (a.displayAqi !== undefined && a.displayAqi !== null) ? a.displayAqi : a.aqi;
    var valB = (b.displayAqi !== undefined && b.displayAqi !== null) ? b.displayAqi : b.aqi;
    if (areasSortColumn === "aqi") {
      return areasSortAsc ? (valA - valB) : (valB - valA);
    } else if (areasSortColumn === "name") {
      return areasSortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
    }
    return 0;
  });

  if (countLabel) {
    countLabel.textContent = "Showing " + filtered.length + " of " + currentValidStations.length + " monitoring stations";
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-loading-cell">No stations found matching "' + escapeHtml(filterText) + '"</td></tr>';
    return;
  }

  tbody.innerHTML = "";
  filtered.forEach(function (station) {
    var aqiVal = (station.displayAqi !== undefined && station.displayAqi !== null) ? station.displayAqi : station.aqi;
    var aqiColor = getAqiColor(aqiVal, currentAqiScale);
    var advice = getHealthAdvice(aqiVal, currentAqiScale);
    var aqiTextColor = advice.textColor;
    var timeFormatted = station.time ? formatMeasuredTime(station.time) : "Recent";
    var fallbackNote = station.isFallback
      ? ' <span class="scale-fallback-tag" title="PM sensor concentration missing; showing US EPA AQI">US Fallback</span>'
      : '';

    var tr = document.createElement("tr");
    tr.className = "clickable-row";
    tr.innerHTML =
      '<td><strong>' + escapeHtml(station.name) + '</strong>' + fallbackNote + '</td>' +
      '<td><span class="station-aqi-pill" style="background:' + aqiColor + ';color:' + aqiTextColor + ';">' + aqiVal + '</span></td>' +
      '<td><span class="station-cat-badge">' + escapeHtml(advice.category) + '</span></td>' +
      '<td style="font-size:12px;color:var(--text-secondary);">' + escapeHtml(timeFormatted) + '</td>' +
      '<td><button type="button" class="btn-view-map" title="View on Live Map">📍 Map</button></td>';

    tr.addEventListener("click", function () {
      navigateToStationOnMap(station);
    });

    tbody.appendChild(tr);
  });
}

function navigateToStationOnMap(station) {
  window.location.hash = "#map";
  switchPage("map");
  setTimeout(function () {
    if (map) {
      map.setView([station.lat, station.lng], 14);
      stationMarkers.eachLayer(function (layer) {
        if (layer.getLatLng) {
          var ll = layer.getLatLng();
          if (Math.abs(ll.lat - station.lat) < 0.001 && Math.abs(ll.lng - station.lng) < 0.001) {
            layer.openPopup();
          }
        }
      });
    }
  }, 120);
}

var thAqi = document.getElementById("th-sort-aqi");
if (thAqi) {
  thAqi.addEventListener("click", function () {
    if (areasSortColumn === "aqi") {
      areasSortAsc = !areasSortAsc;
    } else {
      areasSortColumn = "aqi";
      areasSortAsc = false;
    }
    var arrow = document.getElementById("sort-aqi-arrow");
    if (arrow) arrow.textContent = areasSortAsc ? "↑" : "↓";
    renderAreasTable();
  });
}

var areasSearchInput = document.getElementById("areas-search-input");
if (areasSearchInput) {
  areasSearchInput.addEventListener("input", function () {
    renderAreasTable();
  });
}


// ── 6. "Share Today's AQI" Canvas Generator ──────────────────────────────────
function generateShareCard(callback) {
  var canvas = document.getElementById("share-canvas");
  if (!canvas) return;
  var ctx = canvas.getContext("2d");

  var totalAqi = 0;
  var minStation = null;
  var maxStation = null;
  currentValidStations.forEach(function (s) {
    var val = (s.displayAqi !== undefined && s.displayAqi !== null) ? s.displayAqi : s.aqi;
    totalAqi += val;
    if (!minStation || val < ((minStation.displayAqi !== undefined) ? minStation.displayAqi : minStation.aqi)) minStation = s;
    if (!maxStation || val > ((maxStation.displayAqi !== undefined) ? maxStation.displayAqi : maxStation.aqi)) maxStation = s;
  });
  var avgAqi = currentValidStations.length > 0 ? Math.round(totalAqi / currentValidStations.length) : 150;
  var advice = getHealthAdvice(avgAqi, currentAqiScale);
  var aqiColor = getAqiColor(avgAqi, currentAqiScale);

  var now = new Date();
  var dateStr = now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  var timeStr = now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

  var w = canvas.width;
  var h = canvas.height;

  // Background dusk-sky gradient
  var bgGradient = ctx.createLinearGradient(0, 0, w, h);
  bgGradient.addColorStop(0, "#081b33");
  bgGradient.addColorStop(0.5, "#0d2b4d");
  bgGradient.addColorStop(1, "#071526");
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, w, h);

  // Radial glow
  var radial = ctx.createRadialGradient(w / 2, 380, 50, w / 2, 380, 400);
  radial.addColorStop(0, "rgba(56, 189, 248, 0.18)");
  radial.addColorStop(1, "transparent");
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, w, h);

  // Header
  ctx.fillStyle = "#38bdf8";
  ctx.font = "bold 22px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("🌬️ DELHI NCR AIR QUALITY REPORT", w / 2, 85);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "600 18px system-ui, sans-serif";
  ctx.fillText(dateStr + " • " + timeStr + " IST", w / 2, 120);

  // Circular Badge
  var centerX = w / 2;
  var centerY = 320;
  var radius = 130;

  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  ctx.fillStyle = "rgba(15, 30, 50, 0.85)";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = aqiColor;
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.font = "800 92px system-ui, sans-serif";
  ctx.fillText(avgAqi.toString(), centerX, centerY + 20);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "bold 16px system-ui, sans-serif";
  var scaleTitle = (currentAqiScale === "india") ? "INDIA NAQI (CITY AVG)" : "US AQI (CITY AVG)";
  ctx.fillText(scaleTitle, centerX, centerY + 65);

  // Category Pill
  var pillW = 260;
  var pillH = 46;
  var pillX = centerX - pillW / 2;
  var pillY = 490;
  ctx.fillStyle = aqiColor;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(pillX, pillY, pillW, pillH, 23);
  } else {
    ctx.rect(pillX, pillY, pillW, pillH);
  }
  ctx.fill();

  ctx.fillStyle = advice.textColor;
  ctx.font = "800 22px system-ui, sans-serif";
  ctx.fillText(advice.category.toUpperCase(), centerX, pillY + 31);

  // Health Advice Box
  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  var advW = 680;
  var advH = 95;
  var advX = centerX - advW / 2;
  var advY = 565;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(advX, advY, advW, advH, 16);
  } else {
    ctx.rect(advX, advY, advW, advH);
  }
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.stroke();

  ctx.fillStyle = "#f8fafc";
  ctx.font = "500 17px system-ui, sans-serif";
  var words = advice.advice.split(" ");
  var line = "";
  var lineY = advY + 40;
  for (var n = 0; n < words.length; n++) {
    var testLine = line + words[n] + " ";
    var metrics = ctx.measureText(testLine);
    if (metrics.width > advW - 40 && n > 0) {
      ctx.fillText(line, centerX, lineY);
      line = words[n] + " ";
      lineY += 26;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, centerX, lineY);

  // Stats Summary
  ctx.fillStyle = "#94a3b8";
  ctx.font = "600 15px system-ui, sans-serif";
  var statsText = "Stations Reporting: " + currentValidStations.length;
  if (minStation && maxStation) {
    var minVal = (minStation.displayAqi !== undefined) ? minStation.displayAqi : minStation.aqi;
    var maxVal = (maxStation.displayAqi !== undefined) ? maxStation.displayAqi : maxStation.aqi;
    statsText += "  •  Lowest: " + minVal + "  •  Highest: " + maxVal;
  }
  ctx.fillText(statsText, centerX, 700);

  // Footer Branding
  ctx.fillStyle = "rgba(56, 189, 248, 0.9)";
  ctx.font = "700 14px system-ui, sans-serif";
  ctx.fillText("Delhi AQI Sentinel • Real-Time Spatial Air Quality & Cleanest Route Navigation", centerX, 755);

  if (callback) callback();
}

var openShareBtn = document.getElementById("open-share-modal-btn");
var shareModal = document.getElementById("share-modal");
var closeShareBtn = document.getElementById("close-share-modal-btn");
var shareBackdrop = document.getElementById("share-backdrop");
var downloadShareBtn = document.getElementById("download-share-img-btn");
var copyShareBtn = document.getElementById("copy-share-img-btn");
var shareStatusMsg = document.getElementById("share-status-msg");

if (openShareBtn && shareModal) {
  openShareBtn.addEventListener("click", function () {
    shareModal.style.display = "flex";
    if (shareStatusMsg) shareStatusMsg.textContent = "";
    generateShareCard();
  });
}

function closeShareModal() {
  if (shareModal) shareModal.style.display = "none";
}
if (closeShareBtn) closeShareBtn.addEventListener("click", closeShareModal);
if (shareBackdrop) shareBackdrop.addEventListener("click", closeShareModal);

if (downloadShareBtn) {
  downloadShareBtn.addEventListener("click", function () {
    var canvas = document.getElementById("share-canvas");
    if (!canvas) return;
    var dataUrl = canvas.toDataURL("image/png");
    var link = document.createElement("a");
    link.download = "delhi-aqi-today.png";
    link.href = dataUrl;
    link.click();
    if (shareStatusMsg) shareStatusMsg.textContent = "✅ Image downloaded successfully!";
  });
}

if (copyShareBtn) {
  copyShareBtn.addEventListener("click", function () {
    var canvas = document.getElementById("share-canvas");
    if (!canvas) return;
    if (navigator.clipboard && canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (!blob) return;
        try {
          var item = new ClipboardItem({ "image/png": blob });
          navigator.clipboard.write([item]).then(function () {
            if (shareStatusMsg) shareStatusMsg.textContent = "✅ Image copied to clipboard!";
          }).catch(function () {
            if (shareStatusMsg) shareStatusMsg.textContent = "📋 Click 'Download Image' to save as PNG.";
          });
        } catch (e) {
          if (shareStatusMsg) shareStatusMsg.textContent = "📋 Click 'Download Image' to save as PNG.";
        }
      });
    } else {
      if (shareStatusMsg) shareStatusMsg.textContent = "📋 Click 'Download Image' to save as PNG.";
    }
  });
}

// ── AQI Scale Toggle Event Listeners ─────────────────────────────────────────
var scaleBtnIndia = document.getElementById("scale-btn-india");
var scaleBtnUs = document.getElementById("scale-btn-us");

if (scaleBtnIndia) {
  scaleBtnIndia.addEventListener("click", function () {
    setAqiScale("india");
  });
}

if (scaleBtnUs) {
  scaleBtnUs.addEventListener("click", function () {
    setAqiScale("us");
  });
}

// Ensure toggle button active class reflects initial scale (India by default)
if (scaleBtnIndia && scaleBtnUs) {
  if (currentAqiScale === "india") {
    scaleBtnIndia.classList.add("active");
    scaleBtnUs.classList.remove("active");
  } else {
    scaleBtnUs.classList.add("active");
    scaleBtnIndia.classList.remove("active");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 1: COMMUTE PLANNER (ENHANCED WITH SMART SWAP & RETURN OUTLOOK)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
var lastCommuteRouteData = null;
var commuteDirectionSwapped = false;

/**
 * renderCommutePage()
 * Called every time the #commute page becomes visible.
 * Looks up saved Home + Work, populates AQI pills, then runs the route fetch.
 */
function renderCommutePage() {
  var setupPrompt = document.getElementById("commute-setup-prompt");
  var commuteCard = document.getElementById("commute-card");
  var resultsEl = document.getElementById("commute-results");
  var errorEl = document.getElementById("commute-error");
  var loadingEl = document.getElementById("commute-loading");

  var places = getSavedPlaces();
  var homePlace = places.find(function (p) {
    return /^home$/i.test(p.name.trim());
  });
  var workPlace = places.find(function (p) {
    return /^(work|office)$/i.test(p.name.trim());
  });

  if (!homePlace || !workPlace) {
    if (setupPrompt) setupPrompt.style.display = "block";
    if (commuteCard) commuteCard.style.display = "none";
    return;
  }

  if (setupPrompt) setupPrompt.style.display = "none";
  if (commuteCard) commuteCard.style.display = "block";
  if (resultsEl) resultsEl.style.display = "none";
  if (errorEl) errorEl.style.display = "none";
  if (loadingEl) loadingEl.style.display = "none";

  var originPlace = commuteDirectionSwapped ? workPlace : homePlace;
  var destPlace = commuteDirectionSwapped ? homePlace : workPlace;

  var homeNameEl = document.getElementById("commute-home-name");
  var workNameEl = document.getElementById("commute-work-name");
  var originLabel = document.getElementById("commute-origin-label");
  var destLabel = document.getElementById("commute-dest-label");
  var originIcon = document.getElementById("commute-origin-icon");
  var destIcon = document.getElementById("commute-dest-icon");

  if (originLabel) originLabel.textContent = commuteDirectionSwapped ? "Origin (Work)" : "Origin (Home)";
  if (destLabel) destLabel.textContent = commuteDirectionSwapped ? "Destination (Home)" : "Destination (Work)";
  if (originIcon) originIcon.textContent = commuteDirectionSwapped ? "🏢" : "🏠";
  if (destIcon) destIcon.textContent = commuteDirectionSwapped ? "🏠" : "🏢";
  if (homeNameEl) homeNameEl.textContent = originPlace.name;
  if (workNameEl) workNameEl.textContent = destPlace.name;

  updateCommuteAqiPills(originPlace, destPlace);
}

/**
 * updateCommuteAqiPills(originPlace, destPlace)
 * Shows current AQI estimate at origin and destination using IDW interpolation.
 */
function updateCommuteAqiPills(originPlace, destPlace) {
  function setPill(elId, lat, lng) {
    var el = document.getElementById(elId);
    if (!el) return;
    if (!currentValidStations || currentValidStations.length === 0) {
      el.textContent = "--";
      el.style.background = "#888";
      return;
    }
    var aqi = Math.round(computeIdw(lat, lng, currentValidStations));
    var color = getAqiColor(aqi, currentAqiScale);
    el.textContent = "AQI " + aqi;
    el.style.background = color;
    el.style.color = getHealthAdvice(aqi, currentAqiScale).textColor;
  }
  setPill("commute-home-aqi", originPlace.lat, originPlace.lng);
  setPill("commute-work-aqi", destPlace.lat, destPlace.lng);
}

/**
 * runCommuteRoute()
 * Fetches alternative routes between origin & destination, scores them,
 * and renders cleanest vs fastest along with leave-time and return forecast.
 */
function runCommuteRoute() {
  var places = getSavedPlaces();
  var homePlace = places.find(function (p) { return /^home$/i.test(p.name.trim()); });
  var workPlace = places.find(function (p) { return /^(work|office)$/i.test(p.name.trim()); });
  if (!homePlace || !workPlace) return;

  var originPlace = commuteDirectionSwapped ? workPlace : homePlace;
  var destPlace = commuteDirectionSwapped ? homePlace : workPlace;

  var modeSelect = document.getElementById("commute-mode-select");
  var mode = modeSelect ? modeSelect.value : "driving-car";

  var loadingEl = document.getElementById("commute-loading");
  var resultsEl = document.getElementById("commute-results");
  var errorEl = document.getElementById("commute-error");

  if (loadingEl) loadingEl.style.display = "flex";
  if (resultsEl) resultsEl.style.display = "none";
  if (errorEl) errorEl.style.display = "none";

  var bodyPayload = {
    mode: mode,
    coordinates: [
      [originPlace.lng, originPlace.lat],
      [destPlace.lng, destPlace.lat]
    ],
    alternative_routes: {
      target_count: 3,
      share_factor: 0.6,
      weight_factor: 1.6
    }
  };

  fetch(ROUTE_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyPayload)
  })
    .then(function (res) {
      if (res.status === 429) throw new Error("RATE_LIMIT");
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function (geojson) {
      if (!geojson || !geojson.features || geojson.features.length === 0) {
        throw new Error("No routes returned");
      }

      var routes = geojson.features.map(function (feat, idx) {
        var coords = feat.geometry.coordinates;
        var latlngs = coords.map(function (c) { return [c[1], c[0]]; });
        var summary = feat.properties.summary || {};
        var distMeters = summary.distance || 0;
        var durSec = summary.duration || 0;
        return {
          index: idx,
          latlngs: latlngs,
          distanceKm: parseFloat((distMeters / 1000).toFixed(1)),
          durationMin: Math.round(durSec / 60),
          feature: feat
        };
      });

      routes.forEach(function (r) {
        var score = scoreRoutePollution(r.latlngs, r.durationMin, currentValidStations, mode);
        r.avgAqi = score.avgAqi;
        r.exposure = score.exposure;
        r.breathingFactor = score.breathingFactor;
      });

      var cleanest = routes.reduce(function (best, r) {
        return r.exposure < best.exposure ? r : best;
      }, routes[0]);
      var fastest = routes.reduce(function (best, r) {
        return r.durationMin < best.durationMin ? r : best;
      }, routes[0]);

      lastCommuteRouteData = { cleanest: cleanest, fastest: fastest, home: originPlace, work: destPlace, mode: mode };

      if (loadingEl) loadingEl.style.display = "none";
      showCommuteResults(cleanest, fastest, originPlace, destPlace, mode);
    })
    .catch(function (err) {
      if (loadingEl) loadingEl.style.display = "none";
      if (errorEl) {
        var msg = err.message === "RATE_LIMIT"
          ? "⏳ Too many requests. Please wait a minute and try again."
          : "❌ Could not fetch route: " + escapeHtml(err.message);
        errorEl.textContent = msg;
        errorEl.style.display = "block";
      }
    });
}

/**
 * showCommuteResults(cleanest, fastest, originPlace, destPlace, mode)
 * Renders commute comparison metrics, leave-time suggestion, and return forecast.
 */
function showCommuteResults(cleanest, fastest, originPlace, destPlace, mode) {
  var resultsEl = document.getElementById("commute-results");
  var cleanestStatsEl = document.getElementById("commute-cleanest-stats");
  var cleanestExpEl = document.getElementById("commute-cleanest-exposure");
  var fastestStatsEl = document.getElementById("commute-fastest-stats");
  var fastestExpEl = document.getElementById("commute-fastest-exposure");
  var diffEl = document.getElementById("commute-exposure-diff");

  if (!resultsEl) return;

  if (cleanestStatsEl) {
    cleanestStatsEl.textContent = cleanest.distanceKm + " km • " + cleanest.durationMin + " min • Avg AQI " + cleanest.avgAqi;
  }
  if (cleanestExpEl) {
    cleanestExpEl.textContent = "Exposure score: " + cleanest.exposure +
      (cleanest.breathingFactor !== 1 ? " (" + cleanest.breathingFactor + "× breathing)" : "");
  }

  if (fastestStatsEl) {
    fastestStatsEl.textContent = fastest.distanceKm + " km • " + fastest.durationMin + " min • Avg AQI " + fastest.avgAqi;
  }
  if (fastestExpEl) {
    fastestExpEl.textContent = "Exposure score: " + fastest.exposure;
  }

  if (diffEl) {
    if (cleanest.index !== fastest.index && fastest.exposure > 0) {
      var pctSaved = Math.round(((fastest.exposure - cleanest.exposure) / fastest.exposure) * 100);
      if (pctSaved > 0) {
        diffEl.innerHTML =
          "🛡️ Taking the <strong>Cleanest route</strong> saves ~<strong>" + pctSaved + "%</strong> less pollution exposure " +
          "vs the fastest route (" + cleanest.exposure + " vs " + fastest.exposure + " exposure units).";
        diffEl.style.display = "block";
      } else {
        diffEl.innerHTML = "💡 The fastest route is already the cleanest for this trip.";
        diffEl.style.display = "block";
      }
    } else {
      diffEl.innerHTML = "💡 Only one distinct route found — this is both the cleanest and fastest option.";
      diffEl.style.display = "block";
    }
  }

  resultsEl.style.display = "block";

  // Trigger leave-time suggestion anchored at origin
  fetchCommuteLeaveTime(originPlace.lat, originPlace.lng, cleanest);

  // Trigger evening return outlook anchored at destination
  fetchCommuteReturnForecast(destPlace, originPlace, mode);
}

/**
 * fetchCommuteLeaveTime(lat, lng, route)
 * Suggests best departure time in next 3 hours using Open-Meteo forecast.
 */
function fetchCommuteLeaveTime(lat, lng, route) {
  var box = document.getElementById("commute-leave-time");
  var textEl = document.getElementById("commute-leave-time-text");
  if (!box || !textEl) return;

  box.style.display = "block";
  textEl.textContent = "Checking air quality forecast…";

  var url = FORECAST_API_URL + "?lat=" + lat.toFixed(4) + "&lng=" + lng.toFixed(4);

  fetch(url)
    .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
    .then(function (data) {
      if (!data || !data.hourly || !data.hourly.time || !data.hourly.us_aqi) {
        box.style.display = "none";
        return;
      }

      var times = data.hourly.time;
      var aqis = data.hourly.us_aqi;
      var pm25s = data.hourly.pm2_5 || [];

      var entries = [];
      for (var i = 0; i < times.length; i++) {
        var t = new Date(times[i]).getTime();
        var val = aqis[i];
        if (val === null || val === undefined || isNaN(val)) {
          val = (pm25s[i] !== null && pm25s[i] !== undefined) ? Math.round(pm25s[i] * 2.5) : null;
        }
        if (!isNaN(t) && val !== null) entries.push({ timeMs: t, aqi: val });
      }

      if (entries.length < 2) { box.style.display = "none"; return; }

      function getForecastAqi(ms) {
        if (ms <= entries[0].timeMs) return entries[0].aqi;
        if (ms >= entries[entries.length - 1].timeMs) return entries[entries.length - 1].aqi;
        for (var j = 0; j < entries.length - 1; j++) {
          if (ms >= entries[j].timeMs && ms <= entries[j + 1].timeMs) {
            var frac = (ms - entries[j].timeMs) / (entries[j + 1].timeMs - entries[j].timeMs);
            return entries[j].aqi + frac * (entries[j + 1].aqi - entries[j].aqi);
          }
        }
        return entries[entries.length - 1].aqi;
      }

      function getTripAvg(startMs, durationMin) {
        var stepMs = 5 * 60 * 1000;
        var durMs = (durationMin || 30) * 60 * 1000;
        var sum = 0; var count = 0;
        for (var cur = startMs; cur <= startMs + durMs; cur += stepMs) {
          sum += getForecastAqi(cur); count++;
        }
        return count > 0 ? sum / count : getForecastAqi(startMs);
      }

      var nowMs = Date.now();
      var nowAvg = getTripAvg(nowMs, route.durationMin);
      var candidates = [30, 60, 90, 120, 180];
      var best = null;
      var maxReductionPct = 0;

      candidates.forEach(function (delay) {
        var startMs = nowMs + delay * 60 * 1000;
        var avg = getTripAvg(startMs, route.durationMin);
        if (nowAvg > 0) {
          var pct = Math.round(((nowAvg - avg) / nowAvg) * 100);
          if (pct > maxReductionPct) {
            maxReductionPct = pct;
            best = { delayMin: delay, startMs: startMs, pct: pct, avg: Math.round(avg) };
          }
        }
      });

      if (best && best.pct >= 15) {
        var timeStr = new Date(best.startMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        textEl.innerHTML =
          "<strong>Leave at " + timeStr + "</strong> instead of now — ~" + best.pct + "% less exposure.<br>" +
          "<span style='font-size:0.85em;color:var(--text-secondary)'>Waiting " + best.delayMin + " min for avg AQI to drop to ~" + best.avg + " on your " + route.durationMin + " min commute.</span>";
      } else {
        textEl.innerHTML =
          "<strong>Now is a good time to leave.</strong><br>" +
          "<span style='font-size:0.85em;color:var(--text-secondary)'>Air quality is forecast to stay steady or worsen over the next 3 hours.</span>";
      }
    })
    .catch(function (err) {
      console.warn("Commute forecast error:", err);
      box.style.display = "none";
    });
}

/**
 * fetchCommuteReturnForecast(destPlace, originPlace, mode)
 * Feature 1 Twist: Evening Return Commute Outlook
 */
function fetchCommuteReturnForecast(destPlace, originPlace, mode) {
  var box = document.getElementById("commute-return-forecast");
  var textEl = document.getElementById("commute-return-text");
  if (!box || !textEl) return;

  box.style.display = "block";
  textEl.textContent = "Analyzing return trip conditions…";

  var url = FORECAST_API_URL + "?lat=" + destPlace.lat.toFixed(4) + "&lng=" + destPlace.lng.toFixed(4);

  fetch(url)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || !data.hourly || !data.hourly.time || !data.hourly.us_aqi) {
        box.style.display = "none";
        return;
      }

      var times = data.hourly.time;
      var aqis = data.hourly.us_aqi;
      var now = new Date();
      var eveningEntry = null;

      for (var i = 0; i < times.length; i++) {
        var dt = new Date(times[i]);
        if (dt.getDate() === now.getDate() && dt.getHours() >= 18 && dt.getHours() <= 20) {
          eveningEntry = { dt: dt, aqi: aqis[i] };
          break;
        }
      }
      if (!eveningEntry && times.length > 8) {
        eveningEntry = { dt: new Date(times[8]), aqi: aqis[8] };
      }

      if (eveningEntry && eveningEntry.aqi) {
        var expAqi = Math.round(eveningEntry.aqi);
        var curAqi = Math.round(computeIdw(destPlace.lat, destPlace.lng, currentValidStations) || expAqi);
        var diff = expAqi - curAqi;
        var diffDesc = diff > 15
          ? "worsening by +" + diff + " points due to evening ground temperature inversion."
          : (diff < -15 ? "improving by " + Math.abs(diff) + " points." : "staying fairly steady.");

        textEl.innerHTML =
          "Expected Return AQI (6-8 PM): ~<strong>" + expAqi + "</strong> (" + diffDesc + ")<br>" +
          "<span style='font-size:0.85em;color:var(--text-secondary);'>" +
          (expAqi > 200 ? "⚠️ Air quality deteriorates after sunset. An N95 respirator is strongly advised for your return trip." : "✅ Favorable travel conditions before late-night inversion settles.") +
          "</span>";
      } else {
        box.style.display = "none";
      }
    })
    .catch(function () {
      box.style.display = "none";
    });
}

// Direction Swap Button Click Listener
var commuteSwapBtn = document.getElementById("commute-swap-btn");
if (commuteSwapBtn) {
  commuteSwapBtn.addEventListener("click", function () {
    commuteDirectionSwapped = !commuteDirectionSwapped;
    renderCommutePage();
    runCommuteRoute();
  });
}

// "Check Route Now" button
var commuteRefreshBtn = document.getElementById("commute-refresh-btn");
if (commuteRefreshBtn) {
  commuteRefreshBtn.addEventListener("click", function () {
    runCommuteRoute();
  });
}

// "View on Live Map" button
var commuteViewMapBtn = document.getElementById("commute-view-map-btn");
if (commuteViewMapBtn) {
  commuteViewMapBtn.addEventListener("click", function () {
    if (!lastCommuteRouteData) return;
    var home = lastCommuteRouteData.home;
    var work = lastCommuteRouteData.work;
    var modeSelect = document.getElementById("mode-select");
    if (modeSelect && lastCommuteRouteData.mode) modeSelect.value = lastCommuteRouteData.mode;
    switchPage("map");
    setTimeout(function () {
      setStartPoint(home.lat, home.lng, home.name);
      setDestPoint(work.lat, work.lng, work.name);
    }, 200);
  });
}

// Auto-run when mode changes
var commuteModeSelect = document.getElementById("commute-mode-select");
if (commuteModeSelect) {
  commuteModeSelect.addEventListener("change", function () {
    var resultsEl = document.getElementById("commute-results");
    if (resultsEl && resultsEl.style.display !== "none") {
      runCommuteRoute();
    }
  });
}


// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// FEATURE 9: TRIP EXPOSURE & BERKELEY EARTH CIGARETTE IMPACT
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * aqiToEstimatedPm25(aqi, scale)
 * Converts AQI reading into estimated fine particulate PM2.5 (µg/m³).
 */
function aqiToEstimatedPm25(aqi, scale) {
  var val = Number(aqi);
  if (isNaN(val) || val <= 0) return 0;
  var useScale = scale || currentAqiScale || "india";

  if (useScale === "india") {
    if (val <= 50) return (val / 50) * 30;
    if (val <= 100) return 30 + ((val - 50) / 50) * 30;
    if (val <= 200) return 60 + ((val - 100) / 100) * 30;
    if (val <= 300) return 90 + ((val - 200) / 100) * 30;
    if (val <= 400) return 120 + ((val - 300) / 100) * 130;
    return 250 + Math.min(250, ((val - 400) / 100) * 150);
  } else {
    if (val <= 50) return (val / 50) * 12.0;
    if (val <= 100) return 12.1 + ((val - 50) / 50) * (35.4 - 12.1);
    if (val <= 150) return 35.5 + ((val - 100) / 50) * (55.4 - 35.5);
    if (val <= 200) return 55.5 + ((val - 150) / 50) * (150.4 - 55.5);
    if (val <= 300) return 150.5 + ((val - 200) / 100) * (250.4 - 150.5);
    return 250.5 + Math.min(250, ((val - 300) / 200) * (500.0 - 250.5));
  }
}

/**
 * updateTripImpactCard(route)
 * Calculates cigarette equivalent using Berkeley Earth benchmark (22 µg/m³ PM2.5 over 24h ≈ 1 cigarette).
 */
function updateTripImpactCard(route) {
  var card = document.getElementById("trip-impact-card");
  if (!card) return;
  if (!route) {
    card.style.display = "none";
    return;
  }
  card.style.display = "block";

  var aqi = route.avgAqi || 100;
  var estPm25 = aqiToEstimatedPm25(aqi, currentAqiScale);
  var durMin = route.durationMin || 30;
  var breathingFactor = route.breathingFactor || 1.0;

  var cigEquivalent = (estPm25 * (durMin / 1440) * breathingFactor) / 22.0;
  var cigDisplay = cigEquivalent < 0.05 ? "< 0.1 cigs" : cigEquivalent.toFixed(2) + " cigs";

  var pm25El = document.getElementById("impact-pm25-val");
  var cigEl = document.getElementById("impact-cig-val");
  var descEl = document.getElementById("impact-desc");

  if (pm25El) pm25El.textContent = Math.round(estPm25) + " µg/m³";
  if (cigEl) cigEl.textContent = cigDisplay;
  if (descEl) {
    descEl.innerHTML =
      "On this <strong>" + durMin + " min</strong> trip at ~<strong>" + Math.round(estPm25) + " µg/m³</strong> (" +
      (breathingFactor > 1 ? breathingFactor + "× physical exertion" : "normal breathing") +
      "), your total inhaled particulate mass is roughly equivalent to smoking <strong>" + cigDisplay + "</strong>.";
  }
}


// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// FEATURE 3: POLLUTION PULSE (METEOROLOGICAL REASONING & WIND INVERSION)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

function updatePollutionPulse() {
  var card = document.getElementById("pollution-pulse-card");
  if (!card) return;

  var speedEl = document.getElementById("pulse-wind-speed");
  var dirEl = document.getElementById("pulse-wind-dir");
  var tempEl = document.getElementById("pulse-temp");
  var ventEl = document.getElementById("pulse-ventilation");
  var badgeEl = document.getElementById("pulse-badge");
  var narrativeEl = document.getElementById("pulse-narrative");

  var url = FORECAST_API_URL + "?lat=28.6139&lng=77.2090";

  fetch(url)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var cw = data.current_weather || {};
      var windSpeed = cw.wind_speed_10m !== undefined ? cw.wind_speed_10m : (cw.windspeed || 0);
      var windDir = cw.wind_direction_10m !== undefined ? cw.wind_direction_10m : (cw.winddirection || 0);
      var temp = cw.temperature_2m !== undefined ? cw.temperature_2m : (cw.temperature || 24);

      var directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
      var dirIdx = Math.round(windDir / 22.5) % 16;
      var cardinal = directions[dirIdx];

      if (speedEl) speedEl.textContent = windSpeed.toFixed(1) + " km/h";
      if (dirEl) dirEl.textContent = Math.round(windDir) + "° (" + cardinal + ")";
      if (tempEl) tempEl.textContent = temp.toFixed(1) + "°C";

      var badge = "Moderate";
      var ventStatus = "Slow Dispersion";
      var narrative = "";

      if (windSpeed < 6) {
        badge = "Stagnant (Calm)";
        ventStatus = "Trapped at Surface";
        narrative = "Surface winds are calm (< 6 km/h), causing atmospheric stagnation. Without horizontal ventilation, local emissions from vehicles, construction, and biomass remain trapped close to ground level.";
      } else if (windDir >= 270 && windDir <= 330) {
        badge = "Northwesterly Inflow";
        ventStatus = "Regional Inflow";
        narrative = "Prevailing northwesterly winds (" + windSpeed.toFixed(1) + " km/h from " + cardinal + ") transport regional smoke, stubble burning particles, and agricultural haze from Punjab and Haryana into the Delhi bowl.";
      } else if (windDir >= 80 && windDir <= 160) {
        badge = "Moist Easterly";
        ventStatus = "Humid Smog";
        narrative = "Easterly winds bring high relative humidity from the Gangetic plains, causing hygroscopic particle growth and dense secondary aerosol smog formation.";
      } else if (windSpeed >= 15) {
        badge = "Active Dispersal";
        ventStatus = "Good Dispersion";
        narrative = "Brisk winds (" + windSpeed.toFixed(1) + " km/h) are actively ventilating the boundary layer, diluting and dispersing ambient pollutants across NCR.";
      } else {
        badge = "Moderate Breeze";
        ventStatus = "Moderate";
        narrative = "Light breeze from " + cardinal + " provides moderate atmospheric mixing, preventing extreme ground-level accumulation.";
      }

      if (badgeEl) badgeEl.textContent = badge;
      if (ventEl) ventEl.textContent = ventStatus;
      if (narrativeEl) narrativeEl.textContent = narrative;
    })
    .catch(function (err) {
      console.warn("Pollution Pulse fetch error:", err);
      if (narrativeEl) narrativeEl.textContent = "Live meteorological wind dynamics unavailable.";
    });
}


// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// FEATURE 4: HEALTHY-HOME HELPER (VENTILATION & PURIFICATION GUIDE)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

function updateHealthyHomeHelper() {
  var card = document.getElementById("healthy-home-card");
  if (!card) return;

  var ventWindowEl = document.getElementById("home-vent-window");
  var purifyActionEl = document.getElementById("home-purify-action");
  var statusPill = document.getElementById("home-status-pill");

  var url = FORECAST_API_URL + "?lat=28.6139&lng=77.2090";

  fetch(url)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || !data.hourly || !data.hourly.time || !data.hourly.us_aqi) return;

      var times = data.hourly.time;
      var aqis = data.hourly.us_aqi;

      var minAqi = 9999;
      var bestHourStr = "12:00 PM – 3:00 PM";
      var count = Math.min(24, times.length);

      for (var i = 0; i < count; i++) {
        var dt = new Date(times[i]);
        var hour = dt.getHours();
        var val = aqis[i] || 300;
        if (hour >= 11 && hour <= 16) {
          if (val < minAqi) {
            minAqi = Math.round(val);
            bestHourStr = (hour % 12 || 12) + ":00 " + (hour >= 12 ? "PM" : "AM") + " – " + ((hour + 2) % 12 || 12) + ":00 " + ((hour + 2) >= 12 ? "PM" : "AM");
          }
        }
      }

      if (minAqi === 9999) minAqi = 180;

      if (minAqi < 120) {
        if (statusPill) {
          statusPill.textContent = "Safe Ventilation Window";
          statusPill.style.background = "#059669";
        }
        if (ventWindowEl) {
          ventWindowEl.innerHTML = "<strong>Best window: " + bestHourStr + "</strong> (Lowest forecast AQI ~" + minAqi + "). Brief cross-ventilation recommended to purge indoor CO2 and VOCs.";
        }
      } else {
        if (statusPill) {
          statusPill.textContent = "Keep Windows Sealed";
          statusPill.style.background = "#dc2626";
        }
        if (ventWindowEl) {
          ventWindowEl.innerHTML = "<strong>Do NOT open windows today.</strong> Outdoor AQI remains elevated (~" + minAqi + ") even during peak afternoon solar mixing.";
        }
      }

      if (purifyActionEl) {
        purifyActionEl.innerHTML = "Run HEPA air purifiers in occupied bedrooms on <strong>Medium/High</strong>. Keep internal doors closed to maintain clean air zones. Damp mop instead of dry dusting.";
      }
    })
    .catch(function (err) {
      console.warn("Healthy Home fetch error:", err);
    });
}


// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// FEATURE 2: PERSONAL SAFETY & MASK ADVISOR
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

function renderPersonalSafetyAdvisor() {
  var stationSelect = document.getElementById("advisor-station-select");
  var activitySelect = document.getElementById("advisor-activity-select");
  if (!stationSelect || !activitySelect) return;

  if (stationSelect.options.length <= 1 && currentValidStations && currentValidStations.length > 0) {
    var saved = getSavedPlaces();
    if (saved.length > 0) {
      var grpSaved = document.createElement("optgroup");
      grpSaved.label = "Saved Places";
      saved.forEach(function (p) {
        var opt = document.createElement("option");
        opt.value = "saved:" + p.name;
        opt.textContent = "📍 " + p.name;
        grpSaved.appendChild(opt);
      });
      stationSelect.appendChild(grpSaved);
    }
    var grpStations = document.createElement("optgroup");
    grpStations.label = "Monitoring Stations";
    currentValidStations.slice(0, 15).forEach(function (st) {
      var opt = document.createElement("option");
      opt.value = "station:" + st.id;
      opt.textContent = st.name + " (AQI " + st.displayAqi + ")";
      grpStations.appendChild(opt);
    });
    stationSelect.appendChild(grpStations);
  }

  var selVal = stationSelect.value;
  var currentAqi = 150;

  if (selVal.startsWith("saved:")) {
    var pName = selVal.replace("saved:", "");
    var p = getSavedPlaces().find(function (x) { return x.name === pName; });
    if (p && currentValidStations && currentValidStations.length > 0) {
      currentAqi = Math.round(computeIdw(p.lat, p.lng, currentValidStations));
    }
  } else if (selVal.startsWith("station:")) {
    var stId = selVal.replace("station:", "");
    var st = currentValidStations.find(function (x) { return String(x.id) === stId; });
    if (st) currentAqi = st.displayAqi;
  } else {
    if (map && currentValidStations && currentValidStations.length > 0) {
      var center = map.getCenter();
      currentAqi = Math.round(computeIdw(center.lat, center.lng, currentValidStations));
    }
  }

  var activity = activitySelect.value;
  var mult = 1.0;
  var actLabel = "Normal Walking";
  if (activity === "run") { mult = 2.5; actLabel = "Running / Jogging"; }
  else if (activity === "cycle") { mult = 2.2; actLabel = "Cycling"; }
  else if (activity === "school") { mult = 1.4; actLabel = "School Commute"; }
  else if (activity === "work") { mult = 2.0; actLabel = "Outdoor Work"; }

  var multEl = document.getElementById("advisor-exertion-mult");
  var multDescEl = document.getElementById("advisor-exertion-desc");
  if (multEl) multEl.textContent = mult + "× Normal";
  if (multDescEl) multDescEl.textContent = actLabel + " increases breathing minute volume from ~12 L/min to ~" + Math.round(12 * mult) + " L/min.";

  var safeTimeEl = document.getElementById("advisor-safe-time");
  var timeDescEl = document.getElementById("advisor-time-desc");
  var maskTypeEl = document.getElementById("advisor-mask-type");
  var maskReasonEl = document.getElementById("advisor-mask-reason");
  var verdictBanner = document.getElementById("advisor-verdict-banner");
  var verdictTitle = document.getElementById("advisor-verdict-title");
  var verdictSubtitle = document.getElementById("advisor-verdict-subtitle");
  var verdictIcon = document.getElementById("advisor-verdict-icon");
  var aqiPill = document.getElementById("advisor-aqi-pill");

  if (aqiPill) {
    aqiPill.textContent = "AQI " + currentAqi;
    aqiPill.style.background = getAqiColor(currentAqi, currentAqiScale);
    aqiPill.style.color = getHealthAdvice(currentAqi, currentAqiScale).textColor;
  }

  var isSensitive = (currentHealthProfile === "child" || currentHealthProfile === "asthma" || currentHealthProfile === "elderly");

  if (currentAqi <= 50) {
    if (verdictBanner) verdictBanner.className = "advisor-verdict-banner verdict-safe";
    if (verdictIcon) verdictIcon.textContent = "✅";
    if (verdictTitle) verdictTitle.textContent = "Safe for Outdoor Activity";
    if (verdictSubtitle) verdictSubtitle.textContent = "Air quality is good. Great conditions for exercise.";
    if (safeTimeEl) safeTimeEl.textContent = "Unlimited";
    if (timeDescEl) timeDescEl.textContent = "No restriction on outdoor duration.";
    if (maskTypeEl) maskTypeEl.textContent = "None Needed";
    if (maskReasonEl) maskReasonEl.textContent = "Ambient fine particulate is within safe health limits.";
  } else if (currentAqi <= 100) {
    if (isSensitive && mult > 1.2) {
      if (verdictBanner) verdictBanner.className = "advisor-verdict-banner verdict-caution";
      if (verdictIcon) verdictIcon.textContent = "⚠️";
      if (verdictTitle) verdictTitle.textContent = "Caution for Sensitive Groups";
      if (verdictSubtitle) verdictSubtitle.textContent = "Elevated particulate can trigger symptoms during high exertion.";
      if (safeTimeEl) safeTimeEl.textContent = "Max 45 - 60 mins";
      if (timeDescEl) timeDescEl.textContent = "Take rest breaks; carry rescue medication if asthmatic.";
      if (maskTypeEl) maskTypeEl.textContent = "Cloth / Surgical Optional";
      if (maskReasonEl) maskReasonEl.textContent = "Filters coarse dust and road soot.";
    } else {
      if (verdictBanner) verdictBanner.className = "advisor-verdict-banner verdict-safe";
      if (verdictIcon) verdictIcon.textContent = "✅";
      if (verdictTitle) verdictTitle.textContent = "Moderate - Generally Safe";
      if (verdictSubtitle) verdictSubtitle.textContent = "Acceptable air quality for most individuals.";
      if (safeTimeEl) safeTimeEl.textContent = "Normal Duration";
      if (timeDescEl) timeDescEl.textContent = "Standard outdoor recreation permitted.";
      if (maskTypeEl) maskTypeEl.textContent = "None Needed";
      if (maskReasonEl) maskReasonEl.textContent = "Low risk for general public.";
    }
  } else if (currentAqi <= 200) {
    if (verdictBanner) verdictBanner.className = "advisor-verdict-banner verdict-caution";
    if (verdictIcon) verdictIcon.textContent = "⚠️";
    if (verdictTitle) verdictTitle.textContent = "Unhealthy for Sensitive Groups";
    if (verdictSubtitle) verdictSubtitle.textContent = "Cut back on prolonged or heavy exertion outdoors.";
    if (safeTimeEl) safeTimeEl.textContent = (mult > 1.5 || isSensitive) ? "Max 20 - 30 mins" : "Max 45 mins";
    if (timeDescEl) timeDescEl.textContent = "High exertion drives submicron particles deep into the lungs.";
    if (maskTypeEl) maskTypeEl.textContent = "N95 / FFP2 Respirator";
    if (maskReasonEl) maskReasonEl.textContent = "Surgical and cloth masks leak PM2.5 around edges. N95 provides sealed filtration.";
  } else if (currentAqi <= 300) {
    if (verdictBanner) verdictBanner.className = "advisor-verdict-banner verdict-danger";
    if (verdictIcon) verdictIcon.textContent = "🛑";
    if (verdictTitle) verdictTitle.textContent = "Poor / Very Unhealthy";
    if (verdictSubtitle) verdictSubtitle.textContent = "Avoid outdoor workouts and prolonged exposure.";
    if (safeTimeEl) safeTimeEl.textContent = (mult > 1.5 || isSensitive) ? "0 mins (Avoid Outdoor)" : "Max 15 - 20 mins";
    if (timeDescEl) timeDescEl.textContent = "Substitute outdoor training with indoor gym or home exercises.";
    if (maskTypeEl) maskTypeEl.textContent = "N95 Respirator Mandatory";
    if (maskReasonEl) maskReasonEl.textContent = "Ambient air contains high particulate concentrations; sealed filtration is vital.";
  } else {
    if (verdictBanner) verdictBanner.className = "advisor-verdict-banner verdict-danger";
    if (verdictIcon) verdictIcon.textContent = "☣️";
    if (verdictTitle) verdictTitle.textContent = "Severe / Hazardous - Stay Indoors";
    if (verdictSubtitle) verdictSubtitle.textContent = "Public health emergency. Emergency transit only.";
    if (safeTimeEl) safeTimeEl.textContent = "0 mins (Stay Indoors)";
    if (timeDescEl) timeDescEl.textContent = "All physical activity outdoors is hazardous. Keep windows sealed.";
    if (maskTypeEl) maskTypeEl.textContent = "N95 / N99 Respirator";
    if (maskReasonEl) maskReasonEl.textContent = "Severe toxic smog causes acute respiratory inflammation.";
  }
}

// Wire Advisor Event Listeners
var advisorStationSelect = document.getElementById("advisor-station-select");
if (advisorStationSelect) {
  advisorStationSelect.addEventListener("change", renderPersonalSafetyAdvisor);
}
var advisorActivitySelect = document.getElementById("advisor-activity-select");
if (advisorActivitySelect) {
  advisorActivitySelect.addEventListener("change", renderPersonalSafetyAdvisor);
}


// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// FEATURE 5: PARENTS & SCHOOL AIR SAFETY MODE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

var schoolCurrentLang = "en";

function renderSchoolMode() {
  var stationSelect = document.getElementById("school-station-select");
  if (!stationSelect) return;

  if (stationSelect.options.length <= 1 && currentValidStations && currentValidStations.length > 0) {
    var saved = getSavedPlaces();
    if (saved.length > 0) {
      var grpSaved = document.createElement("optgroup");
      grpSaved.label = "Saved Locations";
      saved.forEach(function (p) {
        var opt = document.createElement("option");
        opt.value = "saved:" + p.name;
        opt.textContent = "📍 " + p.name;
        grpSaved.appendChild(opt);
      });
      stationSelect.appendChild(grpSaved);
    }
    var grpStations = document.createElement("optgroup");
    grpStations.label = "School Districts / Stations";
    currentValidStations.slice(0, 15).forEach(function (st) {
      var opt = document.createElement("option");
      opt.value = "station:" + st.id;
      opt.textContent = st.name;
      grpStations.appendChild(opt);
    });
    stationSelect.appendChild(grpStations);
  }

  var selVal = stationSelect.value;
  var currentAqi = 180;
  var locName = "Delhi NCR";

  if (selVal.startsWith("saved:")) {
    var pName = selVal.replace("saved:", "");
    var p = getSavedPlaces().find(function (x) { return x.name === pName; });
    if (p && currentValidStations && currentValidStations.length > 0) {
      currentAqi = Math.round(computeIdw(p.lat, p.lng, currentValidStations));
      locName = p.name;
    }
  } else if (selVal.startsWith("station:")) {
    var stId = selVal.replace("station:", "");
    var st = currentValidStations.find(function (x) { return String(x.id) === stId; });
    if (st) {
      currentAqi = st.displayAqi;
      locName = st.name;
    }
  } else {
    if (map && currentValidStations && currentValidStations.length > 0) {
      var center = map.getCenter();
      currentAqi = Math.round(computeIdw(center.lat, center.lng, currentValidStations));
      locName = "Central Delhi Area";
    }
  }

  var lightRed = document.getElementById("light-red");
  var lightAmber = document.getElementById("light-amber");
  var lightGreen = document.getElementById("light-green");
  var verdictTextEl = document.getElementById("school-verdict-text");
  var aqiPill = document.getElementById("school-aqi-pill");
  var instructionTextEl = document.getElementById("school-instruction-text");

  var verdictEn = "";
  var verdictHi = "";
  var catEn = "";
  var catHi = "";
  var instEn = "";
  var instHi = "";

  if (currentAqi <= 100) {
    if (lightGreen) lightGreen.classList.add("active");
    if (lightAmber) lightAmber.classList.remove("active");
    if (lightRed) lightRed.classList.remove("active");

    verdictEn = "OUTDOOR PLAY SAFE";
    verdictHi = "बाहरी खेल सुरक्षित है";
    catEn = "Satisfactory";
    catHi = "संतोषजनक";
    instEn = "Children can participate in outdoor morning assemblies, PE sports periods, and playground recess normally.";
    instHi = "बच्चे सामान्य रूप से सुबह की प्रार्थना सभा, खेल-कूद और मैदान में खेल सकते हैं।";
  } else if (currentAqi <= 200) {
    if (lightGreen) lightGreen.classList.remove("active");
    if (lightAmber) lightAmber.classList.add("active");
    if (lightRed) lightRed.classList.remove("active");

    verdictEn = "MODIFIED PLAY (CAUTION)";
    verdictHi = "सीमित खेल (सावधानी)";
    catEn = "Moderate / Poor";
    catHi = "मध्यम / खराब";
    instEn = "Cancel intense cardio and endurance sports. Allow light recreation with frequent water breaks. Children with asthma should remain indoors.";
    instHi = "कठिन शारीरिक खेल स्थगित करें। केवल हल्का खेल खेलें और पर्याप्त पानी पिएं। सांस या अस्थमा से पीड़ित बच्चे अंदर रहें।";
  } else {
    if (lightGreen) lightGreen.classList.remove("active");
    if (lightAmber) lightAmber.classList.remove("active");
    if (lightRed) lightRed.classList.add("active");

    verdictEn = "NO OUTDOOR PLAY";
    verdictHi = "बाहरी खेल पूरी तरह बंद";
    catEn = "Severe / Hazardous";
    catHi = "अति गंभीर / खतरनाक";
    instEn = "Cancel all outdoor assemblies, sports, and playground breaks. Keep all classroom doors and windows sealed, and run indoor air filtration where installed.";
    instHi = "सभी बाहरी सभाएं और खेल तुरंत रद्द करें। कक्षा के खिड़की-दरवाजे बंद रखें और बच्चों को पूरी तरह इनडोर रखें।";
  }

  if (verdictTextEl) verdictTextEl.textContent = verdictEn;
  if (aqiPill) {
    aqiPill.textContent = "AQI " + currentAqi + " (" + catEn + ")";
    aqiPill.style.background = getAqiColor(currentAqi, currentAqiScale);
    aqiPill.style.color = getHealthAdvice(currentAqi, currentAqiScale).textColor;
  }
  if (instructionTextEl) instructionTextEl.textContent = instEn;

  var msgEn = "🚨 Delhi AQI Sentinel - School Air Safety Alert\n" +
    "📍 Location: " + locName + "\n" +
    "💨 Air Quality: AQI " + currentAqi + " (" + catEn + ")\n" +
    "🚦 Outdoor Play: " + verdictEn + "\n" +
    "📋 Guidance: " + instEn + "\n" +
    "🌐 Check live map: " + window.location.origin;

  var msgHi = "🚨 दिल्ली AQI सेंटिनल - स्कूल वायु सुरक्षा अलर्ट\n" +
    "📍 स्थान: " + locName + "\n" +
    "💨 वायु गुणवत्ता: AQI " + currentAqi + " (" + catHi + ")\n" +
    "🚦 खेल निर्णय: " + verdictHi + "\n" +
    "📋 निर्देश: " + instHi + "\n" +
    "🌐 लाइव मैप देखें: " + window.location.origin;

  var previewEl = document.getElementById("school-message-preview");
  var waBtn = document.getElementById("btn-wa-school-share");

  var activeMsg = (schoolCurrentLang === "hi") ? msgHi : msgEn;
  if (previewEl) previewEl.value = activeMsg;
  if (waBtn) waBtn.href = "https://api.whatsapp.com/send?text=" + encodeURIComponent(activeMsg);
}

// Wire School Mode Buttons
var schoolStationSelect = document.getElementById("school-station-select");
if (schoolStationSelect) {
  schoolStationSelect.addEventListener("change", renderSchoolMode);
}

var btnLangEn = document.getElementById("btn-lang-en");
var btnLangHi = document.getElementById("btn-lang-hi");
if (btnLangEn && btnLangHi) {
  btnLangEn.addEventListener("click", function () {
    schoolCurrentLang = "en";
    btnLangEn.classList.add("active");
    btnLangHi.classList.remove("active");
    renderSchoolMode();
  });
  btnLangHi.addEventListener("click", function () {
    schoolCurrentLang = "hi";
    btnLangHi.classList.add("active");
    btnLangEn.classList.remove("active");
    renderSchoolMode();
  });
}

var btnCopySchoolMsg = document.getElementById("btn-copy-school-msg");
if (btnCopySchoolMsg) {
  btnCopySchoolMsg.addEventListener("click", function () {
    var previewEl = document.getElementById("school-message-preview");
    if (!previewEl) return;
    navigator.clipboard.writeText(previewEl.value).then(function () {
      var oldText = btnCopySchoolMsg.textContent;
      btnCopySchoolMsg.textContent = "✅ Copied!";
      setTimeout(function () {
        btnCopySchoolMsg.textContent = oldText;
      }, 2000);
    });
  });
}


// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// FEATURE 6: STATION COMPARISON & LIVE RANKINGS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

function renderStationComparison() {
  if (!currentValidStations || currentValidStations.length === 0) return;

  var s1 = document.getElementById("compare-select-1");
  var s2 = document.getElementById("compare-select-2");
  var s3 = document.getElementById("compare-select-3");
  var container = document.getElementById("compare-cards-container");
  var cleanestList = document.getElementById("rank-cleanest-list");
  var pollutedList = document.getElementById("rank-polluted-list");

  if (!s1 || !s2 || !s3 || !container) return;

  if (s1.options.length === 0) {
    [s1, s2, s3].forEach(function (sel, idx) {
      sel.innerHTML = "";
      currentValidStations.forEach(function (st) {
        var opt = document.createElement("option");
        opt.value = st.id;
        opt.textContent = st.name;
        sel.appendChild(opt);
      });
      if (currentValidStations.length > idx) {
        sel.selectedIndex = idx;
      }
    });
  }

  container.innerHTML = "";
  var selectedIds = [s1.value, s2.value, s3.value];
  selectedIds.forEach(function (stId) {
    var st = currentValidStations.find(function (x) { return String(x.id) === String(stId); });
    if (!st) return;

    var aqi = st.displayAqi;
    var advice = getHealthAdvice(aqi, currentAqiScale);
    var color = getAqiColor(aqi, currentAqiScale);

    var card = document.createElement("div");
    card.className = "compare-stat-card";
    card.innerHTML =
      '<div class="compare-card-top">' +
        '<strong class="compare-station-name">' + escapeHtml(st.name) + '</strong>' +
        '<span class="compare-aqi-pill" style="background:' + color + ';color:' + advice.textColor + ';">AQI ' + aqi + '</span>' +
      '</div>' +
      '<div class="compare-metric-row">' +
        '<span class="compare-metric-label">Category:</span>' +
        '<strong>' + escapeHtml(advice.category) + '</strong>' +
      '</div>' +
      '<div class="compare-metric-row">' +
        '<span class="compare-metric-label">PM2.5:</span>' +
        '<strong>' + (st.pm25 !== null && st.pm25 !== undefined ? st.pm25 + ' µg/m³' : '--') + '</strong>' +
      '</div>' +
      '<div class="compare-metric-row">' +
        '<span class="compare-metric-label">PM10:</span>' +
        '<strong>' + (st.pm10 !== null && st.pm10 !== undefined ? st.pm10 + ' µg/m³' : '--') + '</strong>' +
      '</div>' +
      '<div class="compare-metric-row">' +
        '<span class="compare-metric-label">Primary Pollutant:</span>' +
        '<strong>' + (st.dominantPollutant ? st.dominantPollutant.toUpperCase() : 'PM2.5') + '</strong>' +
      '</div>' +
      '<p class="compare-card-advice">' + escapeHtml(advice.general) + '</p>';

    container.appendChild(card);
  });

  var sortedStations = currentValidStations.slice().sort(function (a, b) {
    return a.displayAqi - b.displayAqi;
  });

  if (cleanestList) {
    cleanestList.innerHTML = "";
    sortedStations.slice(0, 5).forEach(function (st, idx) {
      var li = document.createElement("li");
      li.className = "rank-item";
      li.innerHTML =
        '<span class="rank-num">#' + (idx + 1) + '</span>' +
        '<span class="rank-name">' + escapeHtml(st.name) + '</span>' +
        '<span class="rank-aqi" style="background:' + getAqiColor(st.displayAqi, currentAqiScale) + ';color:' + getHealthAdvice(st.displayAqi, currentAqiScale).textColor + ';">AQI ' + st.displayAqi + '</span>';
      cleanestList.appendChild(li);
    });
  }

  if (pollutedList) {
    pollutedList.innerHTML = "";
    sortedStations.slice(-5).reverse().forEach(function (st, idx) {
      var li = document.createElement("li");
      li.className = "rank-item";
      li.innerHTML =
        '<span class="rank-num">#' + (idx + 1) + '</span>' +
        '<span class="rank-name">' + escapeHtml(st.name) + '</span>' +
        '<span class="rank-aqi" style="background:' + getAqiColor(st.displayAqi, currentAqiScale) + ';color:' + getHealthAdvice(st.displayAqi, currentAqiScale).textColor + ';">AQI ' + st.displayAqi + '</span>';
      pollutedList.appendChild(li);
    });
  }
}

// Wire Comparison Dropdowns
["compare-select-1", "compare-select-2", "compare-select-3"].forEach(function (id) {
  var sel = document.getElementById(id);
  if (sel) sel.addEventListener("change", renderStationComparison);
});


// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// FEATURE 7: IN-TAB BROWSER AQI ALERTS (WITHOUT A SERVER)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

function initAqiAlerts() {
  var btn = document.getElementById("btn-toggle-alerts");
  var desc = document.getElementById("alerts-status-desc");
  if (!btn) return;

  function updateBtn() {
    if (!("Notification" in window)) {
      btn.textContent = "Not Supported";
      btn.disabled = true;
      if (desc) desc.textContent = "Browser notifications are not supported in this environment.";
      return;
    }
    if (Notification.permission === "granted") {
      var enabled = localStorage.getItem("delhi_aqi_alerts_enabled") === "true";
      btn.textContent = enabled ? "🔔 Alerts Active" : "Enable Alerts";
      btn.className = enabled ? "btn-sm btn-primary" : "btn-sm";
      if (desc) {
        desc.textContent = enabled
          ? "✅ Active. You will receive a browser notification if a saved place crosses your " + currentHealthProfile + " threshold while this tab is open."
          : "Click to turn on in-tab alerts for your saved places.";
      }
    } else if (Notification.permission === "denied") {
      btn.textContent = "Blocked";
      btn.disabled = true;
      if (desc) desc.textContent = "Notifications are blocked in your browser settings.";
    } else {
      btn.textContent = "Enable Alerts";
    }
  }

  btn.addEventListener("click", function () {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      var enabled = localStorage.getItem("delhi_aqi_alerts_enabled") === "true";
      localStorage.setItem("delhi_aqi_alerts_enabled", (!enabled).toString());
      updateBtn();
      if (!enabled) checkSavedPlacesAlerts();
    } else {
      Notification.requestPermission().then(function (permission) {
        if (permission === "granted") {
          localStorage.setItem("delhi_aqi_alerts_enabled", "true");
          updateBtn();
          checkSavedPlacesAlerts();
        } else {
          updateBtn();
        }
      });
    }
  });

  updateBtn();
}

function checkSavedPlacesAlerts() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (localStorage.getItem("delhi_aqi_alerts_enabled") !== "true") return;
  if (!currentValidStations || currentValidStations.length === 0) return;

  var places = getSavedPlaces();
  if (places.length === 0) return;

  var profile = HEALTH_PROFILES[currentHealthProfile] || HEALTH_PROFILES.adult;
  var threshold = profile.threshold;
  var now = Date.now();
  var COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between alerts per place

  places.forEach(function (p) {
    var aqi = Math.round(computeIdw(p.lat, p.lng, currentValidStations));
    if (aqi > threshold) {
      var key = "delhi_aqi_alert_last_" + p.name;
      var lastAlertTime = parseInt(localStorage.getItem(key) || "0", 10);
      if (now - lastAlertTime > COOLDOWN_MS) {
        localStorage.setItem(key, now.toString());
        var nTitle = "🚨 Delhi AQI Alert: " + p.name;
        var nBody = p.name + " AQI reached " + aqi + " (" + getAqiCategory(aqi, currentAqiScale) + "), crossing your " + profile.label + " threshold of " + threshold + ". Take precautions!";
        try {
          new Notification(nTitle, {
            body: nBody,
            icon: "/icons/icon-192.png",
            tag: "aqi-alert-" + p.name
          });
        } catch (e) {
          console.warn("Could not dispatch notification:", e);
        }
      }
    }
  });
}

// Initialize Browser Alerts
initAqiAlerts();


// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// FEATURE 8: PWA SERVICE WORKER REGISTRATION & INSTALL PROMPT
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker
      .register("/sw.js")
      .then(function (registration) {
        console.log("[PWA] Service Worker active with scope:", registration.scope);
      })
      .catch(function (error) {
        console.warn("[PWA] Service Worker registration failed:", error);
      });
  });
}

var deferredInstallPrompt = null;
var pwaInstallBtn = document.getElementById("pwa-install-btn");

window.addEventListener("beforeinstallprompt", function (event) {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (pwaInstallBtn) {
    pwaInstallBtn.style.display = "inline-flex";
  }
  console.log("[PWA] Install prompt captured and ready.");
});

if (pwaInstallBtn) {
  pwaInstallBtn.addEventListener("click", function () {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then(function (choiceResult) {
        if (choiceResult.outcome === "accepted") {
          console.log("[PWA] User accepted installation prompt.");
        } else {
          console.log("[PWA] User dismissed installation prompt.");
        }
        deferredInstallPrompt = null;
        pwaInstallBtn.style.display = "none";
      });
    }
  });
}

window.addEventListener("appinstalled", function () {
  console.log("[PWA] Delhi AQI Sentinel was successfully installed.");
  if (pwaInstallBtn) pwaInstallBtn.style.display = "none";
});

// Initial Router Bootstrap
switchPage(window.location.hash || "map");
