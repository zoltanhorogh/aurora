"""Forecast pipeline: pulls space-weather + cloud forecasts, scores every cruise night,
writes data/latest.json and appends a snapshot to data/history.json."""
import re
import traceback
from datetime import datetime, timedelta

from common import (CONFIG, DATA, UTC, Route, http_get, http_get_json, iso, kp_required,
                    load_json, mag_lat, moon_alt, moon_illum, night_dates, night_hours,
                    norm_cdf, parse_utc, save_json, sun_alt, utcnow)
from build_climatology import CLEAR_MAX, DARK_SUN, clear_window

SWPC = "https://services.swpc.noaa.gov"
SHIP_UTC_OFFSET = 2          # CEST; Norway stays on summer time until 25 Oct
KP_CLIMATOLOGY = 2.3         # typical Kp in a declining solar-cycle October
P_ACT_CAP = 0.9              # even inside the oval, a display is never certain
MOON_PENALTY = 0.35          # full moon high in the sky washes out faint aurora
RATINGS = [(0.40, "GOOD"), (0.25, "FAIR"), (0.10, "LOW"), (0.0, "POOR")]
MAX_HISTORY_RUNS = 400
MET_MAX_LEAD = 2.6           # days; MET Norway's hourly high-resolution part reaches ~60 h

MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}

status = {}


def source(name):
    """Decorator: run a fetcher, record ok/error in `status`, never crash the pipeline."""
    def wrap(fn):
        def inner(*a, **kw):
            try:
                res = fn(*a, **kw)
                status.setdefault(name, {"ok": True})  # keep an earlier failure visible
                return res
            except Exception as e:
                traceback.print_exc()
                status[name] = {"ok": False, "error": str(e)[:200]}
                return None
        return inner
    return wrap


# ---------------------------------------------------------------- space weather

@source("noaa_kp_3day")
def fetch_kp_3day():
    rows = http_get_json(f"{SWPC}/products/noaa-planetary-k-index-forecast.json")
    out = []
    for r in rows:
        if isinstance(r, list):  # legacy array-of-arrays format
            if r[0] == "time_tag":
                continue
            r = {"time_tag": r[0], "kp": r[1], "observed": r[2]}
        out.append({"t": iso(parse_utc(r["time_tag"] + ("" if r["time_tag"].endswith("Z") else "Z"))),
                    "kp": float(r["kp"]), "kind": r.get("observed")})
    return out


@source("noaa_27day")
def fetch_27day():
    txt = http_get(f"{SWPC}/text/27-day-outlook.txt")
    issued = re.search(r":Issued:\s*(.+)", txt)
    days = []
    for m in re.finditer(r"^(\d{4})\s+(\w{3})\s+(\d{2})\s+(\d+)\s+(\d+)\s+(\d+)\s*$", txt, re.M):
        d = datetime(int(m.group(1)), MONTHS[m.group(2)], int(m.group(3))).date()
        days.append({"date": d.isoformat(), "f107": int(m.group(4)), "ap": int(m.group(5)), "kp": int(m.group(6))})
    return {"issued": issued.group(1).strip() if issued else None, "days": days}


def _clean(txt):
    txt = re.sub(r"<[^>]+>", "", txt)
    return re.sub(r"\s+", " ", txt).strip()


@source("noaa_weekly")
def fetch_weekly():
    txt = http_get(f"{SWPC}/text/weekly.txt")
    issued = re.search(r":Issued:\s*(.+)", txt)
    fc = txt.split("Forecast of Solar and Geomagnetic Activity", 1)
    geo = None
    period = None
    if len(fc) == 2:
        body = fc[1]
        period = _clean(body.strip().split("\n", 1)[0])
        paras = [_clean(p) for p in re.split(r"\n\s*\n", body)]
        geo = next((p for p in paras if p.startswith("Geomagnetic field activity")), None)
    return {"issued": issued.group(1).strip() if issued else None, "period": period, "geomagnetic": geo}


@source("noaa_3day_text")
def fetch_3day_text():
    txt = http_get(f"{SWPC}/text/3-day-forecast.txt")
    sec = txt.split("B. NOAA Solar Radiation", 1)[0]
    m = re.search(r"Rationale:(.*?)(?:\n\s*\n|$)", sec, re.S)
    g = re.search(r"The greatest expected 3 hr Kp for (.*?)\.(?:\s|$)", sec.replace("\n", " "))
    return {"rationale": _clean(m.group(1)) if m else None,
            "summary": _clean("The greatest expected 3 hr Kp for " + g.group(1)) if g else None}


