"""Summary of the last finished night up north: for the page ("Last night") and the morning message.

Puts together what the other jobs logged: the all-sky camera AI (sky_obs.json), the FMI magnetometers
(mag.json, 24 h series), MET Norway's analysed cloud at Tromsø and Alta (verification.json), the alerts
that went out (alert_state.json), plus GFZ Hp30. A night runs 18:00–06:00 ship time and counts as
finished when its darkness ends in Tromsø (same rule as the page). Output: data/last_night.json
"""
from datetime import datetime, timedelta

from common import DATA, TROMSO, UTC, darkness_end, fetch_hp30, iso, load_json, parse_utc, save_json, utcnow

LOCAL_OFFSET = 2
CAMS = {"tromso": "Tromsø", "skibotn": "Skibotn", "kiruna": "Kiruna"}


def hhmm(t):
    return (t + timedelta(hours=LOCAL_OFFSET)).strftime("%H:%M")


def cam_word(v):
    """One word for an hour of the camera AI log (same rules as the page)."""
    if v["aurora"] >= 50:
        return "aurora"
    if v.get("bright", 0) >= 30:
        return "possible aurora"
    if v["dusk"] >= 50:
        return "bright (moon)"
    if v["clear"] >= 50:
        return "clear"
    return "cloudy" if v["cloudy"] >= 50 else "mixed"


def hour_span(hours):
    """["21", "00", "01", "02"] -> "21–22, 00–03" (whole camera hours, gaps kept)."""
    groups = []
    for h in hours:
        if groups and (int(groups[-1][-1]) + 1) % 24 == int(h):
            groups[-1].append(h)
        else:
            groups.append([h])
    return ", ".join(f"{g[0]}–{(int(g[-1]) + 1) % 24:02d}" for g in groups)


def build(now):
    local = now + timedelta(hours=LOCAL_OFFSET)
    y = (local - timedelta(days=1)).date()  # the night that started yesterday evening
    d = y if now >= darkness_end(y, *TROMSO) else y - timedelta(days=1)
    t0 = datetime(d.year, d.month, d.day, 18 - LOCAL_OFFSET, tzinfo=UTC)
    t1 = t0 + timedelta(hours=12)
    out = {"date": d.isoformat(), "updated": iso(now)}

    try:
        hp = fetch_hp30(t0, t1)
        if hp:
            t, v = max(hp, key=lambda p: p[1])
            out["hp30"] = {"max": v, "at": hhmm(t + timedelta(minutes=15))}
    except Exception as e:  # the page simply leaves the line out
        out["hp30_error"] = str(e)

    out["mag"] = []
    for st in ((load_json(DATA / "mag.json", {}) or {}).get("stations") or {}).values():
        s = st.get("series")
        if not s:
            continue
        s0, step = parse_utc(s["t0"]), timedelta(minutes=s["step_min"])
        pts = [(s0 + i * step, v) for i, v in enumerate(s["dev"]) if v is not None and t0 <= s0 + i * step < t1]
        if len(pts) * s["step_min"] >= 8 * 60:  # the series must cover most of the night
            t, v = min(pts, key=lambda p: p[1])
            out["mag"].append({"name": st["name"], "min": v, "at": hhmm(t),
                               "level": "strong" if v <= -200 else "active" if v <= -50 else "quiet"})

    sky = ((load_json(DATA / "sky_obs.json", {}) or {}).get("nights") or {}).get(d.isoformat(), {})
    out["cams"] = []
    for site, name in CAMS.items():
        hrs = sky.get(site)
        if not hrs:
            continue
        order = sorted(hrs, key=lambda h: (int(h) + 12) % 24)
        words = [cam_word(hrs[h]) for h in order]
        out["cams"].append({"name": name, "checked": len(order),
                            "aurora": [h for h, w in zip(order, words) if w == "aurora"],
                            "possible": [h for h, w in zip(order, words) if w == "possible aurora"],
                            "cloudy": words.count("cloudy"), "clear": words.count("clear"),
                            "bright": words.count("bright (moon)")})

    ver = (load_json(DATA / "verification.json", {}) or {}).get("nights") or {}
    out["clouds"] = []
    for spot in ("Tromsø", "Alta"):
        o = (ver.get(f"{d.isoformat()}|{spot}") or {}).get("observed")
        out["clouds"].append({"spot": spot, "clear_dark": o["clear_dark"] if o else None})

    st = load_json(DATA / "alert_state.json", {}) or {}
    alerts = []
    test = st.get("test") or {}
    if test.get("night") == d.isoformat() and test.get("count"):
        alerts.append({"kind": "test", "count": test["count"], "last": hhmm(parse_utc(test["last_alert"]))})
    for key, kind in (("last_alert", "go outside"), ("cloudy", "cloudy heads-up")):
        v = st.get(key)
        v = v.get("at") if isinstance(v, dict) else v
        if v and t0 <= parse_utc(v) < t1:
            alerts.append({"kind": kind, "count": 1, "last": hhmm(parse_utc(v))})
    out["alerts"] = alerts

    out["headline"] = headline(out)
    out["text"] = text_line(out)
    return out


def headline(o):
    seen = [c for c in o["cams"] if c["aurora"]]
    maybe = [c for c in o["cams"] if c["possible"]]
    mag_min = min((m["min"] for m in o["mag"]), default=0)
    if seen:
        return "Aurora on the cameras: " + ", ".join(f"{c['name']} {hour_span(c['aurora'])}" for c in seen)
    if maybe:
        return "Possible aurora on the cameras (bright sky): " + ", ".join(f"{c['name']} {hour_span(c['possible'])}" for c in maybe)
    if mag_min <= -50 or o.get("hp30", {}).get("max", 0) >= 2:
        return "Active night, but no camera saw aurora (cloud or moon)"
    return "Quiet night"


def text_line(o):
    """One short line for the morning message."""
    parts = [o["headline"]]
    m = min(o["mag"], key=lambda m: m["min"], default=None)
    if m and m["min"] <= -50:
        parts.append(f"magnetometer {m['name']} {m['min']} nT at {m['at']}")
    known = [c for c in o["clouds"] if c["clear_dark"] is not None]
    if known:
        parts.append(", ".join(f"{c['spot']} " + (f"clear {c['clear_dark'][0]}–{c['clear_dark'][-1]}" if c["clear_dark"] else "cloudy")
                               for c in known))
    return "Last night: " + "; ".join(parts)


def write(now=None):
    out = build(now or utcnow())
    save_json(DATA / "last_night.json", out, compact=True)
    return out


if __name__ == "__main__":
    print(write()["text"])
