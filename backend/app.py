import logging
import os
from pathlib import Path
import sqlite3
import time
from collections import defaultdict
from typing import List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import requests

logger = logging.getLogger("uvicorn.error")

# Load secrets from backend/.env
load_dotenv()

WAQI_TOKEN = os.getenv("WAQI_TOKEN", "")
ORS_KEY = os.getenv("ORS_KEY", "")
OPENAQ_KEY = os.getenv("OPENAQ_KEY", "")

# SQLite history database path
DB_PATH = Path(__file__).resolve().parent / "aqi_history.db"

def init_history_db():
    """Initializes the SQLite history database safely without crashing on permission errors."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS readings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    station_id TEXT,
                    name TEXT,
                    lat REAL,
                    lon REAL,
                    pm25 REAL,
                    pm10 REAL,
                    aqi REAL,
                    timestamp_utc TEXT
                )
            """)
            conn.commit()
    except Exception as e:
        logger.warning(f"Could not initialize SQLite database ({DB_PATH}): {e}. Continuing without crash.")

# Initialize table on module load safely
init_history_db()

def safe_record_history(stations: list):
    """Safely saves station readings into SQLite history. If file cannot be written, logs and carries on."""
    if not stations:
        return
    try:
        now_ts = int(time.time())
        now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ts))
        ten_mins_ago_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ts - 600))

        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            for s in stations:
                st_id = str(s.get("uid", ""))
                st_name = s.get("station", {}).get("name", "") if isinstance(s.get("station"), dict) else str(s.get("name", ""))
                lat = s.get("lat")
                lon = s.get("lon")
                aqi = s.get("aqi")

                # Avoid duplicate rows for the same station within 10 minutes
                cursor.execute(
                    "SELECT id FROM readings WHERE station_id = ? AND timestamp_utc >= ? LIMIT 1",
                    (st_id, ten_mins_ago_iso)
                )
                if not cursor.fetchone():
                    cursor.execute(
                        "INSERT INTO readings (station_id, name, lat, lon, pm25, pm10, aqi, timestamp_utc) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (st_id, st_name, lat, lon, None, None, aqi, now_iso)
                    )
            conn.commit()
    except Exception as e:
        logger.warning(f"Could not write to SQLite history file ({DB_PATH}): {e}. Carrying on gracefully.")

# Delhi NCR geographic bounding box
DELHI_BOUNDS = {
    "min_lat": 28.20,
    "max_lat": 29.00,
    "min_lon": 76.70,
    "max_lon": 77.60
}

def is_within_delhi_ncr(lat: float, lon: float) -> bool:
    """Validate that coordinates lie strictly within the Delhi NCR bounding box."""
    return (
        DELHI_BOUNDS["min_lat"] <= lat <= DELHI_BOUNDS["max_lat"] and
        DELHI_BOUNDS["min_lon"] <= lon <= DELHI_BOUNDS["max_lon"]
    )

app = FastAPI(
    title="Delhi AQI Public Secure API",
    description="Hardened API proxy service with caching, input validation, and rate limiting",
    version="3.0.0"
)

