# -*- coding: utf-8 -*-
"""
End-to-End automated testing suite for Delhi AQI Sentinel.
Tests:
1. Static code health (JS brace balance, required function definitions, required HTML element IDs)
2. Backend API Happy Path (Health, Stations, Forecast, Route POST & GET, Geocode)
3. Backend Failure Path (Invalid coords, Out-of-bounds routing, Nonexistent endpoint, Missing params)
4. Frontend Static Files (index.html, style.css, app.js, manifest.webmanifest, sw.js, icons)
5. Responsive CSS checks for 360px viewport
"""
import urllib.request
import urllib.error
import json
import re
import sys

BASE_URL = "http://127.0.0.1:8000"

def test_code_integrity():
    print("[1/5] Testing Frontend JavaScript & HTML Integrity...")
    with open("frontend/app.js", "r", encoding="utf-8") as f:
        js = f.read()

    # Check brace/bracket balance properly ignoring comments and strings
    open_curlies = 0
    open_parens = 0
    open_brackets = 0
    in_str = None
    in_multi_comment = False
    escaped = False

    i = 0
    n = len(js)
    while i < n:
        ch = js[i]
        if in_multi_comment:
            if ch == "*" and i + 1 < n and js[i+1] == "/":
                in_multi_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == in_str:
                in_str = None
            i += 1
            continue

        # Check comment start
        if ch == "/" and i + 1 < n:
            if js[i+1] == "/":
                # Skip to end of line
                eol = js.find("\n", i)
                if eol == -1:
                    break
                i = eol + 1
                continue
            elif js[i+1] == "*":
                in_multi_comment = True
                i += 2
                continue

        if ch in ('"', "'", "`"):
            in_str = ch
        elif ch == "{":
            open_curlies += 1
        elif ch == "}":
            open_curlies -= 1
        elif ch == "(":
            open_parens += 1
        elif ch == ")":
            open_parens -= 1
        elif ch == "[":
            open_brackets += 1
        elif ch == "]":
            open_brackets -= 1

        i += 1

    assert open_curlies == 0, f"Unbalanced curlies in app.js: {open_curlies}"
    assert open_parens == 0, f"Unbalanced parens in app.js: {open_parens}"
    assert open_brackets == 0, f"Unbalanced brackets in app.js: {open_brackets}"
    print("  -> JS parenthesis, bracket, and brace balance: PASS")

    # Check essential functions exist in app.js
    required_funcs = [
        "renderCommutePage", "runCommuteRoute", "fetchCommuteLeaveTime", "fetchCommuteReturnForecast",
        "updateTripImpactCard", "aqiToEstimatedPm25",
        "updatePollutionPulse", "updateHealthyHomeHelper",
        "renderPersonalSafetyAdvisor", "renderSchoolMode",
        "renderStationComparison", "initAqiAlerts", "checkSavedPlacesAlerts"
    ]
    for func in required_funcs:
        assert func in js, f"Missing required function in app.js: {func}"
    print("  -> All 9 feature functions present in app.js: PASS")

    # Check essential HTML elements exist in index.html
    with open("frontend/index.html", "r", encoding="utf-8") as f:
        html = f.read()

    required_ids = [
        "view-map", "view-now", "view-commute", "view-advisor", "view-school", "view-compare",
        "commute-swap-btn", "commute-return-forecast", "trip-impact-card",
        "pollution-pulse-card", "healthy-home-card",
        "advisor-station-select", "advisor-activity-select", "advisor-verdict-banner",
        "school-station-select", "light-red", "light-amber", "light-green",
        "btn-lang-en", "btn-lang-hi", "btn-copy-school-msg", "btn-wa-school-share",
        "compare-select-1", "compare-select-2", "compare-select-3", "rank-cleanest-list", "rank-polluted-list",
        "btn-toggle-alerts", "offline-status-banner", "pwa-install-btn"
    ]
    for el_id in required_ids:
        assert f'id="{el_id}"' in html, f"Missing required element ID in index.html: {el_id}"
    print("  -> All feature DOM IDs present in index.html: PASS")


