"""Port, outdoor-spot and marine weather from MET Norway → data/weather.json.

  * ports: hourly forecast for the hours the ship is in port (MET locationforecast "complete":
    hourly for ~2.5 days, 6-hourly up to ~9 days); typical October weather until then;
  * spots: the planned hikes/viewpoints, forecast at their own altitude + a rough "view" estimate;
  * Alta: sea state in Altafjord for the water shuttle (MET oceanforecast);
  * official MET warnings (MetAlerts) that touch a port, a spot or the ship's route.
"""
import traceback
from datetime import timedelta

from common import CONFIG, DATA, Route, http_get_json, iso, load_json, parse_utc, save_json, utcnow

MET = "https://api.met.no/weatherapi"
status = {}


def safe(name, fn, *a, default=None):
    try:
        res = fn(*a)
        status.setdefault(name, {"ok": True})
        return res
    except Exception as e:
        traceback.print_exc()
        status[name] = {"ok": False, "error": str(e)[:200]}
        return default


def met_complete(lat, lon, alt=None):
    url = f"{MET}/locationforecast/2.0/complete?lat={lat:.4f}&lon={lon:.4f}"
    if alt is not None:
        url += f"&altitude={int(alt)}"
    out = []
    for ts in http_get_json(url)["properties"]["timeseries"]:
        d = ts["data"]
        ins = d["instant"]["details"]
        nx, step = (d.get("next_1_hours"), 1) if d.get("next_1_hours") else (d.get("next_6_hours"), 6)
        if not nx:
            continue
        det = nx.get("details", {})
        out.append({
            "t": iso(parse_utc(ts["time"])), "step": step,
            "T": ins.get("air_temperature"), "feels": ins.get("apparent_air_temperature"),
            "wind": ins.get("wind_speed"), "gust": ins.get("wind_speed_of_gust"), "dir": ins.get("wind_from_direction"),
            "cloud": ins.get("cloud_area_fraction"), "low": ins.get("cloud_area_fraction_low"),
            "fog": ins.get("fog_area_fraction"), "rh": ins.get("relative_humidity"),
            "uv": ins.get("ultraviolet_index_clear_sky"),
            "pr": det.get("precipitation_amount"), "pp": det.get("probability_of_precipitation"),
            "thunder": det.get("probability_of_thunder"), "sym": (nx.get("summary") or {}).get("symbol_code"),
        })
    return out


def met_ocean(lat, lon):
    out = []
    for ts in http_get_json(f"{MET}/oceanforecast/2.0/complete?lat={lat:.3f}&lon={lon:.3f}")["properties"]["timeseries"]:
        det = ts["data"]["instant"]["details"]
        out.append({"t": iso(parse_utc(ts["time"])), "wave": det.get("sea_surface_wave_height"),
                    "sst": det.get("sea_water_temperature")})
    return out


def in_window(series, start, end):
    """Entries overlapping [start, end] (6-hourly entries cover t..t+6h)."""
    return [e for e in series
            if parse_utc(e["t"]) + timedelta(hours=e["step"] if "step" in e else 1) > start and parse_utc(e["t"]) <= end]


def summarize(series):
    if not series:
        return None
    temps = [e["T"] for e in series if e["T"] is not None]
    feels = [e["feels"] for e in series if e["feels"] is not None]
    gusts = [e["gust"] for e in series if e["gust"] is not None] or [e["wind"] for e in series if e["wind"] is not None]
    pr = sum(e["pr"] or 0 for e in series)
    syms = " ".join(e["sym"] or "" for e in series)
    return {
        "t_min": min(temps) if temps else None, "t_max": max(temps) if temps else None,
        "feels_min": min(feels) if feels else None,
        "gust_max": max(gusts) if gusts else None,
        "precip_total": round(pr, 1),
        "pp_max": max((e["pp"] or 0) for e in series),
        "thunder_max": max((e["thunder"] or 0) for e in series),
        "snow": "snow" in syms, "sleet": "sleet" in syms,
        "uv_max": max((e.get("uv") or 0) for e in series),
    }