# ─────────────────────────────────────────────────────────────────────────────
# 1. CORS CONFIGURATION (Restricted to ALLOWED_ORIGINS from .env)
# ─────────────────────────────────────────────────────────────────────────────
allowed_origins_raw = os.getenv("ALLOWED_ORIGINS", "http://127.0.0.1:5500,http://localhost:5500")
allowed_origins = [origin.strip() for origin in allowed_origins_raw.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# 2. RATE LIMITER (30 requests / minute per IP)
# ─────────────────────────────────────────────────────────────────────────────
class SlidingWindowRateLimiter:
    def __init__(self, max_requests: int = 30, window_seconds: float = 60.0):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.ip_timestamps = defaultdict(list)

    def is_allowed(self, client_ip: str) -> bool:
        now = time.time()
        # Discard records outside the 60-second sliding window
        self.ip_timestamps[client_ip] = [
            t for t in self.ip_timestamps[client_ip]
            if (now - t) < self.window_seconds
        ]
        if len(self.ip_timestamps[client_ip]) < self.max_requests:
            self.ip_timestamps[client_ip].append(now)
            return True
        return False

    def get_retry_after(self, client_ip: str) -> int:
        now = time.time()
        if self.ip_timestamps[client_ip]:
            oldest = min(self.ip_timestamps[client_ip])
            return max(1, int(self.window_seconds - (now - oldest)))
        return 60


rate_limiter = SlidingWindowRateLimiter(max_requests=30, window_seconds=60.0)


# ─────────────────────────────────────────────────────────────────────────────
# 3. SECURITY HEADERS & RATE LIMIT MIDDLEWARE
# ─────────────────────────────────────────────────────────────────────────────
@app.middleware("http")
async def security_and_rate_limit_middleware(request: Request, call_next):
    # Apply rate limiting to all /api/ endpoints
    if request.url.path.startswith("/api/"):
        forwarded = request.headers.get("x-forwarded-for")
        client_ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "127.0.0.1")

        if not rate_limiter.is_allowed(client_ip):
            retry_after = rate_limiter.get_retry_after(client_ip)
            return JSONResponse(
                status_code=429,
                content={
                    "error": "Too Many Requests. Rate limit of 30 requests per minute exceeded. Please try again in a minute.",
                    "status_code": 429,
                    "retry_after_seconds": retry_after
                },
                headers={"Retry-After": str(retry_after)}
            )

    response = await call_next(request)

    # Attach required security headers
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://unpkg.com; "
        "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com; "
        "connect-src 'self' http://localhost:8000 http://127.0.0.1:8000 https://aqi-app.onrender.com https://*.onrender.com; "
        "font-src 'self'; "
        "frame-ancestors 'none';"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

    return response


# ─────────────────────────────────────────────────────────────────────────────
# 4. SERVER-SIDE IN-MEMORY CACHES (10 Minutes)
# ─────────────────────────────────────────────────────────────────────────────
CACHE_DURATION_SECONDS = 600.0  # 10 minutes

STATIONS_CACHE = {
    "data": None,
    "timestamp": 0.0
}

FORECAST_CACHE = {}  # key: (round(lat, 2), round(lng, 2)) -> (timestamp, data)


# ─────────────────────────────────────────────────────────────────────────────
# 5. ENDPOINT: GET /api/stations
# Proxies WAQI station data with 10-minute cache and OpenAQ fallback
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/stations")
def get_stations(bounds: Optional[str] = "28.40,76.84,28.88,77.35"):
    now = time.time()

    # 1. Return cached stations if fresh
    if STATIONS_CACHE["data"] and (now - STATIONS_CACHE["timestamp"] < CACHE_DURATION_SECONDS):
        return JSONResponse(
            content=STATIONS_CACHE["data"],
            headers={
                "X-Cache": "HIT",
                "X-Cache-Age-Seconds": str(int(now - STATIONS_CACHE["timestamp"]))
            }
        )

    # 2. Fetch from WAQI
    if not WAQI_TOKEN:
        raise HTTPException(
            status_code=500,
            detail="WAQI_TOKEN not configured in backend/.env"
        )

    waqi_url = f"https://api.waqi.info/map/bounds/?latlng={bounds}&token={WAQI_TOKEN}"

    try:
        resp = requests.get(waqi_url, timeout=12)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("status") == "ok" and len(data.get("data", [])) >= 5:
                STATIONS_CACHE["data"] = data
                STATIONS_CACHE["timestamp"] = now
                safe_record_history(data.get("data", []))
                return JSONResponse(content=data, headers={"X-Cache": "MISS"})

        # Fallback to OpenAQ if WAQI returned insufficient data and OPENAQ_KEY exists
        if OPENAQ_KEY:
            openaq_url = (
                f"https://api.openaq.org/v3/locations?"
                f"bbox={DELHI_BOUNDS['min_lon']},{DELHI_BOUNDS['min_lat']},"
                f"{DELHI_BOUNDS['max_lon']},{DELHI_BOUNDS['max_lat']}&limit=100"
            )
            openaq_resp = requests.get(
                openaq_url,
                headers={"X-API-Key": OPENAQ_KEY},
                timeout=10
            )
            if openaq_resp.status_code == 200:
                openaq_json = openaq_resp.json()
                results = openaq_json.get("results", [])
                converted = []
                for loc in results:
                    coords = loc.get("coordinates")
                    if coords:
                        converted.append({
                            "lat": coords.get("latitude"),
                            "lon": coords.get("longitude"),
                            "uid": loc.get("id"),
                            "aqi": "150",
                            "station": {
                                "name": loc.get("name", "OpenAQ Station"),
                                "time": loc.get("datetimeLast", {}).get("utc") if loc.get("datetimeLast") else None
                            }
                        })
                if converted:
                    fallback_data = {"status": "ok", "data": converted, "source": "openaq"}
                    STATIONS_CACHE["data"] = fallback_data
                    STATIONS_CACHE["timestamp"] = now
                    safe_record_history(converted)
                    return JSONResponse(content=fallback_data, headers={"X-Cache": "FALLBACK_OPENAQ"})

        # If WAQI returned an error but we have stale cache, serve stale cache
        if STATIONS_CACHE["data"]:
            return JSONResponse(content=STATIONS_CACHE["data"], headers={"X-Cache": "STALE"})

        raise HTTPException(status_code=resp.status_code, detail="Failed to fetch stations from upstream API.")

    except requests.RequestException as e:
        if STATIONS_CACHE["data"]:
            return JSONResponse(content=STATIONS_CACHE["data"], headers={"X-Cache": "STALE_ON_ERROR"})
        raise HTTPException(status_code=502, detail=f"Failed to connect to station provider: {str(e)}")


