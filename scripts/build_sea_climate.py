"""One-off: typical October sea state for each sea leg of the cruise (ERA5 ocean waves, 2011–2025).

For every leg we sample three points along the planned route (start, middle, end) and look at the
same calendar window (±7 days) in each year. Used on the Weather → At sea tab until the wave forecast
(~10 days) reaches the leg.
"""
from datetime import date, timedelta

from common import CONFIG, DATA, Route, http_get_json, iso, load_json, parse_utc, save_json, utcnow

YEARS = list(range(2011, 2026))
WINDOW_DAYS = 7


def sea_legs(it):
    """(label, start, end) for every leg between a departure and the next arrival."""
    stops = it["stops"]
    legs = []
    for a, b in zip(stops, stops[1:]):
        legs.append((f"{a['name']} → {b['name']}", parse_utc(a["depart"]), parse_utc(b["arrive"])))
    return legs


def main():
    it = load_json(CONFIG / "itinerary.json")
    route = Route(it)
    legs = sea_legs(it)
    pts = []  # (leg index, lat, lon)
    for i, (_, s, e) in enumerate(legs):
        for f in (0.2, 0.5, 0.8):
            p = route.at(s + (e - s) * f)
            pts.append((i, round(p["lat"], 2), round(p["lon"], 2)))
    lats = ",".join(str(p[1]) for p in pts)
    lons = ",".join(str(p[2]) for p in pts)
    waves = {i: [] for i in range(len(legs))}
    for y in YEARS:
        for i, (_, s, e) in enumerate(legs):
            pass
        start = date(y, 10, 10) - timedelta(days=WINDOW_DAYS)
        end = date(y, 10, 24) + timedelta(days=WINDOW_DAYS)
        res = http_get_json("https://marine-api.open-meteo.com/v1/marine"
                            f"?latitude={lats}&longitude={lons}&hourly=wave_height"
                            f"&start_date={start}&end_date={end}&models=era5_ocean&timezone=GMT", timeout=120)
        if isinstance(res, dict):
            res = [res]
        for (leg, _, _), loc in zip(pts, res):
            _, s, e = legs[leg]
            lo = date(y, s.month, s.day) - timedelta(days=WINDOW_DAYS)
            hi = date(y, e.month, e.day) + timedelta(days=WINDOW_DAYS)
            for t, v in zip(loc["hourly"]["time"], loc["hourly"]["wave_height"]):
                if v is not None and lo.isoformat() <= t[:10] <= hi.isoformat():
                    waves[leg].append(v)
        print("fetched", y)
    out = []
    for i, (label, s, e) in enumerate(legs):
        w = sorted(waves[i])
        n = len(w)
        out.append({"label": label, "start": iso(s), "end": iso(e),
                    "wave_mean": round(sum(w) / n, 2), "wave_p90": round(w[int(0.9 * (n - 1))], 2),
                    "share_over_2_5": round(sum(v > 2.5 for v in w) / n, 2),
                    "share_over_4": round(sum(v > 4 for v in w) / n, 2)})
        print(out[-1])
    save_json(DATA / "sea_climate.json", {"generated": iso(utcnow()),
                                          "source": "ERA5 ocean waves via Open-Meteo marine API",
                                          "years": [YEARS[0], YEARS[-1]], "legs": out})


if __name__ == "__main__":
    main()
