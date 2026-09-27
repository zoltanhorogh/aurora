"""Forecast notifications, run right after update.py (every 3 hours).

  * Change alert: an Arctic "watch" night changes rating or moves >= 5 points since the
    last change alert, or a new Earth-directed CME is modelled to arrive during the cruise.
    At most 2 per day. The very first run sends the baseline so you know it is working.
  * Morning digest: once a day between 08:00 and 12:00 ship/Hungarian time (UTC+2),
    with the change since the previous digest.
Both stop after the cruise. State lives in data/notify_state.json.

Usage: python notify.py [--dry-run] [--now 2026-09-28T06:20:00Z]
"""
import argparse
from datetime import timedelta

from alert import DASHBOARD, send
from common import CONFIG, DATA, iso, load_json, parse_utc, save_json, utcnow

CHANGE_PTS = 0.05
MAX_CHANGES_PER_DAY = 2
DIGEST_HOURS = (8, 12)
LOCAL_OFFSET = 2


def short_place(place):
    return "at sea" if place.startswith("At sea") else place.split(" →")[0]


def line(n, prev=None):
    pct = round(n["score"] * 100)
    s = f"{parse_utc(n['date'] + 'T12:00:00Z').strftime('%a %d')} {short_place(n['place'])} {pct}%"
    if prev is not None:
        d = pct - round(prev["score"] * 100)
        s += f" ({'+' if d > 0 else '±' if d == 0 else '−'}{abs(d)})"
        if prev["rating"] != n["rating"]:
            s += f" {prev['rating']}→{n['rating']}"
    else:
        s += f" {n['rating']}"
    return s


def link(date):
    return f"{DASHBOARD}?night={date}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--now")
    args = ap.parse_args()

    now = parse_utc(args.now) if args.now else utcnow()
    local = now + timedelta(hours=LOCAL_OFFSET)
    today = local.date().isoformat()
    it = load_json(CONFIG / "itinerary.json")
    latest = load_json(DATA / "latest.json")
    if now > parse_utc(latest["trip"]["end"]):
        print("cruise is over — no forecast notifications")
        return

    nights = {n["date"]: n for n in latest["nights"]}
    watch = [nights[d] for d in it["watch_nights"] if d in nights]
    cur = {n["date"]: {"score": n["score"], "rating": n["rating"]} for n in watch}
    best = max(latest["nights"], key=lambda n: n["score"])
    days_to_go = (parse_utc(latest["trip"]["start"]) - now).days
    state = load_json(DATA / "notify_state.json", {}) or {}
    changed = False

    # ---- change tracking
    if not state.get("baseline"):
        send("📊 Aurora change tracking is on",
             "Baseline for the Arctic nights: " + " · ".join(line(n) for n in watch)
             + f". You'll get a message when one moves ≥{round(CHANGE_PTS * 100)} points or changes rating, "
             "plus a morning outlook around 08:15.",
             priority=3, tags=["bar_chart"], click=link(best["date"]), dry=args.dry_run)
        # digest_date=today: the first morning digest comes tomorrow, not together with this message
        state.update(baseline=cur, digest_values=cur, digest_date=today, cmes_sent=[], change_day=today, changes_today=0)
        changed = True
    else:
        base = state["baseline"]
        moved = [n for n in watch if n["date"] in base and (
            n["rating"] != base[n["date"]]["rating"]
            or abs(n["score"] - base[n["date"]]["score"]) >= CHANGE_PTS)]
        trip_start = parse_utc(latest["trip"]["start"]) - timedelta(days=1)
        trip_end = parse_utc(latest["trip"]["end"])
        new_cmes = [c for c in latest["space_weather"].get("cmes", [])
                    if trip_start <= parse_utc(c["arrival"]) <= trip_end and c["arrival"] not in state.get("cmes_sent", [])]
        if state.get("change_day") != today:
            state["change_day"], state["changes_today"] = today, 0
            changed = True
        if (moved or new_cmes) and state["changes_today"] < MAX_CHANGES_PER_DAY:
            parts = [line(n, base[n["date"]]) for n in moved]
            for c in new_cmes:
                parts.append(f"☀️ CME expected {parse_utc(c['arrival']).strftime('%a %d %b %H:%M')} UTC, Kp {c.get('kp_min')}–{c.get('kp_max')}")
            up = sum(n["score"] - base[n["date"]]["score"] for n in moved)
            focus = max(moved, key=lambda n: abs(n["score"] - base[n["date"]]["score"]))["date"] if moved else best["date"]
            send(f"{'📈' if up >= 0 else '📉'} Aurora outlook changed", " · ".join(parts),
                 priority=4 if new_cmes else 3, tags=["chart_with_upwards_trend" if up >= 0 else "chart_with_downwards_trend"],
                 click=link(focus), dry=args.dry_run)
            state["baseline"] = cur
            state["cmes_sent"] = state.get("cmes_sent", []) + [c["arrival"] for c in new_cmes]
            state["changes_today"] += 1
            changed = True
        else:
            print("no significant change" if not (moved or new_cmes) else "change alert limit reached for today")

    # ---- morning digest
    if DIGEST_HOURS[0] <= local.hour < DIGEST_HOURS[1] and state.get("digest_date") != today:
        prev = state.get("digest_values") or {}
        head = f"{days_to_go} days to go" if days_to_go > 0 else "On board"
        msg = (f"{head} · Best: {line(best)} · "
               + " · ".join(line(n, prev.get(n["date"])) for n in watch)
               + f" · Confidence: {watch[0]['confidence'] if watch else '–'}")
        send("🌅 Morning aurora outlook", msg, priority=3, tags=["sunrise"], click=link(best["date"]), dry=args.dry_run)
        state.update(digest_date=today, digest_values=cur)
        changed = True

    if changed and not args.dry_run:
        state["updated"] = iso(now)
        save_json(DATA / "notify_state.json", state)


if __name__ == "__main__":
    main()
