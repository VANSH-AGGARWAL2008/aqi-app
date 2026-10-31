# Delhi AQI Sentinel

A live air-quality map and least-polluted route navigation system for Delhi NCR, built as a unified web service serving both the frontend and backend.

## What it does
Delhi AQI Sentinel is designed for everyday Delhi commuters, parents, joggers, elderly residents, and schools. It delivers 9 specialized feature modules:

1. **One-Tap Commute Planner**: Saves Home and Work once with instant cleanest vs. fastest travel comparison, exposure reduction %, optimal departure window in the next 3 hours, smart direction swap (Home ↔ Work), and an evening return trip outlook.
2. **Personal Safety & Mask Advisor**: Activity-specific outdoor time limits (walking, running, cycling, school commute, manual labor), mask recommendations (None / Surgical / N95 Respirator with medical reasons), and inhaled minute-volume exertion multipliers.
3. **Pollution Pulse & Atmospheric Dynamics**: Meteorological wind speed, wind direction, and temperature reasoning using Open-Meteo to explain ground-level trapping, temperature inversion, or regional stubble burning smoke inflow in plain language.
4. **Healthy-Home & Ventilation Guide**: Evaluates the 24-hour diurnal air quality curve to identify the best afternoon solar window to open windows for ventilation vs. when to keep rooms sealed and run HEPA air cleaners.
5. **Parents & School Air Safety Mode**: Instant green/amber/red traffic-light indicator for outdoor play, morning assemblies, and recess, with bilingual English and Hindi preformatted WhatsApp share messages for class and parent groups.
6. **Station Comparison & Live Rankings**: Side-by-side comparison of up to 3 monitoring areas (PM2.5, PM10, primary pollutant, health advice), plus live Top 5 cleanest vs. Top 5 most polluted stations across NCR.
7. **In-Tab Browser Alerts (Without a Server)**: Zero-backend notification system that triggers browser alerts if any saved place crosses your active profile's threshold while the web page remains open.
8. **Installable Mobile App (PWA)**: Web App Manifest, Service Worker (`sw.js`), and offline stale-data guard that displays last-cached sensor data with an honest data-age label when disconnected.
9. **Trip Exposure & Cigarette Inhalation Benchmark**: Translates fine particulate PM2.5 inhalation on any selected route into an educational cigarette-equivalent benchmark based on the Berkeley Earth rule of thumb (22 µg/m³ of PM2.5 over 24 hours ≈ 1 cigarette), with transparent scientific disclaimers.

Additionally includes:
- CPCB India NAQI & US EPA AQI standard switch with authentic color palettes and health categories.
- Continuous IDW interpolation layer across the entire Delhi NCR basin.
- Dark mode and light mode with accessible high-contrast form controls.
- Responsive layout supporting small 360px mobile screens up to widescreen desktop displays.

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
