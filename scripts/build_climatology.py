"""One-off: clear-sky climatology per cruise night from ERA5 reanalysis (Open-Meteo archive).

For every cruise night we take the ship position around local midnight and look at
the same calendar window (±7 days) in each of the last 15 Octobers. A night counts as
"clear" when it has a clear window: >= 2 consecutive dark hours with cloud cover <= 40%
(the same definition update.py uses for the ensemble forecast).
"""
from datetime import date, datetime, timedelta

from common import (CONFIG, DATA, UTC, Route, http_get_json, iso, load_json, night_dates,
                    night_hours, save_json, sun_alt)

YEARS = list(range(2011, 2026))
WINDOW_DAYS = 7
CLEAR_MAX = 40
MIN_RUN = 2
DARK_SUN = -12


def clear_window(values, min_run=MIN_RUN, limit=CLEAR_MAX):
    run = 0
    for v in values:
        run = run + 1 if (v is not None and v <= limit) else 0
        if run >= min_run:
            return True
    return False


def main():
    it = load_json(CONFIG / "itinerary.json")
    route = Route(it)
    nights = night_dates(it)
    points = []
    for d in nights:
        mid = datetime(d.year, d.month, d.day, 22, tzinfo=UTC)
        p = route.at(mid)
        points.append((d, round(p["lat"], 2), round(p["lon"], 2), p["place"]))

    lats = ",".join(str(p[1]) for p in points)
    lons = ",".join(str(p[2]) for p in points)
    series = {i: {} for i in range(len(points))}  # idx -> {iso hour: cloud}
    for y in YEARS:
        url = ("https://archive-api.open-meteo.com/v1/archive"
               f"?latitude={lats}&longitude={lons}&start_date={y}-09-25&end_date={y}-11-02"
               "&hourly=cloud_cover&models=era5&timezone=GMT")
        res = http_get_json(url, timeout=120)
        if isinstance(res, dict):
            res = [res]
        for i, loc in enumerate(res):
            for t, v in zip(loc["hourly"]["time"], loc["hourly"]["cloud_cover"]):
                series[i][t] = v
        print("fetched", y)

    out = {}
    for i, (d, lat, lon, place) in enumerate(points):
        n_nights = n_clear = 0
        cloud_sum = cloud_n = 0
        for y in YEARS:
            for off in range(-WINDOW_DAYS, WINDOW_DAYS + 1):
                hd = date(y, d.month, d.day) + timedelta(days=off)
                vals = []
                for h in night_hours(hd):
                    if sun_alt(h, lat, lon) > DARK_SUN:
                        continue
                    v = series[i].get(h.strftime("%Y-%m-%dT%H:00"))
                    vals.append(v)
                    if v is not None:
                        cloud_sum += v
                        cloud_n += 1
                if not vals:
                    continue
                n_nights += 1
                n_clear += clear_window(vals)
        out[d.isoformat()] = {
            "lat": lat, "lon": lon, "place": place,
            "p_clear": round(n_clear / n_nights, 3) if n_nights else None,
            "mean_cloud": round(cloud_sum / cloud_n, 1) if cloud_n else None,
            "n_nights": n_nights,
        }
        print(d, place, out[d.isoformat()])

    save_json(DATA / "climatology.json", {
        "generated": iso(datetime.now(UTC)),
        "source": "ERA5 reanalysis via Open-Meteo archive API",
        "years": [YEARS[0], YEARS[-1]],
        "window_days": WINDOW_DAYS,
        "definition": f">= {MIN_RUN} consecutive dark hours (sun <= {DARK_SUN}°) with cloud cover <= {CLEAR_MAX}%",
        "nights": out,
    })


if __name__ == "__main__":
    main()
