# Delhi AQI Sentinel

A live air-quality map and least-polluted route navigation system for Delhi NCR, built as a unified web service serving both the frontend and backend.

## What it does
- Shows real-time AQI from monitoring stations across Delhi NCR
- Estimates continuous AQI across the city using an Inverse Distance Weighted (IDW) color map layer
- Calculates routes (Driving, Walking, Cycling) and scores each by cumulative pollution exposure
- Highlights the cleanest route and provides tailored health advice based on user profile
- Suggests optimal departure times based on 24-hour forecasted pollution trends

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