def advice(s, kind="port"):
    if not s:
        return []
    out = []
    fm = s["feels_min"]
    if fm is not None and fm <= 0:
        out.append("Hat, gloves and a warm layer: it feels below freezing")
    elif fm is not None and fm <= 5:
        out.append("Warm layer: it feels cold")
    if s["snow"] or s["sleet"]:
        out.append("Snow or sleet possible: shoes with grip")
    if s["precip_total"] >= 2 or s["pp_max"] >= 60:
        out.append("Rain jacket and waterproof shoes")
    g = s["gust_max"]
    if g is not None and g >= 20:
        out.append({"summit": "Strong gusts: avoid exposed ridges and edges; the cable car may stop",
                    "coast": "Strong gusts: stay back from the water's edge"}.get(kind, "Strong gusts: hold on to hats and umbrellas"))
    elif g is not None and g >= 15:
        out.append("Windy: windproof shell" + (" (windier up high)" if kind == "summit" else ""))
    if s["thunder_max"] >= 10:
        out.append("Thunder possible")
    return out


def view(series, ele):
    """Rough 'will we see anything from up there' from fog and low cloud during daylight."""
    day = [e for e in series if 6 <= (parse_utc(e["t"]).hour + 2) % 24 <= 17]
    if not day:
        return None
    fog = max((e["fog"] or 0) for e in day)
    low = sum((e["low"] or 0) for e in day) / len(day)
    if fog >= 50 or (ele >= 250 and low >= 80):
        return "Summit likely in cloud: little or no view"
    if low >= 40:
        return "Mixed: low cloud may hide the view at times"
    return "Clear view likely"


# ---------------------------------------------------------------- warnings