# ─────────────────────────────────────────────────────────────────────────────
# 6. ENDPOINT: GET /api/search (and /api/geocode alias)
# Input Validation: Search query max 100 chars, coords within Delhi NCR bounds
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/search")
@app.get("/api/geocode")
def search_places(q: str, lat: float = 28.6139, lon: float = 77.2090):
    query = (q or "").strip()

    # Input validation: query non-empty and max 100 characters
    if not query:
        raise HTTPException(status_code=400, detail="Search query 'q' cannot be empty.")
    if len(query) > 100:
        raise HTTPException(status_code=400, detail="Search query 'q' exceeds maximum length of 100 characters.")

    # Input validation: coordinates must lie within Delhi NCR bounds
    if not is_within_delhi_ncr(lat, lon):
        raise HTTPException(
            status_code=400,
            detail="Coordinates must lie within Delhi NCR bounds (lat 28.20 to 29.00, lon 76.70 to 77.60)."
        )

    ors_features = []
    if ORS_KEY:
        try:
            ors_url = (
                f"https://api.openrouteservice.org/geocode/autocomplete"
                f"?api_key={ORS_KEY}&text={requests.utils.quote(query)}"
                f"&focus.point.lat={lat:.4f}&focus.point.lon={lon:.4f}"
                f"&boundary.rect.min_lon={DELHI_BOUNDS['min_lon']}&boundary.rect.max_lon={DELHI_BOUNDS['max_lon']}"
                f"&boundary.rect.min_lat={DELHI_BOUNDS['min_lat']}&boundary.rect.max_lat={DELHI_BOUNDS['max_lat']}"
                f"&size=8"
            )
            r = requests.get(ors_url, timeout=6)
            if r.status_code == 200:
                ors_features = r.json().get("features", [])
        except Exception:
            pass

    photon_features = []
    try:
        photon_url = (
            f"https://photon.komoot.io/api/?q={requests.utils.quote(query)}"
            f"&limit=8&lat=28.61&lon=77.21"
            f"&bbox={DELHI_BOUNDS['min_lon']},{DELHI_BOUNDS['min_lat']},{DELHI_BOUNDS['max_lon']},{DELHI_BOUNDS['max_lat']}"
        )
        pr = requests.get(photon_url, timeout=6)
        if pr.status_code == 200:
            photon_features = pr.json().get("features", [])
    except Exception:
        pass

    return {
        "ors_features": ors_features,
        "photon_features": photon_features
    }


