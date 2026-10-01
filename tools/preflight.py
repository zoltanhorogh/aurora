"""Preflight check before every push.

1. Compiles every Python script.
2. Runs the pipeline scripts on a temporary copy of the data (dry-run for notifications), once as it is
   and once with the cruise moved so that the ship is in Tromsø today: then the on-board views
   (tonight with MET, past nights, far nights, ports) are built from real, current data.
3. Opens the page in headless Chrome in several situations (clock set to different moments), clicks
   every night, model-check day and spot, weather tab and magnetometer tab, opens every dropdown,
   and reports any JavaScript error plus a few consistency checks.
4. Timeline: the page at 18, 21, 00, 03, 06, 09 and 12 ship time on four data sets (today as published; the
   cruise moved so that departure is tomorrow, Tromsø is today, the last sea night is today; plus the day
   after the cruise): what must hold at every moment, and that "tonight" moves on exactly once, at the end
   of darkness, and never comes back. The morning notification must not talk about nights that are over.

Nothing in the repository is changed and nothing is sent: all output goes to a temporary folder,
NTFY_TOPIC is emptied and the alert/notify scripts run with --dry-run.

Usage:  python tools/preflight.py            full check (~3-5 min, needs internet)
        python tools/preflight.py --quick    page checks on the current data only (~1 min)
"""
import argparse
import json
import os
import py_compile
import re
import shutil
import socket
import subprocess
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHROMES = [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
           r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
           "google-chrome", "chromium", "chromium-browser"]
SITE_FILES = ["index.html", "sw.js", "manifest.webmanifest"]