def point_in_ring(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def point_in_geom(lon, lat, geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    for poly in polys:
        if poly and point_in_ring(lon, lat, poly[0]) and not any(point_in_ring(lon, lat, h) for h in poly[1:]):
            return True
    return False


def alerts(points):
    js = http_get_json(f"{MET}/metalerts/2.0/current.json?lang=en")
    out = []
    for f in js.get("features", []):
        pr, geom = f.get("properties", {}), f.get("geometry")
        if not geom:
            continue
        hit = sorted({name for name, lat, lon in points if point_in_geom(lon, lat, geom)})
        if not hit:
            continue
        when = (f.get("when") or {}).get("interval") or [None, None]
        out.append({"title": pr.get("title"), "event": pr.get("eventAwarenessName") or pr.get("event"),
                    "level": pr.get("awareness_level"), "area": pr.get("area"), "description": pr.get("description"),
                    "instruction": pr.get("instruction"), "domain": pr.get("geographicDomain"),
                    "from": when[0], "to": when[1] if len(when) > 1 else None, "places": hit})
    return sorted(out, key=lambda a: (a["from"] or ""))


# ---------------------------------------------------------------- main

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--shift-days", type=int, default=0,
                    help="testing only: move the port days by N days (e.g. -16) so today's forecast covers them")
    args = ap.parse_args()
    shift = timedelta(days=args.shift_days)
    now = utcnow()
    it = load_json(CONFIG / "itinerary.json")
    cfg = load_json(CONFIG / "spots.json")
    stops = {s["id"]: s for s in it["stops"]}
    climate = (load_json(DATA / "port_climate.json", {}) or {}).get("ports", {})
    route = Route(it)

    ports_out = []
    for p in cfg["ports"]:
        st = stops[p["stop"]]
        if "hours_before" in p:
            end = parse_utc(st["depart"])
            start = end - timedelta(hours=p["hours_before"])
        elif "hours_after" in p:
            start = parse_utc(st["arrive"])
            end = start + timedelta(hours=p["hours_after"])
        else:
            start, end = parse_utc(st["arrive"]), parse_utc(st["depart"])
        start, end = start + shift, end + shift
        full =safe("met_locationforecast", met_complete, p["lat"], p["lon"], default=[])
        horizon = parse_utc(full[-1]["t"]) if full else now
        series = in_window(full, start, end)
        # "Right now": the next 48 hours at this port, whatever the cruise date (like any weather app).
        now_series = [e for e in full if e["step"] == 1 and now - timedelta(hours=1) <= parse_utc(e["t"]) <= now + timedelta(hours=48)]
        entry = {"id": p["id"], "name": p["name"], "window": [iso(start), iso(end)],
                 "forecast_until": iso(horizon), "series": series, "summary": summarize(series),
                 "now_series": now_series, "now_summary": summarize(now_series),
                 "climate": climate.get(p["id"])}
        entry["advice"] = advice(entry["summary"])
        entry["now_advice"] = advice(entry["now_summary"])
        if p.get("sea"):
            sea = safe("met_oceanforecast", met_ocean, p["sea"]["lat"], p["sea"]["lon"], default=[])
            sw = [e for e in sea if start <= parse_utc(e["t"]) <= end]
            waves = [e["wave"] for e in sw if e["wave"] is not None]
            gust = (entry["summary"] or {}).get("gust_max")
            wmax = max(waves) if waves else None
            risk = None
            if wmax is not None:
                risk = ("Water shuttle may be cancelled" if wmax >= 1.5 or (gust or 0) >= 17
                        else "Water shuttle may be bumpy" if wmax >= 0.8 or (gust or 0) >= 12
                        else "Calm water: shuttle should run normally")
            entry["sea"] = {"label": p["sea"]["label"], "series": sw, "wave_max": wmax,
                            "sst": sw[0]["sst"] if sw else None, "risk": risk}
        spots = []
        for s in cfg["spots"]:
            if s["port"] != p["id"]:
                continue
            sfull = safe("met_locationforecast", met_complete, s["lat"], s["lon"], s["ele"], default=[])
            ss = in_window(sfull, start, end)
            summ = summarize(ss)
            ns = [e for e in sfull if e["step"] == 1 and now - timedelta(hours=1) <= parse_utc(e["t"]) <= now + timedelta(hours=36)]
            nsumm = summarize(ns)
            spots.append({**s, "series": ss, "summary": summ,
                          "advice": advice(summ, s["kind"]),
                          "view": view(ss, s["ele"]) if s["kind"] in ("summit", "viewpoint") else None,
                          "now_series": [{k: e[k] for k in ("t", "T", "feels", "gust", "wind", "dir", "pr", "pp", "sym", "low", "fog", "uv")} for e in ns],
                          "now_summary": nsumm, "now_advice": advice(nsumm, s["kind"]),
                          "now_view": view(ns, s["ele"]) if s["kind"] in ("summit", "viewpoint") else None})
        entry["spots"] = spots
        ports_out.append(entry)

    # Warnings that touch a port, a spot or the ship's route over the next days.
    points = [(p["name"], p["lat"], p["lon"]) for p in cfg["ports"]]
    points += [(s["name"], s["lat"], s["lon"]) for s in cfg["spots"]]
    t = max(now, route.start)
    while t <= min(route.end, now + timedelta(days=4)):
        pos = route.at(t)
        if pos["state"] == "sea":
            points.append(("Ship route", pos["lat"], pos["lon"]))
        t += timedelta(hours=3)
    if now < route.start:  # before the cruise: sample the whole route so warnings near it show up
        t = route.start
        while t <= route.end:
            pos = route.at(t)
            points.append(("Ship route", pos["lat"], pos["lon"]))
            t += timedelta(hours=6)
    warn = safe("met_alerts", alerts, points, default=[])

    save_json(DATA / "weather.json", {"generated": iso(now), "ports": ports_out, "alerts": warn, "sources": status,
                                      "test_shift_days": args.shift_days or None}, compact=True)
    print("weather done", iso(now), status)
    for p in ports_out:
        print(p["id"], len(p["series"]), "steps", p["summary"], p.get("sea", {}).get("risk") if p.get("sea") else "")
    print("alerts:", [(a["event"], a["places"][:3]) for a in warn])


if __name__ == "__main__":
    main()
