# Delhi AQI Sentinel

A live air-quality map and least-polluted route navigation system for Delhi NCR, built as a unified web service serving both the frontend and backend.

## What it does
- Shows real-time AQI from monitoring stations across Delhi NCR with CPCB India NAQI & US EPA standard toggles.
- Estimates continuous AQI across the city using an Inverse Distance Weighted (IDW) color map layer.
- **One-Tap Commute Planner**: Saves Home and Work locations to instantly calculate cleanest vs. fastest travel options, exposure reduction %, and forecasted departure windows.
- **Installable Mobile PWA**: Web App Manifest, Service Worker (`sw.js`), and offline stale-data guard that displays last-cached sensor data with an honest data-age label when disconnected.
- Calculates routes (Driving, Walking, Cycling) and scores each by cumulative pollution exposure with physiological exertion breathing multipliers ($2.5\times$ Walking, $2.2\times$ Cycling, $1.0\times$ Driving).
- Highlights the cleanest route and provides tailored health advice based on user profile.
- Suggests optimal departure times based on 24-hour forecasted pollution trends.

## Known Limitations
1. **Free Upstream Quotas**: World Air Quality Index (WAQI) and OpenRouteService (ORS) operate on free community tiers. Responses are cached for 10 minutes on the FastAPI server to prevent quota exhaustion.
2. **Missing PM Sensors**: Some ambient stations report aggregate AQI without raw continuous PM2.5 or PM10 telemetry. In India NAQI mode, these stations automatically fall back to the US scale and are labeled with `(US scale fallback)`.
3. **PWA Background Alerts**: On iOS and certain mobile browsers, background alerts require the user to install the app to their home screen; in-browser notifications fire while the browser tab remains active.
4. **Spatial Boundary**: All coordinate queries and routes are restricted strictly to the Delhi NCR bounding box (Latitude 28.20–29.00°N, Longitude 76.70–77.60°E). Outside points are rejected with a 400 Bad Request.

## How to Run Locally (Single Web Service)

1. Make sure Python 3.9+ is installed.
2. In the `backend` folder, copy `.env.example` to `.env` and configure your API keys:
   ```bash
   cp backend/.env.example backend/.env
   ```
3. Install dependencies:
   ```bash
   cd backend
   pip install -r requirements.txt
   ```
4. Run the server:
   ```bash
   uvicorn app:app --reload --port 8000
   ```
5. Open your browser and visit:
   ```
   http://localhost:8000
   ```
   The backend serves the frontend directly at `http://localhost:8000` and routes all API calls to `/api/...`.

*(Optional: If developing the frontend with VS Code Live Server on port 5500, `API_BASE` will automatically proxy requests to `http://localhost:8000`).*

## Production Deployment (e.g. Render, Railway, Heroku)

The project runs as **ONE unified service**:
- **Build command:** `pip install -r backend/requirements.txt`
- **Start command:** `uvicorn app:app --host 0.0.0.0 --port $PORT` (from `backend/` folder)
- Set environment variables (`WAQI_TOKEN`, `ORS_KEY`, `ALLOWED_ORIGINS`) in your cloud provider's dashboard.
- The server reads the host-assigned `$PORT` automatically and securely serves the static files from `frontend/`.

## Data Sources
- **WAQI (aqicn.org)**: World Air Quality Index
- **Open-Meteo**: Hourly air quality forecasts
- **OpenRouteService & Photon**: Geocoding and route directions
- **OpenStreetMap**: Map tiles & geometries

*Note: Air quality values and route exposure scores are estimates and not an official government source.*