# Injected at the top of <head>: optional clock shift, error capture, and the click-through.
INJECT = r"""<script>
(() => {
  const P = new URLSearchParams(location.search);
  try { localStorage.setItem('aurora-mode', 'advanced'); } catch (e) { /* ignore */ } // the click-through checks the full page first
  const OFF = +(P.get('clock') || 0) * 1000;
  if (OFF) {
    const R = Date;
    class F extends R { constructor(...a) { super(...(a.length ? a : [R.now() + OFF])); } static now() { return R.now() + OFF; } }
    window.Date = F;
  }
  const errors = [];
  const push = (m) => errors.push(String(m).slice(0, 400));
  window.addEventListener('error', (e) => push(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => push('unhandled promise: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));
  const ce = console.error.bind(console);
  console.error = (...a) => { push(a.map((x) => (x && x.stack) || x).join(' ')); ce(...a); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const check = (name, ok, msg) => checks.push({ name, ok: !!ok, msg: msg || '' });
  const $$ = (s) => [...document.querySelectorAll(s)];

  function detailChecks(root, label) {
    if (!root) return check(label + ': detail exists', false);
    if (root.querySelector('.tag-past') && !root.querySelector('#check-panel .daytabs')) {
      check(label + ': past night has no forecast chart', !root.querySelector('.chart svg'));
      return;
    }
    const far = root.querySelector('.farbox');
    const rows = root.querySelectorAll('.hours2 .hr:not(.head)').length;
    check(label + ': detail rendered', root.textContent.trim().length > 80);
    if (far) {
      check(label + ': far night shows only MET hours', !root.querySelector('.hours2') || /First hours from MET Norway/.test(root.textContent));
      check(label + ': far night does not say "No good window"', !/No good window/.test(root.textContent));
    } else {
      check(label + ': MET night has hour rows', rows > 0, rows + ' rows');
    }
  }

  // tonight's answer is never a stretch that is already over (hours that are over keep their clouds)
  function windowCheck(b) {
    const vt = b.querySelector('#basic > .b-card:not(#b-last) .b-verdict');
    const win = vt && (vt.querySelector('small') || {}).textContent;
    const wm = win && win.match(/(\d\d):\d\d–(\d\d):\d\d/);
    if (wm) {
      const lastH = String((+wm[2] + 23) % 24).padStart(2, '0');
      const lastCell = [...b.querySelectorAll('.bstrip > div')].find((c) => c.textContent.trim().endsWith(lastH));
      check('basic tonight window is not over yet', !lastCell || !lastCell.classList.contains('past'), win);
    }
    return vt;
  }

  // Timeline slot (?tl=1): no click-through, only what must hold at any moment, plus the state that the
  // checks across slots need (done in Python): which night is "tonight", is the morning card shown.
  let state = null;
  async function timeline() {
    for (let i = 0; i < 150 && !document.querySelector('#night-cards .night'); i++) await sleep(200);
    const latest = await fetch('data/latest.json').then((r) => r.json());
    const now = Date.now(), trip = latest.trip;
    const phase = now > new Date(trip.end) ? 'over' : now >= new Date(trip.cruise_day_from || trip.start) ? 'cruise' : 'practice';
    const lint = (label, text, ranges) => {
      const bad = text.match(/undefined|NaN|\bnull\b|Infinity|\[object /);
      check(`${label}: no undefined/NaN in the text`, !bad, bad && bad[0]);
      check(`${label}: no "1 days"`, !/\b1 days\b/.test(text));
      if (ranges) { const r = text.match(/\b(\d\d:\d\d)–\1(?!\d)/); check(`${label}: no X–X time range`, !r, r && r[0]); }
    };
    // advanced (the injected default mode)
    const kicker = (document.querySelector('#hero .kicker') || {}).textContent || '';
    const heroDate = /tonight/i.test(kicker) ? ((document.querySelector('#hero .when') || {}).textContent || '').split(' · ')[0] : null;
    const pastDates = $$('#night-cards .night.past .d').map((d) => d.textContent.replace('PAST', '').trim());
    if (heroDate) check('advanced: tonight is not also a PAST card', !pastDates.includes(heroDate), heroDate);
    lint('advanced', document.querySelector('main').textContent, false);
    // basic
    document.querySelector('#mode button[data-mode="basic"]').click();
    await sleep(300);
    const b = document.querySelector('#basic');
    lint('basic', b.textContent, true);
    const cards = [...b.querySelectorAll(':scope > .b-card:not(#b-last)')];
    const tonightCard = cards.find((c) => /^Tonight/.test(((c.querySelector('.b-k') || {}).textContent || '').trim()));
    const tk = tonightCard ? tonightCard.querySelector('.b-k').textContent.trim() : '';
    const notLast = cards.map((c) => c.textContent).join(' | ');
    if (phase !== 'practice') check(`basic (${phase}): no practice wording outside the last-night card`, !/practice/i.test(notLast), (notLast.match(/.{0,60}practice.{0,40}/i) || [''])[0]);
    if (phase === 'practice' && tonightCard && tonightCard.querySelector('.bplace')) check('basic (practice): tonight is the practice spot', /practice spot/.test(tonightCard.textContent));
    if (phase === 'over') check('basic (over): no right-now card and no test alerts', !/Right now/.test(b.textContent) && !/Test alerts/.test(b.textContent));
    if (now >= new Date(trip.start).getTime() - 6 * 3600e3) check('basic: no test-alert line once the cruise alerts run', !/Test alerts/.test(b.textContent));
    windowCheck(b);
    const basicDate = tk.split(' · ')[1] || null; // "Tonight · Fri 2 Oct"
    if (heroDate && basicDate) check('basic and advanced show the same night as tonight', heroDate === basicDate, `${basicDate} / ${heroDate}`);
    state = { phase, tonight: basicDate || tk, morning: !!b.querySelector('#b-last'), hero: heroDate };
  }

  function finish() {
    const out = document.createElement('script');
    out.type = 'application/json';
    out.id = 'pf-result';
    out.textContent = JSON.stringify({ errors, checks, state, clock: new Date().toISOString() }).replace(/</g, '\\u003c');
    document.body.appendChild(out);
  }

  async function run() {
    for (let i = 0; i < 150 && !document.querySelector('#night-cards .night'); i++) await sleep(200);
    check('night cards rendered', $$('#night-cards .night').length > 0);
    const n = $$('#night-cards .night').length;
    for (let i = 0; i < n; i++) {
      const c = $$('#night-cards .night')[i]; // the cards re-render on every click
      const label = 'night ' + c.dataset.date + (c.classList.contains('past') ? ' (past)' : '');
      c.click();
      await sleep(150);
      if (c.classList.contains('past')) check(label + ': past card shows no forecast %', !c.querySelector('.pct'));
      detailChecks(document.querySelector('#night-detail'), label);
    }
    const cp = document.querySelector('#check-panel');
    if (cp) {
      cp.open = true;
      await sleep(400);
      const days = $$('#check-panel .daytabs button').length;
      check('model check has day tabs', days > 0);
      for (let d = 0; d < days; d++) {
        $$('#check-panel .daytabs button')[d].click();
        await sleep(200);
        const spots = $$('#check-panel tr.pick').length;
        for (let s = 0; s < spots; s++) {
          $$('#check-panel tr.pick')[s].click();
          await sleep(200);
          detailChecks(cp, `model check day ${d + 1} spot ${s + 1}`);
        }
      }
    }
    const tabs = $$('#wx-tabs button').length;
    for (let i = 0; i < tabs; i++) {
      $$('#wx-tabs button')[i].click();
      await sleep(150);
      check(`weather tab ${i + 1} rendered`, document.querySelector('#wx-port').textContent.trim().length > 30);
    }
    for (let i = 0; i < 2; i++) { const b = $$('#mag .daytabs button')[i]; if (b) { b.click(); await sleep(150); } }
    check('magnetometer chart rendered', !!document.querySelector('#mag-chart svg'));
    check('satellite panel rendered', /Clouds from space/.test((document.querySelector('#sat') || {}).textContent || ''));
    $$('details').forEach((d) => { d.open = true; });
    await sleep(400);
    check('live tiles rendered', $$('#live-tiles .tile').length >= 6 && !/not available/.test(document.querySelector('#lt-hp .s').textContent));
    // Scrolling: every tab must land its section just under the header, the title must go to the very top
    const hdr = () => document.querySelector('.topbar').offsetHeight;
    const atBottom = () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    for (const a of $$('#tabs a')) {
      window.scrollTo({ top: 0, behavior: 'instant' });
      await sleep(100);
      a.click();
      await sleep(1800);
      const el = document.querySelector(a.getAttribute('href'));
      const top = el ? el.getBoundingClientRect().top : -999;
      check(`tab "${a.textContent}" lands under the header`, el && (Math.abs(top - (hdr() + 8)) <= 6 || (atBottom() && top >= hdr())),
        `section top ${Math.round(top)} px, header ${hdr()} px`);
    }
    window.scrollTo({ top: 2500, behavior: 'instant' });
    await sleep(100);
    document.querySelector('#home').click();
    await sleep(1800);
    check('title scrolls to the very top', window.scrollY <= 1, `scrollY ${window.scrollY}`);
    // Basic view: switch, check the one-screen summary, then a night card must open the advanced detail
    const bb = document.querySelector('#mode button[data-mode="basic"]');
    if (bb) {
      bb.click();
      await sleep(300);
      const b = document.querySelector('#basic');
      check('basic view shown', document.body.classList.contains('basic-mode') && b && b.offsetHeight > 100);
      const wx = await fetch('data/weather.json').then((r) => r.json()).catch(() => null);
      if (wx && wx.here && (wx.here.series || []).some((e) => new Date(e.t).getTime() >= Date.now() - 3600e3)) check('basic weather card rendered', /Weather here/.test(b.textContent));
      const over = /cruise nights are over/.test(b.textContent); // after the cruise: no "right now" card
      check('basic view has tonight and right now', /Tonight/.test(b.textContent) && (/Right now/.test(b.textContent) || over)
        && (!!b.querySelector('.b-verdict') || over || /No forecast for tonight/.test(b.textContent)));
      if (b.querySelector('.b-verdict')) check('basic aurora and sky tiles', b.querySelectorAll('#basic > .b-card:not(#b-last) .bfx .bf').length === 2);
      if (b.querySelector('#b-last')) check('basic last-night card has its two tiles', b.querySelectorAll('#b-last .bfx .bf').length === 2);
      // the morning card goes on top only once tonight's darkness is over, never in the middle of the night
      if (b.querySelector('#b-last')) check('basic morning card only after the night', !b.querySelector('.bstrip > div.past'));
      if (b.querySelector('#b-last')) check('basic last night has one hour strip', b.querySelectorAll('#b-last .pstrip').length <= 1);
      const lastCell = b.querySelector('#b-last .pstrip > div');
      if (lastCell) {
        lastCell.click();
        await sleep(100);
        check('basic last-night hour explains itself', /\d\d:00/.test(document.querySelector('#b-lastwhy').textContent));
      }
      const bh = b.querySelector('#b-hourly');
      if (bh) {
        check('basic detailed hourly is folded', !bh.open);
        bh.querySelector('summary').click();
        await sleep(300);
        check('basic detailed hourly opens with chart and hours', !!bh.querySelector('#b-chart svg') && !!bh.querySelector('.hr'));
        bh.querySelector('summary').click();
      }
      const vt = windowCheck(b);
      if (P.get('expect') === 'nowindow') {
        const sky = [...b.querySelectorAll('#basic > .b-card:not(#b-last) .bfx .bf')].map((x) => x.textContent).join(' | ');
        check('basic tonight: a window that is over is not the answer', vt && /^NO/.test(vt.textContent.trim()) && /Cloudy/.test(sky),
          `${vt ? vt.textContent.trim() : 'no verdict'} | ${sky}`);
      }
      const cell = b.querySelector('.bstrip > div');
      if (cell) {
        cell.click();
        await sleep(100);
        check('basic hour strip explains an hour', /\d\d:\d\d/.test(document.querySelector('#b-why').textContent) && !/Tap an hour/.test(document.querySelector('#b-why').textContent));
        cell.click();
        await sleep(100);
        check('basic hour strip: second tap clears the highlight', !cell.classList.contains('sel') && /Tap an hour/.test(document.querySelector('#b-why').textContent));
      }
      const card = b.querySelector('.bnc');
      if (card) {
        card.click();
        await sleep(400);
        check('basic night card opens the advanced detail', !document.body.classList.contains('basic-mode') && /Hour by hour|PAST/.test(document.querySelector('#night-detail').textContent));
      }
    }
    const ln = document.querySelector('#last-night');
    check('last night panel rendered (or hidden without data)', ln && (ln.style.display === 'none' || /Last night up north/.test(ln.textContent)));
    // "no CME" may only be said when NASA's service answered
    const latest = await fetch('data/latest.json').then((r) => r.json()).catch(() => null);
    const cme = latest && latest.sources && latest.sources.nasa_donki_cme;
    if (cme && !cme.ok) check('CME text does not claim "none" while NASA failed', !/none in NASA/.test(document.querySelector('#swpc-text').textContent));
    finish();
  }
  window.addEventListener('load', () => setTimeout(() => (P.get('tl') ? timeline().catch((e) => push('timeline: ' + e)).then(finish) : run()), 500));
})();
</script>"""


