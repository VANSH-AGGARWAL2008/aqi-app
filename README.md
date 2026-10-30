# Delhi AQI Map

A live air-quality map for Delhi NCR that also finds the least-polluted route to a destination.

## What it does
- Shows live AQI from monitoring stations across Delhi NCR
- Estimates AQI between stations on a colored map layer
- Finds routes to a destination and scores each by pollution exposure
- Marks the cleanest route

## How to run it on your computer
1. Install Python.
2. In the `backend` folder, copy `.env.example` to `.env` and add your own API keys.
3. In a terminal, run: `cd backend`, then `pip install -r requirements.txt`, then `uvicorn app:app --reload --port 8000`
4. Open `index.html` with the Live Server extension.

## Data sources
WAQI (aqicn.org), OpenAQ, OpenStreetMap, Open-Meteo.

Note: values are estimates and not an official government source.
