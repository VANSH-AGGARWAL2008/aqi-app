# Delhi AQI App - Python Backend Proxy

FastAPI backend service that proxies external API calls (WAQI, OpenRouteService, Open-Meteo) for the Delhi AQI web app. All API keys reside exclusively on this server, protecting sensitive credentials and enforcing caching and rate-limiting.

---

## Features

1. **Proxy Endpoints**:
   - `GET /api/stations?bounds=...`: Proxies WAQI station data in the Delhi NCR bounding box.
   - `POST /api/route`: Proxies OpenRouteService directions (driving, walking, cycling) with coordinates & alternatives. Automatically falls back to single-route if alternatives aren't supported.
   - `GET /api/forecast?lat=...&lng=...`: Proxies Open-Meteo hourly air quality forecast.
   - `GET /api/geocode?q=...&lat=...&lon=...`: Proxies OpenRouteService autocomplete and Photon geocoding for destination search.
   - `GET /`: Health check and cache status.

2. **10-Minute Server-Side Cache**:
   - WAQI station data is cached in-memory for 10 minutes (`600s`).
   - Multiple frontend visitors or page refreshes within 10 minutes receive cached data instantly (`X-Cache: HIT`), eliminating redundant upstream API calls.
   - Open-Meteo forecasts are similarly cached per coordinate for 10 minutes.

3. **Per-IP Rate Limiting (Token Bucket)**:
   - Limits traffic to **1 request per second sustained per client IP** with a burst capacity of 5.
   - Protects your upstream API quotas against abuse, scraping, or spam while seamlessly allowing normal page loads.
   - Returns `HTTP 429 Too Many Requests` with a `Retry-After: 1` header when exceeded.

---

## Setup & Running

### 1. Navigate to the backend folder:
```bash
cd backend
```

### 2. Configure Environment Variables (`backend/.env`):
Ensure `.env` contains your API keys:
```env
WAQI_TOKEN=your_waqi_api_token
ORS_KEY=your_openrouteservice_api_key
```

### 3. Install Dependencies:
```bash
pip install -r requirements.txt
```

### 4. Run the Server:
```bash
uvicorn app:app --reload --port 8000
```

### 5. Interactive API Documentation:
Visit [http://localhost:8000/docs](http://localhost:8000/docs) in your browser for Swagger UI testing.