def find_chrome():
    for c in CHROMES:
        if Path(c).exists() or shutil.which(c):
            return c
    sys.exit("preflight: no Chrome/Edge found")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def make_site(dst, data_src):
    dst.mkdir(parents=True)
    for f in SITE_FILES:
        shutil.copy2(ROOT / f, dst / f)
    shutil.copytree(ROOT / "assets", dst / "assets")
    shutil.copytree(data_src, dst / "data")
    html = (dst / "index.html").read_text(encoding="utf-8")
    (dst / "_preflight.html").write_text(html.replace("<head>", "<head>" + INJECT, 1), encoding="utf-8")


SHIP_OFFSET = timedelta(hours=2)  # ship time = CEST
WARNINGS = []  # printed at the end, do not fail the run


def ship_today():
    return (datetime.now(timezone.utc) + SHIP_OFFSET).date()


def shifted_config(dst, target=None, on=None):
    """Copy of config/ with every itinerary date moved so that the cruise date `target` falls on `on`
    (default: the ship is in Tromsø today). Returns (days, itinerary)."""
    shutil.copytree(ROOT / "config", dst)
    p = dst / "itinerary.json"
    text = p.read_text(encoding="utf-8")
    it = json.loads(text)
    if target is None:
        tos = next(s for s in it["stops"] if s.get("id") == "TOS")
        target = datetime.fromisoformat(tos["arrive"].replace("Z", "+00:00")).date()
    days = (target - (on or ship_today())).days
    text = re.sub(r'"(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ)"', lambda m: '"' + (
        datetime.fromisoformat(m.group(1).replace("Z", "+00:00")) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ") + '"', text)
    # plain dates too: nights_from / nights_to and the watch nights
    text = re.sub(r'"(20\d\d-\d\d-\d\d)"', lambda m: '"' + (date.fromisoformat(m.group(1)) - timedelta(days=days)).isoformat() + '"', text)
    p.write_text(text, encoding="utf-8")
    return days, json.loads(text)


SLOTS = [(0, 18), (0, 21), (1, 0), (1, 3), (1, 6), (1, 9), (1, 12)]  # (day, hour) in ship time from today


def slot_clock(day, hour):
    """UTC time of `hour` ship time on today + day."""
    d = ship_today() + timedelta(days=day)
    return datetime(d.year, d.month, d.day, hour, tzinfo=timezone.utc) - SHIP_OFFSET


def prepare_set(tmp, name, target, on, base_env, problems):
    """A data set with the cruise moved (target date on `on`), built by the pipeline (update + weather)."""
    data, cfg = tmp / f"data-{name}", tmp / f"config-{name}"
    shutil.copytree(ROOT / "data", data)
    days, it = shifted_config(cfg, target, on)
    env = {**base_env, "AURORA_DATA": str(data), "AURORA_CONFIG": str(cfg)}
    for script in ("update.py", "weather.py"):
        run_script(script, [], env, problems, f"timeline {name} (cruise moved {days} days)")
    record_sources(data, f"timeline {name}")
    return data, env


def notify_check(env, data_dir, now_utc, label, problems):
    """The morning notification must only talk about nights that are not over yet."""
    sys.path.insert(0, str(ROOT / "scripts"))
    from common import night_end  # noqa: E402
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "notify.py"), "--dry-run", "--now", now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")],
                       cwd=ROOT / "scripts", env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    if r.returncode:
        problems.append(f"{label}: notify.py exited {r.returncode}: {(r.stderr or r.stdout)[-300:]}")
        return
    latest = json.loads((data_dir / "latest.json").read_text(encoding="utf-8"))
    ends = {}
    for n in latest["nights"]:
        d = datetime.fromisoformat(n["date"])
        ends[d.strftime("%a %d %b")] = ends[d.strftime("%a %d")] = night_end(n)
    msgs = re.findall(r'"message": "(.*?)",\n', r.stdout)
    for m in re.finditer(r"\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d)( (?:Sep|Oct|Nov))?\b", " ".join(msgs)):
        key = m.group(1) + (m.group(2) or "")
        if key in ends and ends[key] <= now_utc:
            problems.append(f"{label}: notification mentions {key}, a night that is over: {' '.join(msgs)[:200]}")
            return
    if not msgs:
        problems.append(f"{label}: no morning notification in the dry run (expected one between 08:00 and 12:00)")


def timeline_checks(name, results, problems):
    """Across the slots of one data set: tonight stays put through the night, moves on by noon, never comes back;
    the morning card only between the end of darkness and noon."""
    by = {k: s for k, s in results if s}
    night = [by[k]["tonight"] for k in ("D0 18:00", "D0 21:00", "D1 00:00", "D1 03:00") if k in by]
    if len(set(night)) > 1:
        problems.append(f"timeline {name}: 'tonight' changes during the night: {night}")
    if "D0 18:00" in by and "D1 12:00" in by and by["D0 18:00"]["tonight"] == by["D1 12:00"]["tonight"]:
        problems.append(f"timeline {name}: 'tonight' did not move on by noon: {by['D1 12:00']['tonight']}")
    seen = []
    for k, s in results:
        if not s:
            continue
        if seen and s["tonight"] != seen[-1] and s["tonight"] in seen:
            problems.append(f"timeline {name}: 'tonight' went back to {s['tonight']} at {k}")
        if not seen or s["tonight"] != seen[-1]:
            seen.append(s["tonight"])
        if s["morning"] and k.split()[1] in ("18:00", "21:00", "00:00", "03:00", "15:00"):
            problems.append(f"timeline {name}: morning card shown at {k}")


QUOTA = re.compile(r"429|Too Many Requests|limit exceeded", re.I)


def source_problems(data_dir, label, warnings=None):
    """Every data source of the last pipeline run must have answered (a dead API must not pass silently:
    the NASA CME service moved on 30 Sep 2026 and the page went on saying "no CME"). A used-up request
    quota of this computer (HTTP 429, e.g. after many test runs in a day) is only a warning when `warnings`
    is given: the robot runs on GitHub's machines with their own quota."""
    out = []
    for f in ("latest.json", "weather.json"):
        js = json.loads((data_dir / f).read_text(encoding="utf-8")) if (data_dir / f).exists() else {}
        for k, v in (js.get("sources") or {}).items():
            if not v.get("ok"):
                msg = f"{label}: data source {k} failing in {f}: {v.get('error', '')[:160]}"
                (warnings if warnings is not None and QUOTA.search(v.get("error", "")) else out).append(msg)
    return out


SIM_RUNS = []   # labels of the pipeline runs on copies
SIM_FAILS = {}  # data source -> messages from those runs


def record_sources(data_dir, label):
    """Pipeline runs on copies: remember the failing sources, judged together at the end."""
    SIM_RUNS.append(label)
    for msg in source_problems(data_dir, label):
        SIM_FAILS.setdefault(msg.split("data source ", 1)[1].split()[0], []).append(msg)


def sim_source_problems(problems, warnings):
    """A source failing in every pipeline run on copies is broken (like the NASA CME service that moved);
    failing in only some of them, or with a used-up quota of this computer, is a network hiccup: warning."""
    for src, msgs in SIM_FAILS.items():
        if len(msgs) >= len(SIM_RUNS) and not all(QUOTA.search(m) for m in msgs):
            problems.append(f"data source {src} failing in every pipeline run on copies: {msgs[0]}")
        else:
            warnings += msgs


def tonight_of(latest, d):
    """The night the Basic view shows as tonight on date d: the cruise night, else the Tromsø model check night."""
    return next((n for n in latest["nights"] if n["date"] == d), None) or next(
        (n for n in (latest.get("model_check") or {}).get("nights", []) if n["date"] == d and n.get("spot") == "Tromsø"), None)


def make_past_window(latest):
    """Tonight with its clear stretch already over (kept clouds, strong activity) and overcast for the rest of the
    night, at 03:30 ship time. Returns the clock (UTC) or None."""
    d = (latest.get("model_check") or {}).get("date")
    n = tonight_of(latest, d) if d else None
    if not n:
        return None
    clock = datetime.fromisoformat(d + "T01:30:00+00:00") + timedelta(days=1)  # 03:30 ship time
    n["clear"]["source"] = "MET Norway"
    for h in n["hourly"]:
        if not h["dark"]:
            continue
        if datetime.fromisoformat(h["t"].replace("Z", "+00:00")) + timedelta(hours=1) <= clock:
            h.update(cloud_met=5.0, cloud_past=True, p_act=0.9)  # over: clear and strong (a GO stretch)
        else:
            h.update(cloud_met=95.0)  # still to come: overcast
    return clock


def check_tonight_answer(problems):
    """The robot's tonight log must not answer with a window that is over either (update.tonight_answer)."""
    sys.path.insert(0, str(ROOT / "scripts"))
    import update  # noqa: E402  (scripts folder on the path only here)
    latest = json.loads((ROOT / "data" / "latest.json").read_text(encoding="utf-8"))
    clock = make_past_window(latest)
    if clock is None:
        return
    d = latest["model_check"]["date"]
    ans = update.tonight_answer(tonight_of(latest, d), clock)
    if ans["verdict"] != "NO" or ans["window"]:
        problems.append(f"update.tonight_answer answers with a window that is over: {ans['verdict']} {ans['window']}")


def run_script(name, args, env, problems, label):
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / name), *args], cwd=ROOT / "scripts", env=env,
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900)
    ok = r.returncode == 0
    print(f"  {'ok ' if ok else 'FAIL'} {label}: {name} {' '.join(args)}")
    if not ok:
        problems.append(f"{label}: {name} exited {r.returncode}: {(r.stderr or r.stdout).strip()[-800:]}")