# ─────────────────────────────────────────────────────────────────────────────
# 7. ENDPOINT: POST /api/route
# Input Validation: mode must be driving/walking/cycling, coords inside NCR bounds
# ─────────────────────────────────────────────────────────────────────────────
ALLOWED_MODES = {
    "driving-car": "driving-car",
    "foot-walking": "foot-walking",
    "cycling-regular": "cycling-regular",
    "driving": "driving-car",
    "walking": "foot-walking",
    "cycling": "cycling-regular"
}

@app.api_route("/api/route", methods=["GET", "POST"])
async def get_route(
    request: Request,
    start_lat: Optional[float] = None,
    start_lng: Optional[float] = None,
    end_lat: Optional[float] = None,
    end_lng: Optional[float] = None,
    mode: Optional[str] = "driving-car",
    alternatives: Optional[bool] = True
):
    if not ORS_KEY:
        raise HTTPException(
            status_code=500,
            detail="ORS_KEY not configured in backend/.env"
        )

    # 1. Parse payload from POST body or GET query params
    if request.method == "POST":
        try:
            payload = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid JSON body.")
    else:
        if start_lat is None or start_lng is None or end_lat is None or end_lng is None:
            raise HTTPException(
                status_code=400,
                detail="Missing query params for GET /api/route. Required: start_lat, start_lng, end_lat, end_lng."
            )
        payload = {
            "mode": mode,
            "coordinates": [[start_lng, start_lat], [end_lng, end_lat]]
        }
        if alternatives:
            payload["alternative_routes"] = {
                "target_count": 3,
                "share_factor": 0.6,
                "weight_factor": 1.6
            }

    # 2. Validate transport mode
    raw_mode = payload.get("mode", "driving-car")
    if raw_mode not in ALLOWED_MODES:
        raise HTTPException(
            status_code=400,
            detail="Invalid mode. Must be one of: driving-car, foot-walking, cycling-regular (or driving, walking, cycling)."
        )
    clean_mode = ALLOWED_MODES[raw_mode]

    # 3. Validate coordinates payload
    coordinates = payload.get("coordinates")
    if not coordinates or not isinstance(coordinates, list) or len(coordinates) < 2:
        raise HTTPException(
            status_code=400,
            detail="Invalid coordinates. Expected at least 2 coordinate points: [[lon, lat], [lon, lat]]."
        )

    # 4. Validate every coordinate is strictly within Delhi NCR bounds
    for pt in coordinates:
        if not isinstance(pt, (list, tuple)) or len(pt) < 2:
            raise HTTPException(status_code=400, detail="Invalid coordinate pair. Expected [lon, lat].")
        try:
            pt_lon = float(pt[0])
            pt_lat = float(pt[1])
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="Coordinates must be valid numerical values.")

        if not is_within_delhi_ncr(pt_lat, pt_lon):
            raise HTTPException(
                status_code=400,
                detail=f"Coordinate point ({pt_lat}, {pt_lon}) lies outside Delhi NCR bounds (lat 28.20 to 29.00, lon 76.70 to 77.60)."
            )

    url = f"https://api.openrouteservice.org/v2/directions/{clean_mode}/geojson"
    headers = {
        "Authorization": ORS_KEY,
        "Content-Type": "application/json"
    }

    ors_body = {"coordinates": coordinates}
    if "alternative_routes" in payload:
        ors_body["alternative_routes"] = payload["alternative_routes"]

    try:
        resp = requests.post(url, json=ors_body, headers=headers, timeout=15)

        # Graceful fallback to single route if alternatives fail (e.g. walking/cycling in areas with no alternatives)
        if resp.status_code == 400 and "alternative_routes" in ors_body:
            single_body = {"coordinates": coordinates}
            resp = requests.post(url, json=single_body, headers=headers, timeout=15)

        if resp.status_code != 200:
            error_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {"message": resp.text}
            return JSONResponse(status_code=resp.status_code, content=error_data)

        return resp.json()

    except requests.RequestException as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to communicate with OpenRouteService: {str(e)}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 8. ENDPOINT: GET /api/forecast
