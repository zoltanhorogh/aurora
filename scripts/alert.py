"""Real-time aurora alerts via ntfy push notifications.

Runs from GitHub Actions, scheduled every 10 minutes (in practice every 15-30: GitHub's schedule is best-effort).
Before the cruise ("test season") it watches all Norwegian ports at once and sends "🧪 TEST" alerts when
activity would be good enough at any of them in the dark, with each port's clouds in the message
(max 2 per night), so the thresholds can be judged before the trip.
During the cruise it sends:
  * an evening briefing (once per day, ~17-19h ship time) with tonight's outlook;
  * a "go outside" alert when live activity is good AND the sky at the ship is clear AND it is dark;
    near Tromsø and Alta also when a nearby magnetometer shows a substorm (the fastest sign, minutes before
    Hp30 shows it: Masi -102 nT in 10 min at 22:49 on 1 Oct 2026, aurora seen along the coast right after).
Under clouds a quieter "look for gaps" message instead.
Before and during the cruise, day or night: a "☄️ CME arrived" message when the solar wind at the L1 satellite
jumps (a CME's shock front), 40-85 minutes before it reaches Earth (1.5 million km at its speed);
in the dark a "🚪 door open" message when the solar wind's field is strong and turns south (a stream front);
a "📷 aurora on the camera" message when an all-sky camera near Tromsø (the practice spot / the ship in port) sees it; data/shock.json keeps it for the page.

Usage:
  python alert.py            normal run (needs NTFY_TOPIC env var)
  python alert.py --test     send a test notification with the current live readings
  python alert.py --dry-run  print what would be sent, send nothing
  python alert.py --now 2026-10-15T21:00:00Z --dry-run   simulate a moment of the trip
"""
import argparse
import json
import os
import urllib.request
from datetime import datetime, timedelta

from common import (CONFIG, DATA, UA, Route, fetch_hp30, haversine_km, http_get_json, iso, kp_required,
                    load_json, mag_lat, parse_utc, save_json, sun_alt, utcnow)
from update import tonight_answer

DASHBOARD = "https://zoltanhorogh.github.io/aurora/"
SWPC = "https://services.swpc.noaa.gov"
SHIP_UTC_OFFSET = 2

SUN_MAX = -10            # sun must be at least this far below the horizon
CLOUD_MAX = 40           # model cloud cover at the ship, %
OVATION_LOCAL_MIN = 20   # NOAA OVATION probability overhead
OVATION_NORTH_MIN = 40   # ... or strong oval within view to the north
BZ_SOUTH = -5            # nT, 30-min mean
COOLDOWN_MIN = 90
BRIEFING_HOURS = (17, 19)
MAG_STRONG_SWING = 200   # nT, last-hour swing at a nearby FMI magnetometer
MAG_STRONG_DROP = -100   # nT within 10 minutes
MAG_STRONG_LOW = -200    # nT below the station's quiet level
MAG_ACTIVE = 50          # nT: 50+ below the quiet level, or a 50+ change within 10 min either way (the page's substorm rule)
MAG_WINDOW_MIN = 35      # minutes looked back: the workflow is due every 10 min but GitHub runs it every 15-30
                         # (18-29 min apart on 2 Oct 2026); a substorm moment already alerted is not alerted again
MAG_COOLDOWN_MIN = 30    # on board a new substorm may alert again after 30 min (other alerts: COOLDOWN_MIN)
CLOUDY_REPEAT_MIN = 120  # the "cloudy, look for gaps" message again after 2 h when a new substorm shows ...
CLOUDY_REPEAT_STRONG_MIN = 60  # ... and after 1 h while it is strong: on 3-4 and 4-5 Oct 2026 the cameras saw aurora
                               # through gaps for hours under a forecast of 99-100% cloud
MAG_NEAR_KM = 300
TEST_MAX_PER_NIGHT = 2
TEST_MAX_PER_NIGHT_STRONG = 5  # strong activity: more test alerts (4-5 Oct 2026: aurora at 23 and 02-05 h went unannounced)
SHOCK_DV = 20            # km/s: solar wind speed jump (median of 10 min after vs 20 min before, 5 min apart)
SHOCK_N = 1.8            # density ratio after/before
SHOCK_B = 1.3            # Bt ratio after/before
SHOCK_LOOK_MIN = 90      # minutes of 1-minute data searched each run (runs are 15-30 min apart)
DOOR_BT = 10             # nT: 15-minute mean field strength at L1 ...
DOOR_BZ = -5             # nT: ... and 15-minute mean Bz south of this = the door is open
DOOR_MIN = 15
DOOR_REARM_MIN = 60      # closed this long before a new opening counts
DOOR_COOLDOWN_MIN = 180  # at most one door alert per 3 hours