def page_check(chrome, url, profile):
    r = subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        f"--user-data-dir={profile}", "--window-size=1100,1400", "--virtual-time-budget=120000",
                        "--dump-dom", url], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    m = re.search(r'<script type="application/json" id="pf-result">(.*?)</script>', r.stdout, re.S)
    if not m:
        return {"errors": ["the click-through did not finish (page did not load or timed out)"], "checks": []}
    return json.loads(m.group(1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="skip the pipeline runs")
    ap.add_argument("--keep", action="store_true", help="keep the temporary folder")
    args = ap.parse_args()
    problems = []

    print("1) compile and versions")
    sw_ver = re.search(r"aurora-v(\d+)", (ROOT / "sw.js").read_text(encoding="utf-8")).group(1)
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    for asset in ("assets/app.js", "assets/style.css"):
        if f"{asset}?v={sw_ver}" not in html:
            problems.append(f"index.html must load {asset}?v={sw_ver} (same number as the cache in sw.js)")
    for f in sorted((ROOT / "scripts").glob("*.py")) + [Path(__file__)]:
        try:
            py_compile.compile(str(f), doraise=True)
        except py_compile.PyCompileError as e:
            problems.append(f"compile {f.name}: {e.msg}")
    print(f"  {len(problems) == 0 and 'ok ' or 'FAIL'} scripts")
    # The published data comes from the robot's last run with the code that is live now, so a failing source there is
    # a warning (this push may be the fix); the pipeline runs below use the new code, and there it is an error.
    warnings = WARNINGS
    warnings += source_problems(ROOT / "data", "published data (robot's last run)")
    n0 = len(problems)
    check_tonight_answer(problems)
    print(f"  {len(problems) == n0 and 'ok ' or 'FAIL'} tonight log rule"
          + (f" · {len(warnings)} warning(s) about the published data" if warnings else ""))

    tmp = Path(tempfile.mkdtemp(prefix="aurora-preflight-"))
    web = tmp / "web"
    base_env = {**os.environ, "NTFY_TOPIC": "", "PYTHONIOENCODING": "utf-8"}
    now = datetime.now(timezone.utc)
    scenarios = []
    try:
        # As it is today (before the cruise).
        make_site(web / "now", ROOT / "data")
        scenarios.append(("today, as published", "now", 0))
        # Synthetic: tonight's clear stretch is already over and the rest of the night is overcast (03:30 ship time)
        make_site(web / "pastwin", ROOT / "data")
        pw = web / "pastwin" / "data" / "latest.json"
        latest_pw = json.loads(pw.read_text(encoding="utf-8"))
        clock_pw = make_past_window(latest_pw)
        if clock_pw:
            pw.write_text(json.dumps(latest_pw, ensure_ascii=False), encoding="utf-8")
            scenarios.append(("tonight: the window is over, overcast after", "pastwin", int((clock_pw - now).total_seconds()), "&expect=nowindow"))
        it = json.loads((ROOT / "config" / "itinerary.json").read_text(encoding="utf-8"))
        tos = next(s for s in it["stops"] if s.get("id") == "TOS")
        in_tromso = datetime.fromisoformat(tos["arrive"].replace("Z", "+00:00")) + timedelta(hours=11)
        if args.quick:
            # Only move the clock: on-board views with today's forecast data (no MET for those nights).
            scenarios.append(("clock only: in Tromsø", "now", int((in_tromso - now).total_seconds())))
            scenarios.append(("clock only: after the cruise", "now", int((in_tromso - now).total_seconds()) + 12 * 86400))
        else:
            print("2) pipeline on copies (dry-run, nothing sent)")
            data_now = tmp / "data-now"
            shutil.copytree(ROOT / "data", data_now)
            env = {**base_env, "AURORA_DATA": str(data_now), "AURORA_CONFIG": str(ROOT / "config")}
            run_script("alert.py", ["--dry-run"], env, problems, "today")
            run_script("notify.py", ["--dry-run"], env, problems, "today")

            data_ship = tmp / "data-ship"
            shutil.copytree(ROOT / "data", data_ship)
            days, it_s = shifted_config(tmp / "config-ship")
            env = {**base_env, "AURORA_DATA": str(data_ship), "AURORA_CONFIG": str(tmp / "config-ship")}
            label = f"cruise moved {days} days (in Tromsø today)"
            for name, a in [("update.py", []), ("weather.py", []), ("sky_log.py", []), ("mag_log.py", []), ("last_night.py", []),
                            ("notify.py", ["--dry-run"]), ("alert.py", ["--dry-run"])]:
                run_script(name, a, env, problems, label)
            tonight = (now + timedelta(hours=2)).replace(hour=19, minute=0, second=0, microsecond=0)
            run_script("alert.py", ["--dry-run", "--now", tonight.strftime("%Y-%m-%dT%H:%M:%SZ")], env, problems, label + ", 21:00")
            here = (json.loads((data_ship / "weather.json").read_text(encoding="utf-8")) or {}).get("here")
            if not here or not here.get("series"):
                problems.append(f"{label}: weather.json has no 'here' forecast (Basic weather card would be empty)")
            record_sources(data_ship, label)
            make_site(web / "ship", data_ship)
            end = datetime.fromisoformat(it_s["stops"][-1]["arrive"].replace("Z", "+00:00"))
            scenarios += [
                ("on board: in port (Tromsø) now", "ship", 0),
                ("on board: at sea tonight 03:00", "ship", int(((now + timedelta(days=1)).replace(hour=1, minute=0) - now).total_seconds())),
                ("on board: 4 days later", "ship", 4 * 86400),
                ("after the cruise", "ship", int((end + timedelta(days=1) - now).total_seconds())),
            ]

        # Timeline data sets: today as published (always), and in the full run three moved cruises.
        timeline = [("today", "now", SLOTS)]
        if not args.quick:
            from concurrent.futures import ThreadPoolExecutor
            dep = datetime.fromisoformat(it["stops"][0]["depart"].replace("Z", "+00:00")) + SHIP_OFFSET
            last = date.fromisoformat(it["nights_to"])
            jobs = {"departure": (dep.date(), ship_today() + timedelta(days=1)), "last-night": (last, ship_today())}
            with ThreadPoolExecutor(max_workers=2) as ex:
                futs = {k: ex.submit(prepare_set, tmp, k, t, on, base_env, problems) for k, (t, on) in jobs.items()}
                sets = {k: f.result() for k, f in futs.items()}
            for k, (data_k, env_k) in sets.items():
                make_site(web / k, data_k)
            timeline += [("Tromsø today", "ship", SLOTS),
                         ("departure tomorrow", "departure", SLOTS + [(1, 15), (1, 18)]),
                         ("last sea night today", "last-night", SLOTS + [(2, 20)])]
            # the morning notification after a few nights of the cruise are over
            notify_check({**base_env, "AURORA_DATA": str(data_ship), "AURORA_CONFIG": str(tmp / "config-ship")}, data_ship,
                         slot_clock(1, 8) + timedelta(minutes=20), "timeline Tromsø today: morning notification", problems)

        print("3) page checks in headless Chrome")
        port = free_port()
        server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "--directory", str(web)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            chrome = find_chrome()
            for name, site, clock, *extra in scenarios:
                res = page_check(chrome, f"http://127.0.0.1:{port}/{site}/_preflight.html?clock={clock}{''.join(extra)}", tmp / "chrome")
                failed = [c for c in res["checks"] if not c["ok"]]
                ok = not res["errors"] and not failed
                print(f"  {'ok ' if ok else 'FAIL'} {name}: {len(res['checks'])} checks, {len(res['errors'])} errors")
                for e in res["errors"]:
                    problems.append(f"{name}: JS error: {e}")
                for c in failed:
                    problems.append(f"{name}: check failed: {c['name']} {c['msg']}".rstrip())
            print("4) timeline")
            from concurrent.futures import ThreadPoolExecutor
            runs = [(name, site, f"D{d} {h:02d}:00", int((slot_clock(d, h) - datetime.now(timezone.utc)).total_seconds()))
                    for name, site, slots in timeline for d, h in slots]
            def one(i_run):
                i, (name, site, slot, clock) = i_run
                return name, slot, page_check(chrome, f"http://127.0.0.1:{port}/{site}/_preflight.html?clock={clock}&tl=1", tmp / f"chrome-tl{i % 4}")
            with ThreadPoolExecutor(max_workers=4) as ex:
                # four Chrome profiles, each used by one run at a time
                done = []
                for batch in range(0, len(runs), 4):
                    done += list(ex.map(one, list(enumerate(runs))[batch:batch + 4]))
            for name, _site, slots in timeline:
                res = [(slot, r) for n, slot, r in done if n == name]
                bad = 0
                for slot, r in res:
                    for e in r["errors"]:
                        problems.append(f"timeline {name} {slot}: JS error: {e}")
                    for c in r["checks"]:
                        if not c["ok"]:
                            problems.append(f"timeline {name} {slot}: {c['name']} {c['msg']}".rstrip())
                    bad += bool(r["errors"]) + sum(not c["ok"] for c in r["checks"])
                timeline_checks(name, [(slot, r.get("state")) for slot, r in res], problems)
                print(f"  {'ok ' if not bad else 'FAIL'} {name}: {len(res)} moments, " + " · ".join(
                    f"{slot.split()[1]} {(r.get('state') or {}).get('tonight', '?')}" for slot, r in res[:1] + res[-1:]))
            scenarios += [(f"timeline {name}", site, 0) for name, site, _ in timeline]
        finally:
            server.terminate()
    finally:
        if args.keep:
            print("temporary folder kept:", tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    sim_source_problems(problems, warnings)
    print()
    for w in warnings:
        print(" ! warning:", w)
    if problems:
        counts = {}
        for p in problems:
            counts[p] = counts.get(p, 0) + 1
        print(f"preflight: {len(counts)} problem(s)")
        for p, k in counts.items():
            print(" -", p + (f"  (×{k})" if k > 1 else ""))
        sys.exit(1)
    print(f"preflight: {len(scenarios)} scenarios, 0 errors")


if __name__ == "__main__":
    main()