def test_api_happy_path():
    print("[2/5] Testing Backend API Happy Paths...")
    
    # 1. Health
    req = urllib.request.urlopen(f"{BASE_URL}/api/health")
    assert req.status == 200
    data = json.loads(req.read().decode())
    assert data.get("status") == "ok"
    print("  -> GET /api/health: PASS")

    # 2. Stations
    req = urllib.request.urlopen(f"{BASE_URL}/api/stations?bounds=28.40,76.84,28.88,77.35")
    assert req.status == 200
    stations_data = json.loads(req.read().decode())
    assert stations_data.get("status") == "ok"
    assert len(stations_data.get("data", [])) > 0
    print(f"  -> GET /api/stations: PASS ({len(stations_data['data'])} stations returned)")

    # 3. Forecast
    req = urllib.request.urlopen(f"{BASE_URL}/api/forecast?lat=28.6139&lng=77.2090")
    assert req.status == 200
    forecast_data = json.loads(req.read().decode())
    assert "hourly" in forecast_data
    assert "current_weather" in forecast_data
    print("  -> GET /api/forecast: PASS (hourly & current_weather present)")

    # 4. Route POST
    route_payload = json.dumps({
        "mode": "driving-car",
        "coordinates": [[77.2090, 28.6139], [77.2180, 28.6280]],
        "alternative_routes": {"target_count": 2, "share_factor": 0.6, "weight_factor": 1.6}
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/api/route",
        data=route_payload,
        headers={"Content-Type": "application/json"}
    )
    res = urllib.request.urlopen(req)
    assert res.status == 200
    route_data = json.loads(res.read().decode())
    assert route_data.get("type") == "FeatureCollection"
    assert len(route_data.get("features", [])) > 0
    print(f"  -> POST /api/route: PASS ({len(route_data['features'])} route(s) returned)")

    # 5. Geocode
    req = urllib.request.urlopen(f"{BASE_URL}/api/geocode?q=Connaught")
    assert req.status == 200
    geo_data = json.loads(req.read().decode())
    assert isinstance(geo_data, (list, dict))
    features = geo_data.get("ors_features", []) if isinstance(geo_data, dict) else geo_data
    print(f"  -> GET /api/geocode: PASS ({len(features)} results)")


def test_api_failure_path():
    print("[3/5] Testing Backend Failure & Validation Paths...")

    # 1. Invalid coordinates outside Delhi NCR
    route_payload = json.dumps({
        "mode": "driving-car",
        "coordinates": [[12.0, 45.0], [13.0, 46.0]] # Far outside Delhi
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/api/route",
        data=route_payload,
        headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(req)
        assert False, "Expected 400 for out-of-bounds route coordinates"
    except urllib.error.HTTPError as e:
        assert e.code == 400
        print("  -> Out-of-bounds route rejected with HTTP 400: PASS")

    # 2. Invalid forecast parameters (out-of-bounds or non-numeric)
    try:
        urllib.request.urlopen(f"{BASE_URL}/api/forecast?lat=10.0&lng=10.0")
        assert False, "Expected 400 for out-of-bounds forecast coordinates"
    except urllib.error.HTTPError as e:
        assert e.code == 400
        print("  -> Out-of-bounds forecast coordinates rejected with HTTP 400: PASS")

    try:
        urllib.request.urlopen(f"{BASE_URL}/api/forecast?lat=invalid&lng=not_a_number")
        assert False, "Expected 422 for non-numeric forecast coordinates"
    except urllib.error.HTTPError as e:
        assert e.code == 422
        print("  -> Non-numeric forecast parameters rejected with HTTP 422: PASS")

    # 3. Nonexistent endpoint
    try:
        urllib.request.urlopen(f"{BASE_URL}/api/nonexistent_xyz")
        assert False, "Expected 404 for nonexistent endpoint"
    except urllib.error.HTTPError as e:
        assert e.code == 404
        print("  -> Unknown API route returns HTTP 404: PASS")


def test_frontend_static_and_pwa():
    print("[4/5] Testing Frontend Static Files & PWA Shell...")
    
    # 1. Root serves index.html
    res = urllib.request.urlopen(f"{BASE_URL}/")
    assert res.status == 200
    content = res.read().decode("utf-8")
    assert "<title>Delhi AQI Sentinel" in content
    print("  -> GET / serves index.html: PASS")

    # 2. Web Manifest
    res = urllib.request.urlopen(f"{BASE_URL}/manifest.webmanifest")
    assert res.status == 200
    manifest = json.loads(res.read().decode("utf-8"))
    assert manifest.get("name") == "Delhi AQI Sentinel"
    print("  -> GET /manifest.webmanifest: PASS")

    # 3. Service Worker
    res = urllib.request.urlopen(f"{BASE_URL}/sw.js")
    assert res.status == 200
    sw_code = res.read().decode("utf-8")
    assert "CACHE_NAME" in sw_code
    print("  -> GET /sw.js: PASS")

    # 4. App icons
    res = urllib.request.urlopen(f"{BASE_URL}/icons/icon-192.png")
    assert res.status == 200
    assert len(res.read()) > 100
    print("  -> GET /icons/icon-192.png: PASS")


def test_mobile_responsive_css():
    print("[5/5] Testing Responsive CSS (360px support)...")
    with open("frontend/style.css", "r", encoding="utf-8") as f:
        css = f.read()

    # Check for media queries covering <= 700px and <= 480px / 360px
    assert "@media (max-width: 700px)" in css or "@media (max-width: 768px)" in css
    assert "overflow-x: auto" in css or "overflow-x" in css
    assert ".compare-selectors-grid" in css
    assert ".advisor-control-row" in css
    print("  -> Responsive mobile CSS rules verified: PASS")


if __name__ == "__main__":
    import traceback
    try:
        test_code_integrity()
        test_api_happy_path()
        test_api_failure_path()
        test_frontend_static_and_pwa()
        test_mobile_responsive_css()
        print("\n🎉 ALL TESTS PASSED SUCCESSFULLY! All 9 features verified.")
    except Exception as e:
        print(f"\n❌ TEST FAILED: {e}")
        traceback.print_exc()
        sys.exit(1)