_RTSW = {}  # NOAA's real-time solar wind files, fetched once per run


def rtsw(name):
    if name not in _RTSW:
        _RTSW[name] = http_get_json(f"{SWPC}/json/rtsw/rtsw_{name}_1m.json")
    return _RTSW[name]


def global_readings():
    """Readings that are the same everywhere: Hp30, solar wind, the OVATION grid. (No NOAA 1-minute Kp: it drops
    to ~0 at the start of every 3-hour block, e.g. 0.0 while Hp30 was 2.0 on 1 Oct 2026.)"""
    out = {}
    try:
        # Half-hourly planetary activity: reacts to substorms faster than the 3-hourly Kp.
        hp = fetch_hp30(utcnow() - timedelta(hours=24), utcnow())
        out["hp30_series"] = [[iso(t), v] for t, v in hp]
        if hp and utcnow() - hp[-1][0] <= timedelta(minutes=90):
            out["hp30"] = hp[-1][1]
    except Exception as e:
        out["hp30_error"] = str(e)
    try:
        mag = rtsw("mag")
        cutoff = utcnow() - timedelta(minutes=30)
        bz = [m["bz_gsm"] for m in mag if m.get("active") and m.get("bz_gsm") is not None
              and parse_utc(m["time_tag"] + "Z") >= cutoff]
        if bz:
            out["bz30"] = round(sum(bz) / len(bz), 1)
            out["bz_min"] = round(min(bz), 1)
    except Exception as e:
        out["bz_error"] = str(e)
    try:
        wind = rtsw("wind")
        cutoff = utcnow() - timedelta(minutes=30)
        v = [w["proton_speed"] for w in wind if w.get("active") and w.get("proton_speed") is not None
             and parse_utc(w["time_tag"] + "Z") >= cutoff]
        if v:
            out["speed"] = round(sum(v) / len(v))
    except Exception as e:
        out["speed_error"] = str(e)
    try:
        out["ovation_grid"] = http_get_json(f"{SWPC}/json/ovation_aurora_latest.json")["coordinates"]
    except Exception as e:
        out["ovation_error"] = str(e)
    return out


def solar_wind_rows():
    """1-minute speed, density and Bt of the active L1 satellite, joined by minute."""
    rows = {}
    for r in rtsw("wind"):
        if r.get("active") and r.get("proton_speed") is not None and r.get("proton_density") is not None:
            rows.setdefault(r["time_tag"][:16], {}).update(t=r["time_tag"][:16], v=r["proton_speed"], n=r["proton_density"],
                                                         src=r.get("source"))
    for r in rtsw("mag"):
        if r.get("active") and r.get("bt") is not None:
            rows.setdefault(r["time_tag"][:16], {}).update(bt=r["bt"])
    return [x for _, x in sorted(rows.items()) if "v" in x and "bt" in x]


