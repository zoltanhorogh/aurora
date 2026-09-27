"""One-off: typical weather for each port day (ERA5, same calendar window ±7 days, 2011–2025).

Used on the Weather tab until MET Norway's forecast reaches the date (about 9 days ahead).
Daytime = 08:00–20:00 local (06–18 UTC).
"""
from datetime import date, timedelta

from common import CONFIG, DATA, http_get_json, iso, load_json, parse_utc, save_json, utcnow

YEARS = list(range(2011, 2026))
WINDOW_DAYS = 7
DAY_UTC_HOURS = range(6, 18)


def main():
    it = load_json(CONFIG / "itinerary.json")
    stops = {s["id"]: s for s in it["stops"]}
    ports = load_json(CONFIG / "spots.json")["ports"]
    out = {}
    for p in ports:
        st = stops[p["stop"]]
        d = parse_utc(st.get("arrive") or st.get("depart")).date()
        vals = {"t": [], "feels": [], "wind": [], "gust": [], "pr": [], "snow": []}
        daily_max, daily_min = [], []
        for y in YEARS:
            start = date(y, d.month, d.day) - timedelta(days=WINDOW_DAYS)
            end = date(y, d.month, d.day) + timedelta(days=WINDOW_DAYS)
            js = http_get_json(
                "https://archive-api.open-meteo.com/v1/archive"
                f"?latitude={p['lat']}&longitude={p['lon']}&start_date={start}&end_date={end}"
                "&hourly=temperature_2m,apparent_temperature,precipitation,snowfall,wind_speed_10m,wind_gusts_10m"
                "&models=era5&wind_speed_unit=ms&timezone=GMT", timeout=120)
            h = js["hourly"]
            per_day = {}
            for i, t in enumerate(h["time"]):
                if int(t[11:13]) not in DAY_UTC_HOURS or h["temperature_2m"][i] is None:
                    continue
                vals["t"].append(h["temperature_2m"][i])
                vals["feels"].append(h["apparent_temperature"][i])
                vals["wind"].append(h["wind_speed_10m"][i])
                vals["gust"].append(h["wind_gusts_10m"][i])
                vals["pr"].append(h["precipitation"][i] or 0)
                vals["snow"].append(h["snowfall"][i] or 0)
                per_day.setdefault(t[:10], []).append(h["temperature_2m"][i])
            for temps in per_day.values():
                daily_max.append(max(temps))
                daily_min.append(min(temps))
        n = len(vals["t"])
        wet = [i for i in range(n) if vals["pr"][i] >= 0.1]
        gusts = sorted(g for g in vals["gust"] if g is not None)
        out[p["id"]] = {
            "name": p["name"], "date": d.isoformat(),
            "temp_mean": round(sum(vals["t"]) / n, 1),
            "temp_max_mean": round(sum(daily_max) / len(daily_max), 1),
            "temp_min_mean": round(sum(daily_min) / len(daily_min), 1),
            "feels_mean": round(sum(vals["feels"]) / n, 1),
            "wind_mean": round(sum(vals["wind"]) / n, 1),
            "gust_p90": round(gusts[int(0.9 * (len(gusts) - 1))], 1) if gusts else None,
            "wet_hours_share": round(len(wet) / n, 2),
            "snow_share_of_wet": round(sum(1 for i in wet if vals["snow"][i] > 0) / len(wet), 2) if wet else 0,
        }
        print(p["id"], out[p["id"]])
    save_json(DATA / "port_climate.json", {
        "generated": iso(utcnow()), "source": "ERA5 reanalysis via Open-Meteo archive, daytime 08–20 local",
        "years": [YEARS[0], YEARS[-1]], "window_days": WINDOW_DAYS, "ports": out})


if __name__ == "__main__":
    main()
