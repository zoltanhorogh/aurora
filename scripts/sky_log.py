"""Ground truth from all-sky cameras: log the "Tromsø AI" image classification once per hour.

The Tromsø AI project (University of Electro-Communications, Japan) classifies the latest all-sky
camera image every few minutes: aurora types (arc / discrete / diffuse, "aurora but cloudy",
"aurora but bright"), clear, cloudy, dusk/dawn — each in %. Runs from the alert workflow every 10 min
and keeps, per site and hour, the most auroral of the pictures it checked (only when it is dark at the camera):
one reading per hour missed both aurora spells over Tromsø on 1 Oct 2026 (22:50 and 01:30-02:10).
Output: data/sky_obs.json  {night date (local evening): {site: {"HH": {...}}}}
"""
from datetime import timedelta

from common import DATA, http_get_json, iso, load_json, parse_utc, save_json, sun_alt, utcnow

BASE = "https://tromsoe-ai.cei.uec.ac.jp/~nanjo/public/aurora_alert/"
SITES = {"tromso": "Data.json", "skibotn": "Data_skibotn.json", "kiruna": "Data_kiruna.json"}
COORDS = {"tromso": (69.65, 18.96), "skibotn": (69.35, 20.36), "kiruna": (67.84, 20.41)}
AURORA_KEYS = ("Arc", "Discrete", "Diffuse", "Aurora but cloudy", "Aurora but bright")
LOCAL_OFFSET = 2
KEEP_NIGHTS = 40


def summarize(js):
    a = js.get("Aurora", {})
    aurora = sum(a.get(k, 0) for k in AURORA_KEYS)
    return {"aurora": round(aurora), "clear": round(a.get("Clear", 0)), "cloudy": round(a.get("Cloudy", 0)),
            "dusk": round(a.get("Dusk/Dawn", 0)), "bright": round(a.get("Aurora but bright", 0)),
            "type": max(AURORA_KEYS, key=lambda k: a.get(k, 0)) if aurora >= 50 else None}


def main():
    now = utcnow()
    log = load_json(DATA / "sky_obs.json", {"nights": {}}) or {"nights": {}}
    changed = False
    for site, fname in SITES.items():
        try:
            js = http_get_json(BASE + fname, timeout=30)
        except Exception as e:
            print(site, "failed:", e)
            continue
        t = parse_utc(js["Time"].replace(" ", "T") + "Z")
        if now - t > timedelta(minutes=45):
            continue  # camera/AI not updating (daytime pause or outage)
        s = summarize(js)
        s["sun"] = round(sun_alt(t, *COORDS[site]), 1)
        if s["dusk"] >= 90 and s["sun"] > -10:
            continue  # real daylight/twilight: nothing to learn (a moonlit sky, also "dusk" to the AI, is kept)
        local = t + timedelta(hours=LOCAL_OFFSET)
        night = (local - timedelta(days=1) if local.hour < 12 else local).date().isoformat()
        hour = local.strftime("%H")
        slot = log["nights"].setdefault(night, {}).setdefault(site, {})
        old = slot.get(hour)
        if old and old.get("last") == iso(t):
            continue  # the same picture as at the last check
        n = (old or {}).get("n", 1 if old else 0) + 1
        if old and (old["aurora"], old.get("bright", 0)) >= (s["aurora"], s["bright"]):
            old.update(n=n, last=iso(t))  # keep the more auroral picture of this hour
        else:
            slot[hour] = {**s, "t": iso(t), "n": n, "last": iso(t)}
        changed = True
        print(site, night, hour, s, "checks", n)
    if changed:
        nights = sorted(log["nights"])[-KEEP_NIGHTS:]
        log["nights"] = {k: log["nights"][k] for k in nights}
        log["updated"] = iso(now)
        save_json(DATA / "sky_obs.json", log, compact=True)
    else:
        print("nothing new")


if __name__ == "__main__":
    main()