def wind_jumps(rows):
    """Sudden jumps of the solar wind at the L1 satellite: a CME's shock front arriving. The median of the 10 minutes
    after a moment against the 20 minutes before it (with 5 minutes left out): speed +20 km/s, density x1.8 and Bt
    x1.3 together, the same satellite before and after. On 3 Oct 2026 (the weak CME of 28 Sep) it finds the one jump
    of that day: 01:28 UTC, 272 -> 302 km/s, density 2.8 -> 15, Bt 3.7 -> 5.8 nT."""
    def med(xs):
        s = sorted(xs)
        return s[len(s) // 2] if len(s) % 2 else (s[len(s) // 2 - 1] + s[len(s) // 2]) / 2
    tt = [parse_utc(x["t"] + ":00Z") for x in rows]
    out = []
    for i, t in enumerate(tt):
        pre = [rows[j] for j in range(len(rows)) if t - timedelta(minutes=25) <= tt[j] < t - timedelta(minutes=5)]
        post = [rows[j] for j in range(i, len(rows)) if tt[j] < t + timedelta(minutes=10)]
        if len(pre) < 8 or len(post) < 6 or {p["src"] for p in pre} != {p["src"] for p in post}:
            continue
        v1, n1, b1 = (med([p[k] for p in pre]) for k in ("v", "n", "bt"))
        v2, n2, b2 = (med([p[k] for p in post]) for k in ("v", "n", "bt"))
        if v2 - v1 < SHOCK_DV or n2 < SHOCK_N * n1 or b2 < SHOCK_B * b1:
            continue
        if out and t - parse_utc(out[-1]["at"]) <= timedelta(minutes=60):
            continue  # the same front, found again from the next minute
        # the moment of the jump: the first minute after which density or field has jumped
        at = next((tt[j] for j in range(i, len(rows)) if rows[j]["n"] >= SHOCK_N * n1 or rows[j]["bt"] >= SHOCK_B * b1), t)
        level = "strong" if b2 >= 15 or v2 >= 600 else "moderate" if b2 >= 10 or v2 >= 450 else "weak"
        out.append({"at": iso(at), "level": level, "src": post[0]["src"],
                    "before": {"v": round(v1), "n": round(n1, 1), "bt": round(b1, 1)},
                    "after": {"v": round(v2), "n": round(n2, 1), "bt": round(b2, 1)}})
    return out


def travel_min(v):
    """Minutes the solar wind needs from L1 (1.5 million km) to Earth at v km/s, to 5 minutes (300 km/s: 85)."""
    return max(5, round(1.5e6 / max(v, 200) / 60 / 5) * 5)


def door_events(rows):
    """Moments the door opens: rows [(t, bt, bz)] of 1-minute L1 field data; the 15-minute means reach Bt >= 10 nT and
    Bz <= -5 nT after the door was closed for an hour. Night of 3-4 Oct 2026 (the CH 98 stream front, Bt 6 -> 20 nT):
    one opening, 01:05 UTC (Bt 15, Bz -5); the substorm followed at 02:31 UTC (Masi -87 nT, Hp30 4.0)."""
    out, is_open, closed = [], False, None
    for t, _, _ in rows:
        w = [r for r in rows if t - timedelta(minutes=DOOR_MIN) < r[0] <= t]
        if len(w) < DOOR_MIN * 0.7:
            continue
        bt, bz = sum(r[1] for r in w) / len(w), sum(r[2] for r in w) / len(w)
        if bt >= DOOR_BT and bz <= DOOR_BZ:
            if not is_open and (closed is None or t - closed >= timedelta(minutes=DOOR_REARM_MIN)):
                out.append({"at": iso(t), "bt": round(bt, 1), "bz": round(bz, 1)})
            is_open = True
        elif is_open:
            is_open, closed = False, t
    return out


def door_message(e, test=False):
    when = (parse_utc(e["at"]) + timedelta(hours=SHIP_UTC_OFFSET)).strftime("%H:%M")
    title = ("🧪 TEST · " if test else "") + "🚪 Door open: aurora likely within the hour"
    msg = (f"{when} ship time: the solar wind's magnetic field is strong (Bt {e['bt']:.0f} nT) and has turned south "
           f"(Bz {e['bz']:+.0f} nT for 15+ min). This is what feeds the aurora: it usually brightens within the hour, often "
           f"with a substorm. Look north if the sky is clear; watch Live.")
    return title, msg


def door_check(now, dry, test, lat, lon):
    """Once per opening (at most every 3 hours), only in the dark at `lat, lon` (Tromsø before the cruise, the ship
    on board): in daylight nothing is sent and the opening still counts later if the door stays open."""
    if sun_alt(now, lat, lon) > -6:
        return
    try:
        rows = sorted((parse_utc(r["time_tag"] + "Z"), r["bt"], r["bz_gsm"]) for r in rtsw("mag")
                      if r.get("active") and r.get("bt") is not None and r.get("bz_gsm") is not None)
    except Exception as e:  # the other alerts must still run
        print("door check failed:", e)
        return
    rows = [r for r in rows if r[0] >= now - timedelta(minutes=90)]
    if not rows or now - rows[-1][0] > timedelta(minutes=20):
        return  # no fresh data
    recent = [e for e in door_events(rows) if parse_utc(e["at"]) >= now - timedelta(minutes=40)]
    state = load_json(DATA / "alert_state.json", {}) or {}
    last = (state.get("door") or {}).get("at")
    if not recent or (last and now - parse_utc(last) < timedelta(minutes=DOOR_COOLDOWN_MIN)):
        return
    e = recent[-1]
    title, msg = door_message(e, test)
    send(title, msg, priority=4, tags=["door"], dry=dry, click=DASHBOARD + "#live")
    if not dry:
        state["door"] = {"at": iso(now), "open": e["at"], "bt": e["bt"], "bz": e["bz"]}
        save_json(DATA / "alert_state.json", state)


CAM_SITES = {"tromso": ("Tromsø", 69.65, 18.96), "skibotn": ("Skibotn", 69.35, 20.36), "kiruna": ("Kiruna", 67.84, 20.41)}
CAM_NEAR_KM = 60          # the camera must be this close to the ship (the page's "own camera" rule)
CAM_COOLDOWN_MIN = 60


def camera_message(name, s, others, test=False):
    when = (parse_utc(s["t"]) + timedelta(hours=SHIP_UTC_OFFSET)).strftime("%H:%M")
    title = ("🧪 TEST · " if test else "") + f"📷 Aurora on the {name} camera right now"
    also = f" Also on the {', '.join(others)} camera." if others else ""
    msg = (f"{when} ship time: the all-sky camera at {name} shows aurora (AI {s['aurora']}% sure), so the sky is open there "
           f"now.{also} Look north, away from lights.")
    return title, msg


def camera_check(now, dry, test, lat, lon):
    """Aurora on an all-sky camera within 60 km (data/sky_now.json, written just before by sky_log.py): the one sign
    that the aurora is there AND the sky is open. On 5-6 Oct 2026 the Tromsø camera saw it 19-21 and 23-02 h under a
    forecast of 100% cloud. Tromsø while practising, on board the Tromsø port night; at most every 60 minutes."""
    sites = (load_json(DATA / "sky_now.json", {}) or {}).get("sites") or {}
    seen = {k: s for k, s in sites.items() if k in CAM_SITES and s.get("aurora", 0) >= 50
            and now - parse_utc(s["t"]) <= timedelta(minutes=20)}
    near = [k for k in seen if haversine_km((lat, lon), CAM_SITES[k][1:]) <= CAM_NEAR_KM]
    if not near:
        return
    state = load_json(DATA / "alert_state.json", {}) or {}
    last = (state.get("camera") or {}).get("at")
    if last and now - parse_utc(last) < timedelta(minutes=CAM_COOLDOWN_MIN):
        return
    site = near[0]
    title, msg = camera_message(CAM_SITES[site][0], seen[site], [CAM_SITES[k][0] for k in seen if k != site], test)
    send(title, msg, priority=4 if test else 5, tags=["camera"], dry=dry, click=DASHBOARD + "#cams")
    if not dry:
        state["camera"] = {"at": iso(now), "site": site, "picture": seen[site]["t"]}
        save_json(DATA / "alert_state.json", state)


def shock_message(e, test=False):
    when = (parse_utc(e["at"]) + timedelta(hours=SHIP_UTC_OFFSET)).strftime("%H:%M")
    b, a = e["before"], e["after"]
    ratio = a["n"] / b["n"] if b["n"] else 0
    title = ("🧪 TEST · " if test else "") + ("☄️ CME arrived: strong jump" if e["level"] == "strong" else "☄️ CME arrived at the solar wind satellite")
    msg = (f"{when} ship time: solar wind {b['v']} → {a['v']} km/s, density ×{ratio:.0f}, Bt {b['bt']:.0f} → {a['bt']:.0f} nT "
           f"({e['level']} jump; storms usually bring 450+ km/s and Bt 10+). It reaches Earth in about {travel_min(a['v'])} minutes. "
           f"If Bz turns south (negative), the aurora brightens: watch Live.")
    return title, msg


def shock_check(now, dry, test):
    """Once per jump: an alert (day or night) and data/shock.json for the page."""
    try:
        rows = [x for x in solar_wind_rows() if parse_utc(x["t"] + ":00Z") >= now - timedelta(minutes=SHOCK_LOOK_MIN)]
    except Exception as e:  # the other alerts must still run
        print("solar wind jump check failed:", e)
        return
    data = load_json(DATA / "shock.json", {}) or {}
    known = data.get("events", [])
    new = [e for e in wind_jumps(rows)
           if all(abs(parse_utc(e["at"]) - parse_utc(k["at"])) > timedelta(minutes=60) for k in known)]
    if not new:
        return
    e = new[-1]
    title, msg = shock_message(e, test)
    send(title, msg, priority={"strong": 5, "moderate": 4}.get(e["level"], 3), tags=["comet"], dry=dry, click=DASHBOARD + "#space")
    if not dry:
        save_json(DATA / "shock.json", {"updated": iso(now), "events": (known + new)[-5:]})


def local_readings(g, lat, lon):
    """Readings for one place: OVATION overhead / to the north, and the cloud cover right now."""
    out = {}
    if g.get("ovation_grid"):
        lon360 = lon % 360
        local = north = 0
        for glon, glat, p in g["ovation_grid"]:
            dlon = min(abs(glon - lon360), 360 - abs(glon - lon360))
            if dlon <= 1 and abs(glat - lat) <= 1:
                local = max(local, p)
            if dlon <= 10 and lat <= glat <= lat + 8:
                north = max(north, p)
        out["ovation_local"] = local
        out["ovation_north"] = north
    try:
        # MET Norway's 2.5 km model is the best short-range cloud source along the Norwegian coast.
        met = http_get_json(f"https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={lat:.2f}&lon={lon:.2f}")
        hour = utcnow().replace(minute=0, second=0, microsecond=0)
        for t in met["properties"]["timeseries"]:
            if parse_utc(t["time"]) >= hour:
                out["cloud"] = round(t["data"]["instant"]["details"]["cloud_area_fraction"])
                out["cloud_src"] = "MET Norway"
                break
    except Exception as e:
        out["cloud_error"] = str(e)
    if "cloud" not in out:
        try:
            wx = http_get_json(f"https://api.open-meteo.com/v1/forecast?latitude={lat:.2f}&longitude={lon:.2f}"
                               "&current=cloud_cover&timezone=GMT")
            out["cloud"] = wx["current"]["cloud_cover"]
            out["cloud_src"] = "Open-Meteo"
        except Exception as e:
            out["cloud_error"] = str(e)
    return out


def live_readings(lat, lon):
    g = global_readings()
    return {**{k: v for k, v in g.items() if k != "ovation_grid"}, **local_readings(g, lat, lon)}


def judge(lv, req):
    """(activity good enough to go out, strong) for a place that needs Kp `req`; measured activity = Hp30."""
    bz, hp30 = lv.get("bz30", 0), lv.get("hp30", 0)
    ov_l, ov_n = lv.get("ovation_local", 0), lv.get("ovation_north", 0)
    activity_ok = (ov_l >= OVATION_LOCAL_MIN
                   or (ov_n >= OVATION_NORTH_MIN and hp30 >= req)
                   or (hp30 >= req + 1 and bz <= BZ_SOUTH)
                   or hp30 >= req + 1.5)
    strong = ov_l >= 50 or hp30 >= req + 3 or (bz <= -10 and lv.get("speed", 0) >= 500)
    return activity_ok, strong


def mag_event(lat, lon, now):
    """A substorm at the FMI magnetometers within MAG_NEAR_KM in the last MAG_WINDOW_MIN minutes (data/mag.json,
    written just before by mag_log.py: 1-minute values against each station's quiet level). Same rule as the page:
    a station 50+ nT below its quiet level, or a change of 50+ nT within 10 minutes either way; "strong" from a
    100 nT drop within 10 minutes, 200 nT below the quiet level or a 200 nT swing within an hour.
    Returns None or {"level": "strong" | "watch", "note": text, "at": time}."""
    mag = load_json(DATA / "mag.json", {}) or {}
    best = None
    for st in (mag.get("stations") or {}).values():
        if not st.get("series") or haversine_km((lat, lon), (st["lat"], st["lon"])) > MAG_NEAR_KM:
            continue
        s = st["series"]
        t0 = parse_utc(s["t0"])
        pts = [(t0 + timedelta(minutes=i * s["step_min"]), v) for i, v in enumerate(s["dev"]) if v is not None]
        pts = [p for p in pts if p[0] <= now]
        if not pts or now - pts[-1][0] > timedelta(minutes=MAG_WINDOW_MIN):
            continue  # no fresh data from this station
        hour = [v for t, v in pts if t > now - timedelta(minutes=60)]
        swing = max(hour) - min(hour)
        for i, (t, v) in enumerate(pts):
            if t <= now - timedelta(minutes=MAG_WINDOW_MIN):
                continue
            j = i
            while j > 0 and pts[j - 1][0] >= t - timedelta(minutes=10):
                j -= 1
            d10 = v - pts[j][1]
            if not (v <= -MAG_ACTIVE or abs(d10) >= MAG_ACTIVE or swing >= MAG_STRONG_SWING):
                continue
            strong = v <= MAG_STRONG_LOW or d10 <= MAG_STRONG_DROP or swing >= MAG_STRONG_SWING
            note = (f"magnetometer {st['name']} {d10:+d} nT in 10 min" if abs(d10) >= MAG_ACTIVE
                    else f"magnetometer {st['name']} {v:+d} nT vs its quiet level")
            if swing >= MAG_STRONG_SWING:
                note += f" / {swing} nT in 1 h"
            key = (strong, max(abs(d10), -v))
            if not best or key > best[0]:
                best = (key, {"level": "strong" if strong else "watch", "note": note, "at": iso(t)})
    return best[1] if best else None


def night_key(now):
    local = now + timedelta(hours=SHIP_UTC_OFFSET)
    return (local - timedelta(days=1) if local.hour < 12 else local).date().isoformat()


def test_season(now, route, dry):
    """Before the cruise: watch every Norwegian port, alert on activity anywhere (clouds only reported)."""
    stops, seen = [], set()
    for st in route.stops[1:-1]:
        if st["name"] not in seen:
            seen.add(st["name"])
            stops.append(st)
    dark = [st for st in stops if sun_alt(now, st["lat"], st["lon"]) <= SUN_MAX]
    if not dark:
        print("test season: no port is dark yet")
        return
    g = global_readings()
    hits = []
    for st in dark:
        req = kp_required(mag_lat(st["lat"], st["lon"]))
        lv = {**{k: v for k, v in g.items() if k != "ovation_grid"}, **local_readings(g, st["lat"], st["lon"])}
        ok, strong = judge(lv, req)
        m = mag_event(st["lat"], st["lon"], now)  # the same rule as on board
        mag_note = ""
        if m:
            ok = True
            strong = strong or m["level"] == "strong"
            mag_note = f", {m['note']}"
        print(f"test {st['name']}: req {req:.1f} ok={ok} strong={strong} cloud={lv.get('cloud')}{mag_note}")
        if ok:
            hits.append((st, req, lv, strong, mag_note))
    if not hits:
        return

    state = load_json(DATA / "alert_state.json", {}) or {}
    t = state.get("test") or {}
    night = night_key(now)
    if t.get("night") != night:
        t = {"night": night, "count": 0}
    level = "strong" if any(h[3] for h in hits) else "watch"
    last = parse_utc(t["last_alert"]) if t.get("last_alert") else None
    cooling = last and (now - last) < timedelta(minutes=COOLDOWN_MIN)
    escalation = level == "strong" and t.get("last_level") == "watch"
    if t["count"] >= (TEST_MAX_PER_NIGHT_STRONG if level == "strong" else TEST_MAX_PER_NIGHT) or (cooling and not escalation):
        print("test season: alert suppressed (limit / cooldown)")
        return

    lines = []
    for st, req, lv, strong, mag_note in hits:
        cloud = lv.get("cloud")
        sky = ("clouds ?" if cloud is None else f"clouds {cloud}% ✓ would alert on board" if cloud <= CLOUD_MAX
               else f"cloudy {cloud}% ✕")
        lines.append(f"{st['name']}: {sky}{mag_note}")
    # user, 7 Oct 2026: keep clouds, magnetometer, Hp30 and the solar wind speed; "needs Kp" and Bz say nothing to him
    live = [f"Hp30 {g['hp30']:.1f}" if "hp30" in g else "", f"wind {g['speed']} km/s" if "speed" in g else ""]
    title = "🧪 TEST · 🔥 Strong aurora activity" if level == "strong" else "🧪 TEST · 🟢 Aurora active"
    send(title, "\n".join(lines) + "\nLive: " + " · ".join(x for x in live if x),
         priority=5 if level == "strong" else 4, tags=["test_tube"], dry=dry, click=DASHBOARD + "#live")
    t.update(count=t["count"] + 1, last_alert=iso(now), last_level=level)
    state["test"] = t
    if not dry:
        save_json(DATA / "alert_state.json", state)


def tonight_link(now):
    local = now + timedelta(hours=SHIP_UTC_OFFSET)
    night = (local - timedelta(days=1) if local.hour < 12 else local).date().isoformat()
    return f"{DASHBOARD}?night={night}"


def send(title, message, priority=4, tags=None, dry=False, click=DASHBOARD):
    payload = {"topic": os.environ.get("NTFY_TOPIC", ""), "title": title, "message": message,
               "priority": priority, "tags": tags or [], "click": click}
    if dry:
        print("DRY-RUN would send:", json.dumps(payload, ensure_ascii=False, indent=1))
        return
    if not payload["topic"]:
        raise SystemExit("NTFY_TOPIC is not set")
    # the alert workflow then starts a forecast run, so the page's Tonight card is fresh when the message is opened
    with open("alert_sent.txt", "a", encoding="utf-8") as f:
        f.write(title + "\n")
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    req = urllib.request.Request(server, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        print("sent", r.status, title)


def fmt_live(lv):
    """The live numbers in a message: Hp30, solar wind speed, clouds (user, 7 Oct 2026: no "needed here", Bz or OVATION;
    those stay on the page)."""
    parts = []
    if "hp30" in lv:
        parts.append(f"Hp30 {lv['hp30']:.1f}")
    if "speed" in lv:
        parts.append(f"wind {lv['speed']} km/s")
    if "cloud" in lv:
        parts.append(f"clouds {lv['cloud']}% ({lv.get('cloud_src', '')})")
    return " · ".join(parts)


def save_hp30(now):
    """Fresh Hp30 for the page's live tile, every run before and during the cruise (it used to be written only on
    board after dark, so before the cruise the page's "now" could be 3-4 hours old)."""
    try:
        series = [[iso(t), v] for t, v in fetch_hp30(now - timedelta(hours=24), now)]
    except Exception as e:  # the page falls back to latest.json
        print("hp30 failed:", e)
        return
    prev = load_json(DATA / "hp30.json", {}) or {}
    if series and (not prev.get("series") or prev["series"][-1] != series[-1]):
        save_json(DATA / "hp30.json", {"updated": iso(now), "series": series}, compact=True)


def briefing(n, now):
    """The evening outlook in the words of the page's Basic Tonight card (update.tonight_answer)."""
    ans = tonight_answer(n, now)
    ev = {e["kind"]: e["local"] for e in n.get("events", [])}
    kps = [h["kp"] for h in n["hourly"] if h["dark"]]
    lo, hi = (f"{min(kps):.1f}", f"{max(kps):.1f}") if kps else (None, None)
    kp = f"Kp {lo if lo == hi else f'{lo}–{hi}'} tonight, {n['kp_req']:.1f} needed here" if kps else ""
    if ans["verdict"] == "far":
        head, sky = f"{round(n['score'] * 100)}% chance", "hour-by-hour clouds not forecast yet"
    else:
        head = f"{ans['verdict']} {ans['window']}" if ans["window"] else "NO"
        c = ans["cloud"]
        sky = (f"{c[0]}% cloud" if c[0] == c[1] else f"{c[0]}–{c[1]}% cloud") + " in the dark hours (MET Norway)" if c else ""
    dark = f"dark {ev.get('dark_start', n['dark']['start'])}–{ev.get('dark_end', n['dark']['end'])}"
    return f"🌌 Tonight: {head}", " · ".join(x for x in (n["place"], kp, sky, dark) if x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--now")
    args = ap.parse_args()

    now = parse_utc(args.now) if args.now else utcnow()
    route = Route(load_json(CONFIG / "itinerary.json"))
    pos = route.at(now)
    ml = mag_lat(pos["lat"], pos["lon"])
    req = kp_required(ml)
    sa = sun_alt(now, pos["lat"], pos["lon"])

    if args.test:
        lv = live_readings(pos["lat"], pos["lon"])
        send("✅ Aurora alerts are working",
             f"Test from the dashboard. Reference point: {pos['place']}. Live: {fmt_live(lv)}",
             priority=3, tags=["white_check_mark"], dry=args.dry_run)
        return

    if not args.dry_run:
        save_hp30(now)
    if now <= route.end:
        test = now < route.start - timedelta(hours=6)
        shock_check(now, args.dry_run, test=test)
        here = (69.65, 18.96) if test else (pos["lat"], pos["lon"])  # Tromsø while practising, then the ship
        door_check(now, args.dry_run, test, *here)
        camera_check(now, args.dry_run, test, *here)
    if now < route.start - timedelta(hours=6):
        test_season(now, route, args.dry_run)
        return
    if now > route.end:
        print("after the cruise — nothing to do")
        return

    state = load_json(DATA / "alert_state.json", {}) or {}
    state.setdefault("briefings", [])  # the file from the test season has no such key: KeyError at 17:00 on board
    changed = False
    local = now + timedelta(hours=SHIP_UTC_OFFSET)

    # Evening briefing from the latest forecast run.
    today = local.date().isoformat()
    if BRIEFING_HOURS[0] <= local.hour < BRIEFING_HOURS[1] and today not in state["briefings"]:
        latest = load_json(DATA / "latest.json", {}) or {}
        n = next((x for x in latest.get("nights", []) if x["date"] == today), None)
        if n:
            title, msg = briefing(n, now)
            send(title, msg, priority=3, tags=["crescent_moon"], dry=args.dry_run, click=tonight_link(now))
            state["briefings"].append(today)
            changed = True

    if sa > SUN_MAX:
        print(f"too bright (sun {sa:.1f}°) at {pos['place']}")
    else:
        lv = live_readings(pos["lat"], pos["lon"])
        cloud = lv.get("cloud")
        activity_ok, strong = judge(lv, req)
        # a substorm at a nearby magnetometer (Tromsø / Alta area): the fastest sign, minutes before Hp30 shows it
        m = mag_event(pos["lat"], pos["lon"], now)
        if m and state.get("mag_at") and parse_utc(m["at"]) <= parse_utc(state["mag_at"]):
            m = None  # the same substorm moment as the last alert (seen again because of the long look-back)
        if m:
            activity_ok = True
            strong = strong or m["level"] == "strong"
        mag_txt = f"{m['note']} · " if m else ""
        sky_ok = cloud is not None and cloud <= CLOUD_MAX
        print(f"{iso(now)} {pos['place']} sun {sa:.1f} req {req:.1f} activity_ok={activity_ok} "
              f"strong={strong} sky_ok={sky_ok} live={ {k: v for k, v in lv.items() if k != 'hp30_series'} }")
        if activity_ok and sky_ok:
            level = "strong" if strong else "watch"
            last = parse_utc(state["last_alert"]) if state.get("last_alert") else None
            cooling = last and (now - last) < timedelta(minutes=MAG_COOLDOWN_MIN if m else COOLDOWN_MIN)
            escalation = level == "strong" and state.get("last_level") == "watch"
            if not cooling or escalation:
                if level == "strong":
                    title, prio, tags = "🔥 Strong aurora — go outside NOW", 5, ["rotating_light"]
                else:
                    title, prio, tags = "🟢 Aurora likely — go outside", 4, ["sparkles"]
                send(title, f"{pos['place']}. Look north, away from ship lights. {mag_txt}{fmt_live(lv)}",
                     priority=prio, tags=tags, dry=args.dry_run, click=tonight_link(now))
                state["last_alert"] = iso(now)
                state["last_level"] = level
                if m:
                    state["mag_at"] = m["at"]
                changed = True
        elif activity_ok:
            # Cloudy here, but forecasts miss gaps and the ship moves: one quieter heads-up per night, again when it
            # turns strong or when a new substorm shows 2 hours later.
            night = night_key(now)
            c = state.get("cloudy") or {}
            repeat = CLOUDY_REPEAT_STRONG_MIN if strong else CLOUDY_REPEAT_MIN
            again = (m or strong) and c.get("at") and now - parse_utc(c["at"]) >= timedelta(minutes=repeat)
            if c.get("night") != night or (strong and c.get("level") == "watch") or again:
                send("☁️ Aurora active, cloudy here — look for gaps",
                     f"{pos['place']}: forecast cloud {cloud if cloud is not None else '?'}%. "
                     f"Worth a look outside for breaks in the cloud. {mag_txt}{fmt_live(lv)}",
                     priority=3, tags=["cloud"], dry=args.dry_run, click=tonight_link(now))
                state["cloudy"] = {"night": night, "level": "strong" if strong else "watch", "at": iso(now)}
                if m:
                    state["mag_at"] = m["at"]
                changed = True

    if changed and not args.dry_run:
        save_json(DATA / "alert_state.json", state)


if __name__ == "__main__":
    main()