@source("noaa_daily_indices")
def fetch_daily_indices():
    txt = http_get(f"{SWPC}/text/daily-geomagnetic-indices.txt")
    out = {}
    for line in txt.splitlines():
        m = re.match(r"^(\d{4}) (\d{2}) (\d{2})\s", line)
        if not m:
            continue
        nums = re.findall(r"-?\d+\.\d+", line)  # planetary Kp values are the only decimals
        kps = [float(x) for x in nums if float(x) >= 0]
        if kps:
            out[f"{m.group(1)}-{m.group(2)}-{m.group(3)}"] = {"max": max(kps), "values": kps}
    return out


@source("nasa_donki_cme")
def fetch_cmes(now):
    start = (now - timedelta(days=7)).date().isoformat()
    end = now.date().isoformat()
    sims = http_get_json(f"https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/WSAEnlilSimulations?startDate={start}&endDate={end}")
    best = {}
    for s in sims or []:
        arr = s.get("estimatedShockArrivalTime")
        if not arr:
            continue
        t = parse_utc(arr)
        if t < now - timedelta(days=1):
            continue
        kps = [s.get(k) for k in ("kp_18", "kp_90", "kp_135", "kp_180") if s.get(k) is not None]
        key = t.strftime("%Y-%m-%dT%H")
        best[key] = {"arrival": iso(t), "glancing": bool(s.get("isEarthGB")),
                     "kp_min": min(kps) if kps else None, "kp_max": max(kps) if kps else None,
                     "link": s.get("link")}
    return sorted(best.values(), key=lambda c: c["arrival"])


# ---------------------------------------------------------------- clouds

@source("open_meteo_ensemble")
def fetch_ensemble(points, d):
    """points: list of (lat, lon). Returns list of hourly dicts per point: {iso_hour: {member: value}}."""
    lats = ",".join(f"{p[0]:.2f}" for p in points)
    lons = ",".join(f"{p[1]:.2f}" for p in points)
    nd = d + timedelta(days=1)
    url = ("https://ensemble-api.open-meteo.com/v1/ensemble"
           f"?latitude={lats}&longitude={lons}&hourly=cloud_cover&models=ecmwf_ifs025,gfs05"
           f"&start_date={d.isoformat()}&end_date={nd.isoformat()}&timezone=GMT")
    res = http_get_json(url, timeout=90)
    if isinstance(res, dict):
        res = [res]
    out = []
    for loc in res:
        h = loc["hourly"]
        members = [k for k in h if k.startswith("cloud_cover")]
        per_hour = {}
        for i, t in enumerate(h["time"]):
            vals = {k: h[k][i] for k in members if h[k][i] is not None}
            if vals:
                per_hour[t + ":00Z" if len(t) == 16 else t] = vals
        out.append(per_hour)
    return out


@source("met_norway")
def fetch_met(lat, lon):
    """MET Norway locationforecast: hourly cloud cover for the high-resolution (~60 h) part only."""
    js = http_get_json(f"https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={lat:.2f}&lon={lon:.2f}")
    ts = js["properties"]["timeseries"]
    out = {}
    for a, b in zip(ts, ts[1:]):
        ta, tb = parse_utc(a["time"]), parse_utc(b["time"])
        if tb - ta != timedelta(hours=1):
            break  # beyond this point the series is 6-hourly global-model data
        out[iso(ta)] = a["data"]["instant"]["details"].get("cloud_area_fraction")
    return out


def met_weight(lead_days):
    """Weight of the high-resolution MET Norway model in the clear-sky chance."""
    if lead_days <= 0.5:
        return 0.7  # the night itself: the local 2.5 km model is the best source we have
    if lead_days <= 1:
        return 0.5
    if lead_days <= 2:
        return 0.3
    return 0.15


def ens_weight(lead_days):
    """How much to trust the ensemble vs. climatology at a given lead time."""
    if lead_days <= 4:
        return 1.0
    if lead_days <= 10:
        return 1.0 - 0.4 * (lead_days - 4) / 6
    if lead_days <= 15:
        return 0.6 - 0.3 * (lead_days - 10) / 5
    return max(0.15, 0.3 - 0.15 * (lead_days - 15) / 15)


