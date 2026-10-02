"""Forecast notifications, run right after update.py (every 3 hours).

  * Change alert: an Arctic "watch" night changes rating or moves >= 5 points since the
    last change alert, or a new Earth-directed CME is modelled to arrive during the cruise.
    At most 2 per day. The very first run sends the baseline so you know it is working.
  * Morning digest: once a day between 08:00 and 12:00 ship/Hungarian time (UTC+2),
    with the change since the previous digest.
Both only look at nights that are not over yet (a night is over when its darkness ends at the ship),
and both stop after the cruise. State lives in data/notify_state.json.

Usage: python notify.py [--dry-run] [--now 2026-09-28T06:20:00Z]
"""
import argparse
from datetime import timedelta

from alert import DASHBOARD, send
from common import CONFIG, DATA, iso, load_json, night_end, parse_utc, save_json, utcnow

CHANGE_PTS = 0.05
MAX_CHANGES_PER_DAY = 2
DIGEST_HOURS = (8, 12)
DIGEST_MOVE_PTS = 3          # a night is mentioned in the morning digest when it moved at least this much
LOCAL_OFFSET = 2


def short_place(place):
    return "at sea" if place.startswith("At sea") else place.split(" →")[0]


def day_label(date):
    return parse_utc(date + "T12:00:00Z").strftime("%a %d %b")


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
    return f"{DASHBOARD}?night={date}" if date else DASHBOARD


def countdown(now, start):
    """Same words as the page: calendar days (ship time) until departure, then "Sailing today", "On board"."""
    if now >= start:
        return "On board"
    days = ((start + timedelta(hours=LOCAL_OFFSET)).date() - (now + timedelta(hours=LOCAL_OFFSET)).date()).days
    return "Sailing today" if days <= 0 else f"{days} day{'s' if days > 1 else ''} to go"


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

    # only nights that are not over yet: a past night's score keeps being recomputed and must not count
    upcoming = [n for n in latest["nights"] if night_end(n) > now]
    nights = {n["date"]: n for n in upcoming}
    watch = [nights[d] for d in it["watch_nights"] if d in nights]
    cur = {n["date"]: {"score": n["score"], "rating": n["rating"]} for n in watch}
    best = max(upcoming, key=lambda n: n["score"]) if upcoming else None
    state = load_json(DATA / "notify_state.json", {}) or {}
    changed = False

    # ---- change tracking
    if not state.get("baseline"):
        send("📊 Aurora change tracking is on",
             "Baseline for the Arctic nights: " + " · ".join(line(n) for n in watch)
             + f". You'll get a message when one moves ≥{round(CHANGE_PTS * 100)} points or changes rating, "
             "plus a morning outlook around 08:15.",
             priority=3, tags=["bar_chart"], click=link(best and best["date"]), dry=args.dry_run)
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
                    if trip_start <= parse_utc(c["arrival"]) <= trip_end and parse_utc(c["arrival"]) > now  # still to come
                    and c["arrival"] not in state.get("cmes_sent", [])]
        if state.get("change_day") != today:
            state["change_day"], state["changes_today"] = today, 0
            changed = True
        if (moved or new_cmes) and state["changes_today"] < MAX_CHANGES_PER_DAY:
            parts = [line(n, base[n["date"]]) for n in moved]
            for c in new_cmes:
                when = (parse_utc(c["arrival"]) + timedelta(hours=LOCAL_OFFSET)).strftime("%a %d %b %H:%M")
                parts.append(f"☀️ CME expected {when} ship time, Kp {c.get('kp_min')}–{c.get('kp_max')}")
            up = sum(n["score"] - base[n["date"]]["score"] for n in moved)
            focus = max(moved, key=lambda n: abs(n["score"] - base[n["date"]]["score"]))["date"] if moved else best and best["date"]
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
        # Short on purpose: best night, the range of the Arctic nights, and at most two notable moves.
        prev = state.get("digest_values") or {}
        head = countdown(now, parse_utc(latest["trip"]["start"]))
        pcts = [round(n["score"] * 100) for n in watch]
        moves = sorted((n for n in watch if n["date"] in prev
                        and abs(round(n["score"] * 100) - round(prev[n["date"]]["score"] * 100)) >= DIGEST_MOVE_PTS),
                       key=lambda n: -abs(n["score"] - prev[n["date"]]["score"]))[:2]
        parts = [head] + ([f"Best night: {day_label(best['date'])} {round(best['score'] * 100)}% {best['rating']}"] if best else [])
        if moves:
            parts += [f"{'⬆' if n['score'] > prev[n['date']]['score'] else '⬇'} {day_label(n['date'])} {short_place(n['place'])} "
                      f"{round(prev[n['date']]['score'] * 100)}% → {round(n['score'] * 100)}%" for n in moves]
        elif pcts:
            parts.append(f"Arctic nights {min(pcts)}–{max(pcts)}%, no big change")
        ln = load_json(DATA / "last_night.json", {}) or {}
        if ln.get("text") and ln.get("date") == (local.date() - timedelta(days=1)).isoformat():
            parts.append(ln["text"])
        send("🌅 Aurora outlook", " · ".join(parts), priority=3, tags=["sunrise"], click=link(best and best["date"]), dry=args.dry_run)
        state.update(digest_date=today, digest_values=cur)
        changed = True

    if changed and not args.dry_run:
        state["updated"] = iso(now)
        save_json(DATA / "notify_state.json", state)


if __name__ == "__main__":
    main()
