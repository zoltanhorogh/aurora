"""Shared helpers: itinerary/route, astronomy, geomagnetic latitude, HTTP."""
import json
import math
import os
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Overridable so tools/preflight.py can run everything on a temporary copy.
CONFIG = Path(os.environ.get("AURORA_CONFIG") or ROOT / "config")
DATA = Path(os.environ.get("AURORA_DATA") or ROOT / "data")
UA = "aurora-dashboard (github.com/zoltanhorogh/aurora)"

RAD = math.pi / 180
UTC = timezone.utc

# IGRF-14 (2025) geomagnetic north pole used for the dipole approximation.
POLE_LAT = 80.8
POLE_LON = -72.6


# ---------------------------------------------------------------- time / io

def utcnow():
    return datetime.now(UTC)


def parse_utc(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(UTC)


def iso(dt):
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, obj, compact=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")


HTTP_CACHE = os.environ.get("AURORA_HTTP_CACHE")  # simulations only (tools/preflight.py --timeline): reuse answers


def http_get(url, timeout=60, retries=3):
    if HTTP_CACHE:
        import hashlib
        f = Path(HTTP_CACHE) / (hashlib.sha1(url.encode()).hexdigest() + ".txt")
        if f.exists():
            return f.read_text(encoding="utf-8")
        text = _http_get(url, timeout, retries)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")
        return text
    return _http_get(url, timeout, retries)


def _http_get(url, timeout=60, retries=3):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8")
        except Exception as e:  # network hiccups are common on shared runners
            last = e
            if getattr(e, "code", None) == 429:
                break  # request quota used up: retrying within seconds only wastes time
            time.sleep(2 + attempt * 3)
    raise RuntimeError(f"GET failed ({last}): {url}")  # the reason first: the status line is cut at 200 characters


def http_get_json(url, timeout=60):
    return json.loads(http_get(url, timeout))


# ---------------------------------------------------------------- geometry

def haversine_km(a, b):
    lat1, lon1 = a
    lat2, lon2 = b
    p1, p2 = lat1 * RAD, lat2 * RAD
    dp, dl = (lat2 - lat1) * RAD, (lon2 - lon1) * RAD
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def mag_lat(lat, lon):
    """Dipole geomagnetic latitude in degrees."""
    s = (math.sin(lat * RAD) * math.sin(POLE_LAT * RAD)
         + math.cos(lat * RAD) * math.cos(POLE_LAT * RAD) * math.cos((lon - POLE_LON) * RAD))
    return math.asin(max(-1.0, min(1.0, s))) / RAD


def kp_required(mlat):
    """Conservative Kp needed for a clearly visible display (not just a faint horizon glow).

    Calibrated so Tromsø ~0.5, Trondheim/Ålesund ~3, southern North Sea ~6, Southampton ~8.
    """
    return max(0.0, min(9.0, (67.5 - mlat) / 1.8 + 0.5))


def fetch_hp30(start, end):
    """GFZ Potsdam Hp30: half-hourly planetary activity (Kp-like scale), published ~30 min after each interval."""
    js = http_get_json("https://kp.gfz-potsdam.de/app/json/"
                       f"?start={iso(start)}&end={iso(end)}&index=Hp30")
    return [(parse_utc(t), float(v)) for t, v in zip(js.get("datetime", []), js.get("Hp30", [])) if v is not None]


def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


# ---------------------------------------------------------------- itinerary

class Route:
    """Ship position as a function of time, from stops + leg waypoints."""

    def __init__(self, itinerary):
        self.it = itinerary
        self.stops = itinerary["stops"]
        self.segments = []  # (t0, t1, kind, payload)
        for i, st in enumerate(self.stops):
            if "arrive" in st and "depart" in st:
                self.segments.append((parse_utc(st["arrive"]), parse_utc(st["depart"]), "port", st))
            if i + 1 < len(self.stops):
                nxt = self.stops[i + 1]
                key = f"{st['id']}-{nxt['id']}"
                pts = itinerary["legs"][key]
                cum = [0.0]
                for a, b in zip(pts, pts[1:]):
                    cum.append(cum[-1] + haversine_km(a, b))
                self.segments.append((parse_utc(st["depart"]), parse_utc(nxt["arrive"]), "sea",
                                      {"pts": pts, "cum": cum, "from": st, "to": nxt}))
        self.segments.sort(key=lambda s: s[0])
        self.start = parse_utc(self.stops[0]["depart"])
        self.end = parse_utc(self.stops[-1]["arrive"])

    def at(self, t):
        """Return dict(lat, lon, state, place, light) for time t (UTC datetime)."""
        if t <= self.start:
            s = self.stops[0]
            return {"lat": s["lat"], "lon": s["lon"], "state": "port", "place": s["name"], "light": s["light"]}
        if t >= self.end:
            s = self.stops[-1]
            return {"lat": s["lat"], "lon": s["lon"], "state": "port", "place": s["name"], "light": s["light"]}
        for t0, t1, kind, p in self.segments:
            if t0 <= t <= t1:
                if kind == "port":
                    return {"lat": p["lat"], "lon": p["lon"], "state": "port", "place": p["name"], "light": p["light"]}
                frac = (t - t0).total_seconds() / max(1.0, (t1 - t0).total_seconds())
                target = frac * p["cum"][-1]
                pts, cum = p["pts"], p["cum"]
                for j in range(len(pts) - 1):
                    if cum[j + 1] >= target:
                        seg = cum[j + 1] - cum[j]
                        f = 0 if seg == 0 else (target - cum[j]) / seg
                        lat = pts[j][0] + f * (pts[j + 1][0] - pts[j][0])
                        lon = pts[j][1] + f * (pts[j + 1][1] - pts[j][1])
                        return {"lat": round(lat, 3), "lon": round(lon, 3), "state": "sea",
                                "place": f"At sea ({p['from']['name']} → {p['to']['name']})", "light": 1.0}
                last = pts[-1]
                return {"lat": last[0], "lon": last[1], "state": "sea", "place": "At sea", "light": 1.0}
        s = self.stops[-1]
        return {"lat": s["lat"], "lon": s["lon"], "state": "port", "place": s["name"], "light": s["light"]}


def night_dates(itinerary):
    d = datetime.fromisoformat(itinerary["nights_from"]).date()
    end = datetime.fromisoformat(itinerary["nights_to"]).date()
    out = []
    while d <= end:
        out.append(d)
        d += timedelta(days=1)
    return out


def night_hours(date):
    """Hourly UTC timestamps covering the evening of `date` to the next morning."""
    t0 = datetime(date.year, date.month, date.day, 15, tzinfo=UTC)
    return [t0 + timedelta(hours=h) for h in range(15)]  # 15:00Z .. 05:00Z next day


# ---------------------------------------------------------------- when a night is over
# One rule everywhere (page and scripts): a night is over when its darkness ends at its place
# (the sun climbs back above -12°). Without a dark period: 06:00 ship time.

DARK_SUN_ALT = -12               # same as build_climatology.DARK_SUN
TROMSO = (69.65, 18.96)          # the practice spot before the cruise


def _morning_fallback(d):
    return datetime(d.year, d.month, d.day, 4, tzinfo=UTC) + timedelta(days=1)


def darkness_end(d, lat, lon):
    """End of the night that starts on date d at a fixed place (UTC datetime)."""
    t = datetime(d.year, d.month, d.day, 22, tzinfo=UTC)  # local midnight (ship time UTC+2)
    prev = sun_alt(t, lat, lon)
    for _ in range(14 * 12):
        tn = t + timedelta(minutes=5)
        cur = sun_alt(tn, lat, lon)
        if prev < DARK_SUN_ALT <= cur:
            return t + timedelta(minutes=5) * ((DARK_SUN_ALT - prev) / (cur - prev))
        t, prev = tn, cur
    return _morning_fallback(d)


def night_end(n):
    """End of a scored night from update.py (latest.json): its darkness end at the ship's position."""
    e = next((e for e in n.get("events", []) if e["kind"] == "dark_end"), None)
    if e:
        return parse_utc(e["t"])
    dark = [h for h in n.get("hourly", []) if h["dark"]]
    if dark:
        return parse_utc(dark[-1]["t"]) + timedelta(hours=1)
    return _morning_fallback(datetime.fromisoformat(n["date"]).date())


def cruise_day_from(itinerary):
    """When the first cruise night becomes "tonight": the end of the practice night before it (Tromsø)."""
    first = datetime.fromisoformat(itinerary["nights_from"]).date()
    return darkness_end(first - timedelta(days=1), *TROMSO)


# ---------------------------------------------------------------- astronomy
# Low-precision formulas (after SunCalc / Meeus); ~1° accuracy is plenty here.

OBLIQ = RAD * 23.4397


def _days(t):
    return t.timestamp() / 86400.0 - 0.5 + 2440588 - 2451545


def _ra(l, b):
    return math.atan2(math.sin(l) * math.cos(OBLIQ) - math.tan(b) * math.sin(OBLIQ), math.cos(l))


def _dec(l, b):
    return math.asin(math.sin(b) * math.cos(OBLIQ) + math.cos(b) * math.sin(OBLIQ) * math.sin(l))


def _sidereal(d, lw):
    return RAD * (280.16 + 360.9856235 * d) - lw


def _alt(H, phi, dec):
    return math.asin(math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(H))


def _sun_coords(d):
    M = RAD * (357.5291 + 0.98560028 * d)
    C = RAD * (1.9148 * math.sin(M) + 0.02 * math.sin(2 * M) + 0.0003 * math.sin(3 * M))
    L = M + C + RAD * 102.9372 + math.pi
    return _dec(L, 0), _ra(L, 0)


def _moon_coords(d):
    L = RAD * (218.316 + 13.176396 * d)
    M = RAD * (134.963 + 13.064993 * d)
    F = RAD * (93.272 + 13.229350 * d)
    l = L + RAD * 6.289 * math.sin(M)
    b = RAD * 5.128 * math.sin(F)
    dist = 385001 - 20905 * math.cos(M)
    return _dec(l, b), _ra(l, b), dist


def sun_alt(t, lat, lon):
    d = _days(t)
    dec, ra = _sun_coords(d)
    H = _sidereal(d, -lon * RAD) - ra
    return _alt(H, lat * RAD, dec) / RAD


def moon_alt(t, lat, lon):
    d = _days(t)
    dec, ra, _ = _moon_coords(d)
    H = _sidereal(d, -lon * RAD) - ra
    return _alt(H, lat * RAD, dec) / RAD


def moon_illum(t):
    d = _days(t)
    sdec, sra = _sun_coords(d)
    mdec, mra, mdist = _moon_coords(d)
    sdist = 149598000
    phi = math.acos(max(-1, min(1, math.sin(sdec) * math.sin(mdec)
                                + math.cos(sdec) * math.cos(mdec) * math.cos(sra - mra))))
    inc = math.atan2(sdist * math.sin(phi), mdist - sdist * math.cos(phi))
    return (1 + math.cos(inc)) / 2