def percentile(vals, q):
    s = sorted(vals)
    if not s:
        return None
    k = (len(s) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


# ---------------------------------------------------------------- scoring

def kp_for_hour(h, kp3_map, kp27_map, daily, cmes):
    block = h.replace(hour=h.hour - h.hour % 3, minute=0, second=0)
    b = kp3_map.get(iso(block))
    if b is not None:
        kind = b["kind"]
        sigma = 0.6 if kind in ("observed", "estimated") else 1.0
        kp, src = b["kp"], f"NOAA 3-day ({kind})"
    elif h.date().isoformat() in kp27_map:
        kp, sigma, src = kp27_map[h.date().isoformat()] - 0.5, 1.4, "NOAA 27-day outlook"
    else:
        rec = daily.get((h - timedelta(days=27)).date().isoformat())
        if rec:
            kp = 0.5 * (rec["max"] - 0.5) + 0.5 * KP_CLIMATOLOGY
            sigma, src = 1.7, "27-day recurrence"
        else:
            kp, sigma, src = KP_CLIMATOLOGY, 1.8, "climatology"
    for c in cmes:
        dt = abs((parse_utc(c["arrival"]) - h).total_seconds()) / 3600
        if dt <= 12 and c.get("kp_max"):
            if c["kp_max"] > kp:
                kp, sigma, src = float(c["kp_max"]), 1.5, "NASA CME model"
    return kp, sigma, src


def rating(score):
    return next(r for thr, r in RATINGS if score >= thr)


def confidence(lead_days):
    if lead_days <= 1:
        return "High"
    if lead_days <= 3:
        return "Medium"
    if lead_days <= 10:
        return "Low"
    return "Trend only"


def local_hm(t):
    return (t + timedelta(hours=SHIP_UTC_OFFSET)).strftime("%H:%M")


def sun_crossing(route, t0, t1, alt, rising):
    """First time in [t0, t1] the sun at the ship's position crosses `alt` degrees (5-min scan + interpolation)."""
    def f(t):
        p = route.at(t)
        return sun_alt(t, p["lat"], p["lon"]) - alt
    step = timedelta(minutes=5)
    t, prev = t0, f(t0)
    while t < t1:
        tn = t + step
        cur = f(tn)
        if (rising and prev < 0 <= cur) or (not rising and prev > 0 >= cur):
            return t + step * (prev / (prev - cur))
        t, prev = tn, cur
    return None


def night_events(d, route):
    """Sunset, darkness, sunrise and ship arrivals/departures for the night starting on date d."""
    noon = datetime(d.year, d.month, d.day, 10, tzinfo=UTC)
    midnight = noon + timedelta(hours=14)
    morning = midnight + timedelta(hours=12)
    events = []
    for kind, label, t0, t1, alt, rising in (
            ("sunset", "Sunset", noon, midnight, -0.833, False),
            ("dark_start", "Dark from", noon, midnight, DARK_SUN, False),
            ("dark_end", "Dark until", midnight, morning, DARK_SUN, True),
            ("sunrise", "Sunrise", midnight, morning, -0.833, True)):
        t = sun_crossing(route, t0, t1, alt, rising)
        if t:
            events.append({"t": iso(t), "local": local_hm(t), "kind": kind, "label": label})
    first = parse_utc(events[0]["t"]) if events else noon
    last = parse_utc(events[-1]["t"]) if events else morning
    for st in route.stops:
        for key, verb in (("depart", "Ship departs"), ("arrive", "Ship arrives in")):
            if key in st and first <= parse_utc(st[key]) <= last:
                t = parse_utc(st[key])
                events.append({"t": iso(t), "local": local_hm(t), "kind": key, "label": f"{verb} {st['name']}"})
    return sorted(events, key=lambda e: e["t"])


def score_night(d, route, now, kp3_map, kp27_map, daily, cmes, clim):
    hours = night_hours(d)
    mid = datetime(d.year, d.month, d.day, 22, tzinfo=UTC)
    evening = datetime(d.year, d.month, d.day, 18, tzinfo=UTC)
    lead = (evening - now).total_seconds() / 86400

    # Sample the route at three times; each hour uses the nearest sample for clouds.
    sample_times = [datetime(d.year, d.month, d.day, 18, tzinfo=UTC), mid, mid + timedelta(hours=4)]
    sample_pos = [route.at(t) for t in sample_times]
    uniq = []
    for p in sample_pos:
        key = (round(p["lat"], 2), round(p["lon"], 2))
        if key not in uniq:
            uniq.append(key)
    ens = fetch_ensemble(uniq, d) if lead <= 34 else None
    met = [fetch_met(*p) or {} for p in uniq] if lead <= MET_MAX_LEAD else None

    rows = []
    for h in hours:
        pos = route.at(h)
        sa = sun_alt(h, pos["lat"], pos["lon"])
        ma = moon_alt(h, pos["lat"], pos["lon"])
        mi = moon_illum(h)
        ml = mag_lat(pos["lat"], pos["lon"])
        req = kp_required(ml)
        kp, sigma, src = kp_for_hour(h, kp3_map, kp27_map, daily, cmes)
        p_act = P_ACT_CAP * norm_cdf((kp - req) / sigma)
        nearest = min(range(3), key=lambda i: abs((sample_times[i] - h).total_seconds()))
        sp = sample_pos[nearest]
        idx = uniq.index((round(sp["lat"], 2), round(sp["lon"], 2)))
        members = (ens[idx].get(iso(h)) if ens and idx < len(ens) else None) or {}
        vals = list(members.values())
        rows.append({
            "t": iso(h), "local": local_hm(h), "lat": pos["lat"], "lon": pos["lon"], "place": pos["place"],
            "state": pos["state"], "light": pos["light"],
            "sun": round(sa, 1), "dark": sa <= DARK_SUN, "moon_alt": round(ma, 1), "moon_illum": round(mi, 2),
            "mlat": round(ml, 1), "kp_req": round(req, 1), "kp": round(kp, 2), "kp_src": src,
            "p_act": round(p_act, 3),
            "cloud_mean": round(sum(vals) / len(vals), 1) if vals else None,
            "cloud_p10": round(percentile(vals, 0.1), 1) if vals else None,
            "cloud_p90": round(percentile(vals, 0.9), 1) if vals else None,
            "cloud_met": (round(met[idx][iso(h)], 1) if met and idx < len(met)
                          and met[idx].get(iso(h)) is not None else None),
            "_p_ens_h": sum(v <= CLEAR_MAX for v in vals) / len(vals) if vals else None,
            "_members": members,
        })

    dark = [r for r in rows if r["dark"]]
    mid_pos = route.at(mid)
    c = clim.get(d.isoformat(), {})
    p_clim = c.get("p_clear") if c.get("p_clear") is not None else 0.3

    # Ensemble probability of a clear window during darkness.
    member_keys = set()
    for r in dark:
        member_keys.update(r["_members"].keys())
    n_ok = n_clear = 0
    for k in member_keys:
        series = [r["_members"].get(k) for r in dark]
        if sum(v is not None for v in series) < 0.8 * len(series):
            continue
        n_ok += 1
        n_clear += clear_window(series)
    p_ens = n_clear / n_ok if n_ok else None
    models = sorted({"ECMWF" if "ecmwf" in k else "GFS" for k in member_keys})
    w = ens_weight(lead) if p_ens is not None else 0.0
    p_clear = w * (p_ens or 0) + (1 - w) * p_clim

    # Hourly clear-sky chance (cloud <= 40%): same ensemble/climate blend as the nightly value.
    p_clim_h = c.get("p_clear_hour") if c.get("p_clear_hour") is not None else 0.15
    for r in rows:
        pe = r.pop("_p_ens_h")
        r["p_clear_h"] = round(w * pe + (1 - w) * p_clim_h, 3) if pe is not None and w > 0 else round(p_clim_h, 3)

    # High-resolution MET Norway run (only the last ~2.5 days): a single deterministic
    # forecast, so it gets a vote rather than the final word.
    p_met = w_met = met_note = None
    met_vals = [r["cloud_met"] for r in dark]
    if dark and sum(v is not None for v in met_vals) >= 0.8 * len(dark):
        start = next((dark[i]["local"] for i in range(len(dark) - 1)
                      if all(v is not None and v <= CLEAR_MAX for v in met_vals[i:i + 2])), None)
        if start:
            p_met, met_note = 0.9, f"clear gap from {start}"
        elif clear_window(met_vals, limit=70):
            p_met, met_note = 0.35, "only partly clear"
        else:
            p_met, met_note = 0.05, "no clear gap"
        w_met = met_weight(lead)
        p_clear = w_met * p_met + (1 - w_met) * p_clear

    # The same MET vote per hour, so the hourly bar (and the verdict built on it) agrees with the night.
    for r in rows:
        m = r["cloud_met"]
        if m is not None:
            p_met_h = 0.9 if m <= CLEAR_MAX else 0.35 if m <= 70 else 0.05
            wm = met_weight(lead)
            r["p_clear_h"] = round(wm * p_met_h + (1 - wm) * r["p_clear_h"], 3)

    best = max(dark, key=lambda r: r["p_act"]) if dark else None
    p_act = best["p_act"] if best else 0.0
    dark_f = min(1.0, len(dark) / 4)
    moon_pen = (sum(r["moon_illum"] for r in dark if r["moon_alt"] > 0) / len(dark)) if dark else 0
    light = (sum(r["light"] for r in dark) / len(dark)) if dark else 1.0
    ml_f = (1 - MOON_PENALTY * moon_pen) * light
    score = p_act * p_clear * dark_f * ml_f
    dark_cloud = [r["cloud_mean"] for r in dark if r["cloud_mean"] is not None]

    notes = []
    if best:
        if best["kp_req"] <= 1.5:
            notes.append("Inside the auroral zone: even quiet activity can light up the sky here.")
        elif best["kp_req"] <= 4:
            notes.append(f"Needs moderate activity (about Kp {best['kp_req']:.0f}+) to be visible this far south.")
        else:
            notes.append(f"Needs a geomagnetic storm (about Kp {best['kp_req']:.0f}+) — only a strong event reaches here.")
    if p_clear < 0.3:
        notes.append("Clouds are the main risk tonight.")
    if mid_pos["state"] == "port" and light < 0.9:
        notes.append("Docked near town lights — the darkest spot is the sea-facing side of the top deck.")
    if moon_pen > 0.3:
        notes.append("Bright moon for part of the night; faint aurora will be harder to see.")

    for r in rows:
        r.pop("_members", None)

    # Label the night by where the ship spends its dark hours (e.g. "Alta → at sea").
    place = mid_pos["place"]
    if dark and dark[0]["state"] != dark[-1]["state"]:
        a, b = dark[0], dark[-1]
        if a["state"] == "port":
            stop = next(s for s in route.stops if s["name"] == a["place"] and "depart" in s)
            place = f"{a['place']} → at sea (departs {local_hm(parse_utc(stop['depart']))})"
        else:
            place = f"At sea → {b['place']}"
    return {
        "date": d.isoformat(),
        "label": d.strftime("%a %d %b"),
        "place": place, "state": mid_pos["state"],
        "lat": mid_pos["lat"], "lon": mid_pos["lon"],
        "mlat": round(mag_lat(mid_pos["lat"], mid_pos["lon"]), 1),
        "kp_req": round(kp_required(mag_lat(mid_pos["lat"], mid_pos["lon"])), 1),
        "lead_days": round(lead, 2),
        "dark": {"hours": len(dark), "start": dark[0]["local"] if dark else None,
                 "end": local_hm(parse_utc(dark[-1]["t"]) + timedelta(hours=1)) if dark else None},
        "moon": {"illum": round(sum(r["moon_illum"] for r in rows) / len(rows), 2),
                 "up_frac_dark": round(sum(r["moon_alt"] > 0 for r in dark) / len(dark), 2) if dark else 0},
        "activity": {"p": round(p_act, 3), "kp": best["kp"] if best else None,
                     "kp_src": best["kp_src"] if best else None, "best_local": best["local"] if best else None},
        "clear": {"p": round(p_clear, 3), "p_ens": round(p_ens, 3) if p_ens is not None else None,
                  "p_clim": round(p_clim, 3), "weight": round(w, 2), "members": n_ok, "models": models,
                  "p_met": p_met, "w_met": w_met, "met_note": met_note,
                  "mean_cloud_dark": round(sum(dark_cloud) / len(dark_cloud), 1) if dark_cloud else None,
                  "clim_mean_cloud": c.get("mean_cloud")},
        "factors": {"activity": round(p_act, 3), "clear": round(p_clear, 3),
                    "darkness": round(dark_f, 3), "moon_lights": round(ml_f, 3)},
        "score": round(score, 3), "rating": rating(score), "confidence": confidence(lead),
        "notes": notes,
        "events": night_events(d, route),
        "hourly": rows,
    }


# ---------------------------------------------------------------- model check

class FixedRoute:
    """A 'route' that never moves: used to run tonight's forecast for a fixed town."""

    def __init__(self, name, lat, lon, light):
        self.stops = []
        self.pos = {"lat": lat, "lon": lon, "state": "port", "place": name, "light": light}

    def at(self, t):
        return dict(self.pos)


CHECK_SPOTS = [  # name, lat, lon, town-light factor, cruise night whose October climate is used
    ("Tromsø", 69.65, 18.96, 0.85, "2026-10-15"),
    ("Alta", 69.98, 23.25, 0.95, "2026-10-16"),
]


def model_check(now, kp3_map, kp27_map, daily, cmes, clim):
    """Tonight's forecast for Tromsø and Alta with exactly the cruise model, to compare with other apps."""
    local = now + timedelta(hours=SHIP_UTC_OFFSET)
    d = (local - timedelta(days=1) if local.hour < 6 else local).date()
    nights = []
    for name, lat, lon, light, clim_night in CHECK_SPOTS:
        n = score_night(d, FixedRoute(name, lat, lon, light), now, kp3_map, kp27_map, daily, cmes,
                        {d.isoformat(): clim.get(clim_night, {})})
        n["spot"] = name
        nights.append(n)
    return {"date": d.isoformat(), "nights": nights,
            "note": "Tonight at a fixed spot, same model and code as the cruise nights. "
                    "Background climate: October at the same place."}


# ---------------------------------------------------------------- main

def main():
    now = utcnow()
    it = load_json(CONFIG / "itinerary.json")
    route = Route(it)
    clim = (load_json(DATA / "climatology.json", {}) or {}).get("nights", {})

    kp3 = fetch_kp_3day() or []
    kp27 = fetch_27day() or {"issued": None, "days": []}
    weekly = fetch_weekly() or {}
    three = fetch_3day_text() or {}
    daily = fetch_daily_indices() or {}
    cmes = fetch_cmes(now) or []

    kp3_map = {r["t"]: r for r in kp3}
    kp27_map = {r["date"]: r["kp"] for r in kp27["days"]}

    nights = [score_night(d, route, now, kp3_map, kp27_map, daily, cmes, clim) for d in night_dates(it)]

    # Hourly route for the live view.
    t = route.start - timedelta(hours=1)
    route_hourly = []
    while t <= route.end + timedelta(hours=1):
        p = route.at(t)
        route_hourly.append([iso(t), p["lat"], p["lon"], p["state"], p["place"]])
        t += timedelta(hours=1)

    recurrence = []
    for n in nights:
        src = (datetime.fromisoformat(n["date"]) - timedelta(days=27)).date().isoformat()
        rec = daily.get(src)
        recurrence.append({"night": n["date"], "source_date": src, "kp_max": rec["max"] if rec else None})

    latest = {
        "generated": iso(now),
        "ship_utc_offset": SHIP_UTC_OFFSET,
        "trip": {"ship": it["ship"], "title": it["title"], "start": iso(route.start), "end": iso(route.end),
                 "stops": it["stops"]},
        "method": {
            "score": "activity × clear sky × darkness × moon & lights",
            "clear_definition": f"at least 2 consecutive dark hours with cloud cover ≤ {CLEAR_MAX}%",
            "dark_definition": f"sun below {DARK_SUN}°",
            "ratings": {r: thr for thr, r in RATINGS},
        },
        "space_weather": {
            "kp_3day": kp3,
            "kp_27day": kp27,
            "weekly": weekly,
            "three_day": three,
            "observed_daily": [{"date": k, "kp_max": v["max"]} for k, v in sorted(daily.items())],
            "recurrence": recurrence,
            "cmes": cmes,
        },
        "nights": nights,
        "model_check": model_check(now, kp3_map, kp27_map, daily, cmes, clim),
        "route_hourly": route_hourly,
        "sources": status,
    }
    save_json(DATA / "latest.json", latest, compact=True)

    hist = load_json(DATA / "history.json", {"runs": []})
    hist["runs"].append({"t": iso(now), "nights": {
        n["date"]: [n["score"], n["factors"]["activity"], n["factors"]["clear"]] for n in nights}})
    hist["runs"] = hist["runs"][-MAX_HISTORY_RUNS:]
    save_json(DATA / "history.json", hist, compact=True)

    bad = [k for k, v in status.items() if not v["ok"]]
    print("done", iso(now), "sources failing:", bad or "none")
    for n in nights:
        print(n["date"], n["place"][:34].ljust(34), f"act {n['factors']['activity']:.2f}",
              f"clear {n['factors']['clear']:.2f} (ens {n['clear']['p_ens']}, w {n['clear']['weight']})",
              f"score {n['score']:.2f} {n['rating']}")


if __name__ == "__main__":
    main()
