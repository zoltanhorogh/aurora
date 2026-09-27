"""Real-time aurora alerts via ntfy push notifications.

Runs every ~10 minutes from GitHub Actions. Outside the cruise it exits immediately.
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

from common import (CONFIG, DATA, UA, Route, http_get_json, iso, kp_required, load_json,
                    mag_lat, parse_utc, save_json, sun_alt, utcnow)

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


def live_readings(lat, lon):
    out = {}
    try:
        kp = http_get_json(f"{SWPC}/json/planetary_k_index_1m.json")
        out["kp"] = float(kp[-1]["estimated_kp"])
    except Exception as e:
        out["kp_error"] = str(e)
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
        ov = http_get_json(f"{SWPC}/json/ovation_aurora_latest.json")
        lon360 = lon % 360
        local = north = 0
        for glon, glat, p in ov["coordinates"]:
            dlon = min(abs(glon - lon360), 360 - abs(glon - lon360))
            if dlon <= 1 and abs(glat - lat) <= 1:
                local = max(local, p)
            if dlon <= 10 and lat <= glat <= lat + 8:
                north = max(north, p)
        out["ovation_local"] = local
        out["ovation_north"] = north
    except Exception as e:
        out["ovation_error"] = str(e)
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

    if not (route.start - timedelta(hours=6) <= now <= route.end):
        print("outside the cruise window — nothing to do")
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
        kp = lv.get("kp", 0)
        bz = lv.get("bz30", 0)
        ov_l = lv.get("ovation_local", 0)
        ov_n = lv.get("ovation_north", 0)
        cloud = lv.get("cloud")
        activity_ok = (ov_l >= OVATION_LOCAL_MIN
                       or (ov_n >= OVATION_NORTH_MIN and kp >= req)
                       or (kp >= req + 1 and bz <= BZ_SOUTH))
        strong = ov_l >= 50 or kp >= req + 3 or (bz <= -10 and lv.get("speed", 0) >= 500)
        sky_ok = cloud is not None and cloud <= CLOUD_MAX
        print(f"{iso(now)} {pos['place']} sun {sa:.1f} req {req:.1f} activity_ok={activity_ok} "
              f"strong={strong} sky_ok={sky_ok} live={lv}")
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