# Input Validation: Coordinates must lie within Delhi NCR bounds. 10-min cache.
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/forecast")
def get_forecast(lat: float = 28.6139, lng: float = 77.2090):
    # Input validation: coordinates within Delhi NCR bounds
    if not is_within_delhi_ncr(lat, lng):
        raise HTTPException(
            status_code=400,
            detail="Coordinates must lie within Delhi NCR bounds (lat 28.20 to 29.00, lon 76.70 to 77.60)."
        )

    cache_key = (round(lat, 2), round(lng, 2))
    now = time.time()

    # 10-minute cache per coordinate
    if cache_key in FORECAST_CACHE:
        cached_time, cached_data = FORECAST_CACHE[cache_key]
        if now - cached_time < CACHE_DURATION_SECONDS:
            return JSONResponse(content=cached_data, headers={"X-Cache": "HIT"})

    # 1. Fetch Air Quality (PM2.5, PM10, US AQI)
    aq_url = (
        f"https://air-quality-api.open-meteo.com/v1/air-quality"
        f"?latitude={lat:.4f}&longitude={lng:.4f}"
        f"&hourly=us_aqi,pm2_5,pm10&timezone=auto&forecast_days=2"
    )

    # 2. Fetch Surface Meteorology (Wind Speed, Direction, Temperature, Humidity)
    # Essential for Feature 3 (Pollution Pulse) & Feature 4 (Healthy Home Helper)
    weather_url = (
        f"https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat:.4f}&longitude={lng:.4f}"
        f"&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m"
        f"&hourly=temperature_2m,wind_speed_10m,wind_direction_10m"
        f"&timezone=auto&forecast_days=2"
    )

    try:
        resp = requests.get(aq_url, timeout=10)
        if resp.status_code != 200:
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Open-Meteo returned HTTP {resp.status_code}"
            )

        data = resp.json()

        # Gracefully enrich with meteorological data if available
        try:
            w_resp = requests.get(weather_url, timeout=6)
            if w_resp.status_code == 200:
                w_data = w_resp.json()
                data["current_weather"] = w_data.get("current", {})
                data["hourly_weather"] = w_data.get("hourly", {})
        except Exception as w_err:
            print(f"[Forecast] Optional weather enrichment skipped: {w_err}")
            data["current_weather"] = {}
            data["hourly_weather"] = {}

        FORECAST_CACHE[cache_key] = (now, data)
        return JSONResponse(content=data, headers={"X-Cache": "MISS"})

    except requests.RequestException as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to reach Open-Meteo forecast API: {str(e)}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 9. API HEALTH & HISTORY COUNT ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────
@app.get("/api/health")
def api_health():
    return {
        "status": "ok",
        "service": "Delhi AQI Public Secure API",
        "rate_limit": "30 requests/minute per IP",
        "cache_duration_minutes": 10
    }

@app.get("/api/history/count")
def get_history_count():
    """Returns how many station readings are stored in SQLite history; fails gracefully if db unavailable."""
    try:
        if not DB_PATH.exists():
            return {"count": 0}
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT count(*) FROM readings")
            row = cursor.fetchone()
            return {"count": row[0] if row else 0}
    except Exception as e:
        logger.warning(f"Could not read SQLite history count: {e}")
        return {"count": 0, "status": "unavailable", "message": "Database write/read unavailable"}


# ─────────────────────────────────────────────────────────────────────────────
# 10. STATIC FRONTEND SERVING
# ─────────────────────────────────────────────────────────────────────────────
# Serve frontend/ as static files at "/" with html=True so index.html is served automatically.
# Mounted AFTER all /api routes so API endpoints take priority.
# Only the frontend/ folder is public: backend/, .env, .db, .git are never exposed.
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

if FRONTEND_DIR.exists() and FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    logger.warning(f"Frontend directory not found at {FRONTEND_DIR}. Only API endpoints available.")


# ─────────────────────────────────────────────────────────────────────────────
# 11. MAIN ENTRYPOINT (Reads PORT from environment)
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    # Read PORT from environment variable (Render, Railway, Heroku default injection)
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
