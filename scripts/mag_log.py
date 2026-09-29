"""Local magnetometer numbers for the live tile: how much the magnetic field is moving right now.

Source: FMI (Finnish Meteorological Institute) IMAGE network, 10-second real-time data, ~1 min delay,
licence CC BY 4.0. The browser cannot read it directly (no CORS), so this runs from the alert workflow
every 10 min and writes data/mag.json. Only in the dark at Tromsø: in daylight aurora cannot be seen anyway.

Stations near the route: Kilpisjärvi (~100 km from Tromsø) and Masi (~70 km south of Alta).
Swing = max − min of the horizontal field (nT); a substorm (active aurora overhead) shows as a sudden dip.
Also a 24 h series for the dashboard chart: 2-minute means relative to the 24 h median ("quiet level").
Output: data/mag.json  {"updated": ..., "stations": {"KIL": {..., "series": {"t0", "step_min", "dev"}}, "MAS": {...}}}
"""
import math
from datetime import datetime, timedelta, timezone

from common import DATA, http_get, iso, save_json, sun_alt, utcnow

BASE = "https://space.fmi.fi/image/realtime/UT/{s}/{s}data_24.txt"
STATIONS = {"KIL": ("Kilpisjärvi", 69.02, 20.79), "MAS": ("Masi", 69.46, 23.70)}
TROMSO = (69.65, 18.96)
DARK_SUN_ALT = -3  # degrees; a little before nautical twilight is enough to start logging
STEP_MIN = 2


def parse(text):
    """Rows of (time, horizontal field H) from an FMI real-time text file."""
    rows = []
    for line in text.splitlines():
        p = line.split()
        if len(p) < 8 or not p[0].isdigit():
            continue
        try:
            t = datetime(*map(int, p[:6]), tzinfo=timezone.utc)
            x, y = float(p[6]), float(p[7])
        except ValueError:
            continue
        if abs(x) > 90000 or abs(y) > 90000 or math.isnan(x) or math.isnan(y):
            continue  # missing-value markers
        rows.append((t, math.hypot(x, y)))
    return rows


def summarize(rows):
    last_t, last_h = rows[-1]
    hour = [h for t, h in rows if t >= last_t - timedelta(minutes=60)]
    ten = [(t, h) for t, h in rows if t >= last_t - timedelta(minutes=10)]
    return {"t": iso(last_t),
            "swing_60": round(max(hour) - min(hour)),
            "swing_10": round(max(h for _, h in ten) - min(h for _, h in ten)),
            "change_10": round(last_h - ten[0][1])}  # negative = field dropping (typical substorm dip)


def series(rows):
    """2-minute means of H minus the 24 h median; None where data is missing."""
    quiet = sorted(h for _, h in rows)[len(rows) // 2]
    t0 = rows[0][0].replace(minute=rows[0][0].minute - rows[0][0].minute % STEP_MIN, second=0)
    bins = {}
    for t, h in rows:
        bins.setdefault(int((t - t0).total_seconds() // (STEP_MIN * 60)), []).append(h)
    n = max(bins) + 1
    dev = [round(sum(bins[i]) / len(bins[i]) - quiet) if i in bins else None for i in range(n)]
    return {"t0": iso(t0), "step_min": STEP_MIN, "dev": dev}


def main():
    now = utcnow()
    if sun_alt(now, *TROMSO) > DARK_SUN_ALT:
        print("daylight at Tromsø — nothing to log")
        return
    out = {"updated": iso(now), "stations": {}}
    for code, (name, lat, lon) in STATIONS.items():
        try:
            rows = parse(http_get(BASE.format(s=code), timeout=30))
        except Exception as e:
            print(code, "failed:", e)
            continue
        if len(rows) < 30:
            print(code, "too few samples:", len(rows))
            continue
        out["stations"][code] = {"name": name, "lat": lat, "lon": lon, **summarize(rows), "series": series(rows)}
        print(code, {k: v for k, v in out["stations"][code].items() if k != "series"})
    if out["stations"]:
        save_json(DATA / "mag.json", out, compact=True)


if __name__ == "__main__":
    main()
