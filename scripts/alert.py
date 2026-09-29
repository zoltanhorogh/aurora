"""Real-time aurora alerts via ntfy push notifications.

Runs every ~10 minutes from GitHub Actions.
Before the cruise ("test season") it watches all Norwegian ports at once and sends "🧪 TEST" alerts when
activity would be good enough at any of them in the dark, with each port's clouds in the message
(max 2 per night), so the thresholds can be judged before the trip.
During the cruise it sends:
  * an evening briefing (once per day, ~17-19h ship time) with tonight's outlook;
  * a "go outside" alert when live activity is good AND the sky at the ship is clear AND it is dark.
Thresholds are deliberately conservative: fewer alerts, but each one should be worth it.

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
MAG_STRONG_SWING = 200   # nT, last-hour swing at the nearby FMI magnetometer
MAG_STRONG_DROP = -100   # nT within 10 minutes
MAG_NEAR_KM = 300
TEST_MAX_PER_NIGHT = 2


def global_readings():
    """Readings that are the same everywhere: Kp, Hp30, solar wind, the OVATION grid."""
    out = {}
    try:
        kp = http_get_json(f"{SWPC}/json/planetary_k_index_1m.json")
        out["kp"] = float(kp[-1]["estimated_kp"])
    except Exception as e:
        out["kp_error"] = str(e)
    try:
        # Half-hourly planetary activity: reacts to substorms faster than the 3-hourly Kp.
        hp = fetch_hp30(utcnow() - timedelta(hours=24), utcnow())
        out["hp30_series"] = [[iso(t), v] for t, v in hp]
        if hp and utcnow() - hp[-1][0] <= timedelta(minutes=90):
            out["hp30"] = hp[-1][1]
    except Exception as e:
        out["hp30_error"] = str(e)
    try:
        mag = http_get_json(f"{SWPC}/json/rtsw/rtsw_mag_1m.json")
        cutoff = utcnow() - timedelta(minutes=30)
        bz = [m["bz_gsm"] for m in mag if m.get("active") and m.get("bz_gsm") is not None
              and parse_utc(m["time_tag"] + "Z") >= cutoff]
        if bz:
            out["bz30"] = round(sum(bz) / len(bz), 1)
            out["bz_min"] = round(min(bz), 1)
    except Exception as e:
        out["bz_error"] = str(e)
    try:
        wind = http_get_json(f"{SWPC}/json/rtsw/rtsw_wind_1m.json")
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
    """(activity good enough to go out, strong) for a place that needs Kp `req`."""
    kp, bz, hp30 = lv.get("kp", 0), lv.get("bz30", 0), lv.get("hp30", 0)
    ov_l, ov_n = lv.get("ovation_local", 0), lv.get("ovation_north", 0)
    activity_ok = (ov_l >= OVATION_LOCAL_MIN
                   or (ov_n >= OVATION_NORTH_MIN and kp >= req)
                   or (kp >= req + 1 and bz <= BZ_SOUTH)
                   or hp30 >= req + 1.5)
    strong = ov_l >= 50 or kp >= req + 3 or hp30 >= req + 3 or (bz <= -10 and lv.get("speed", 0) >= 500)
    return activity_ok, strong


def mag_near(lat, lon, now):
    """Fresh reading of the nearest FMI magnetometer (data/mag.json, written just before by mag_log.py)."""
    mag = load_json(DATA / "mag.json", {}) or {}
    best = None
    for st in (mag.get("stations") or {}).values():
        km = haversine_km((lat, lon), (st["lat"], st["lon"]))
        if km <= MAG_NEAR_KM and now - parse_utc(st["t"]) <= timedelta(minutes=20) and (not best or km < best[0]):
            best = (km, st)
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
        m = mag_near(st["lat"], st["lon"], now)
        mag_note = ""
        if m and (m["swing_60"] >= MAG_STRONG_SWING or m["change_10"] <= MAG_STRONG_DROP):
            ok = strong = True
            mag_note = f", magnetometer {m['name']} {m['change_10']:+d} nT in 10 min / {m['swing_60']} nT in 1 h"
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
    if t["count"] >= TEST_MAX_PER_NIGHT or (cooling and not escalation):
        print("test season: alert suppressed (limit / cooldown)")
        return

    lines = []
    for st, req, lv, strong, mag_note in hits:
        cloud = lv.get("cloud")
        sky = ("clouds ?" if cloud is None else f"clouds {cloud}% ✓ would alert on board" if cloud <= CLOUD_MAX
               else f"cloudy {cloud}% ✕")
        lines.append(f"{st['name']} (needs Kp ≈{req:.1f}): {sky}{mag_note}")
    live = [f"Kp {g['kp']:.1f}" if "kp" in g else "", f"Hp30 {g['hp30']:.1f}" if "hp30" in g else "",
            f"Bz {g['bz30']:+.1f} nT" if "bz30" in g else "", f"wind {g['speed']} km/s" if "speed" in g else ""]
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
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    req = urllib.request.Request(server, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        print("sent", r.status, title)


def fmt_live(lv, req):
    parts = []
    if "kp" in lv:
        parts.append(f"Kp now {lv['kp']:.1f} (needed here ≈{req:.0f})")
    if "hp30" in lv:
        parts.append(f"Hp30 {lv['hp30']:.1f}")
    if "bz30" in lv:
        parts.append(f"Bz {lv['bz30']:+.1f} nT" + (" (south ✓)" if lv["bz30"] <= BZ_SOUTH else ""))
    if "speed" in lv:
        parts.append(f"wind {lv['speed']} km/s")
    if "ovation_local" in lv:
        parts.append(f"OVATION {lv['ovation_local']}% overhead, {lv['ovation_north']}% to the north")
    if "cloud" in lv:
        parts.append(f"clouds {lv['cloud']}% ({lv.get('cloud_src', '')})")
    return " · ".join(parts)


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
             f"Test from the dashboard. Reference point: {pos['place']}. Live: {fmt_live(lv, req)}",
             priority=3, tags=["white_check_mark"], dry=args.dry_run)
        return

    if now < route.start - timedelta(hours=6):
        test_season(now, route, args.dry_run)
        return
    if now > route.end:
        print("after the cruise — nothing to do")
        return

    state = load_json(DATA / "alert_state.json", {"last_alert": None, "last_level": None, "briefings": []})
    changed = False
    local = now + timedelta(hours=SHIP_UTC_OFFSET)

    # Evening briefing from the latest forecast run.
    today = local.date().isoformat()
    if BRIEFING_HOURS[0] <= local.hour < BRIEFING_HOURS[1] and today not in state["briefings"]:
        latest = load_json(DATA / "latest.json", {}) or {}
        n = next((x for x in latest.get("nights", []) if x["date"] == today), None)
        if n:
            cloud = n["clear"].get("mean_cloud_dark")
            msg = (f"{n['place']} · chance {round(n['score'] * 100)}% ({n['rating']}). "
                   f"Dark {n['dark']['start']}–{n['dark']['end']}. "
                   f"Clear-sky chance {round(n['clear']['p'] * 100)}%"
                   + (f", forecast cloud ≈{cloud:.0f}%" if cloud is not None else "")
                   + f". Activity {round(n['activity']['p'] * 100)}%. " + " ".join(n["notes"][:2]))
            send(f"🌌 Tonight's aurora outlook: {n['rating']}", msg, priority=3, tags=["crescent_moon"],
                 dry=args.dry_run, click=tonight_link(now))
            state["briefings"].append(today)
            changed = True

    if sa > SUN_MAX:
        print(f"too bright (sun {sa:.1f}°) at {pos['place']}")
    else:
        lv = live_readings(pos["lat"], pos["lon"])
        cloud = lv.get("cloud")
        activity_ok, strong = judge(lv, req)
        # Keep a fresh Hp30 series for the dashboard's live tile (committed by the workflow).
        if lv.get("hp30_series") and not args.dry_run:
            prev = load_json(DATA / "hp30.json", {}) or {}
            if not prev.get("series") or prev["series"][-1] != lv["hp30_series"][-1]:
                save_json(DATA / "hp30.json", {"updated": iso(now), "series": lv["hp30_series"]}, compact=True)
        sky_ok = cloud is not None and cloud <= CLOUD_MAX
        print(f"{iso(now)} {pos['place']} sun {sa:.1f} req {req:.1f} activity_ok={activity_ok} "
              f"strong={strong} sky_ok={sky_ok} live={ {k: v for k, v in lv.items() if k != 'hp30_series'} }")
        if activity_ok and sky_ok:
            level = "strong" if strong else "watch"
            last = parse_utc(state["last_alert"]) if state.get("last_alert") else None
            cooling = last and (now - last) < timedelta(minutes=COOLDOWN_MIN)
            escalation = level == "strong" and state.get("last_level") == "watch"
            if not cooling or escalation:
                if level == "strong":
                    title, prio, tags = "🔥 Strong aurora — go outside NOW", 5, ["rotating_light"]
                else:
                    title, prio, tags = "🟢 Aurora likely — go outside", 4, ["sparkles"]
                send(title, f"{pos['place']}. Look north, away from ship lights. {fmt_live(lv, req)}",
                     priority=prio, tags=tags, dry=args.dry_run, click=tonight_link(now))
                state["last_alert"] = iso(now)
                state["last_level"] = level
                changed = True

    if changed and not args.dry_run:
        save_json(DATA / "alert_state.json", state)


if __name__ == "__main__":
    main()
