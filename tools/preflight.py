"""Preflight check before every push.

1. Compiles every Python script.
2. Runs the pipeline scripts on a temporary copy of the data (dry-run for notifications), once as it is
   and once with the cruise moved so that the ship is in Tromsø today: then the on-board views
   (tonight with MET, past nights, far nights, ports) are built from real, current data.
3. Opens the page in headless Chrome in several situations (clock set to different moments), clicks
   every night, model-check day and spot, weather tab and magnetometer tab, opens every dropdown,
   and reports any JavaScript error plus a few consistency checks.

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
    check('live tiles rendered', $$('#live-tiles .tile').length >= 7);
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
      check('basic view has tonight and right now', /Tonight/.test(b.textContent) && /Right now/.test(b.textContent)
        && (!!b.querySelector('.b-verdict') || /cruise is over|No forecast for tonight/.test(b.textContent)));
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
      const cell = b.querySelector('.bstrip > div');
      if (cell) {
        cell.click();
        await sleep(100);
        check('basic hour strip explains an hour', /\d\d:\d\d/.test(document.querySelector('#b-why').textContent) && !/Tap an hour/.test(document.querySelector('#b-why').textContent));
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
    const out = document.createElement('script');
    out.type = 'application/json';
    out.id = 'pf-result';
    out.textContent = JSON.stringify({ errors, checks, clock: new Date().toISOString() }).replace(/</g, '\\u003c');
    document.body.appendChild(out);
  }
  window.addEventListener('load', () => setTimeout(run, 500));
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


def shifted_config(dst):
    """Copy of config/ with the cruise moved so the ship is in Tromsø today. Returns (days, itinerary)."""
    shutil.copytree(ROOT / "config", dst)
    p = dst / "itinerary.json"
    text = p.read_text(encoding="utf-8")
    it = json.loads(text)
    tos = next(s for s in it["stops"] if s.get("id") == "TOS")
    days = (datetime.fromisoformat(tos["arrive"].replace("Z", "+00:00")).date() - date.today()).days
    text = re.sub(r'"(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ)"', lambda m: '"' + (
        datetime.fromisoformat(m.group(1).replace("Z", "+00:00")) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ") + '"', text)
    text = re.sub(r'("nights_(?:from|to)":\s*)"(\d{4}-\d\d-\d\d)"', lambda m: m.group(1) + '"' + (
        date.fromisoformat(m.group(2)) - timedelta(days=days)).isoformat() + '"', text)
    p.write_text(text, encoding="utf-8")
    return days, json.loads(text)


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

    tmp = Path(tempfile.mkdtemp(prefix="aurora-preflight-"))
    web = tmp / "web"
    base_env = {**os.environ, "NTFY_TOPIC": "", "PYTHONIOENCODING": "utf-8"}
    now = datetime.now(timezone.utc)
    scenarios = []
    try:
        # As it is today (before the cruise).
        make_site(web / "now", ROOT / "data")
        scenarios.append(("today, as published", "now", 0))
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
            make_site(web / "ship", data_ship)
            end = datetime.fromisoformat(it_s["stops"][-1]["arrive"].replace("Z", "+00:00"))
            scenarios += [
                ("on board: in port (Tromsø) now", "ship", 0),
                ("on board: at sea tonight 03:00", "ship", int(((now + timedelta(days=1)).replace(hour=1, minute=0) - now).total_seconds())),
                ("on board: 4 days later", "ship", 4 * 86400),
                ("after the cruise", "ship", int((end + timedelta(days=1) - now).total_seconds())),
            ]

        print("3) page checks in headless Chrome")
        port = free_port()
        server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "--directory", str(web)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            chrome = find_chrome()
            for name, site, clock in scenarios:
                res = page_check(chrome, f"http://127.0.0.1:{port}/{site}/_preflight.html?clock={clock}", tmp / "chrome")
                failed = [c for c in res["checks"] if not c["ok"]]
                ok = not res["errors"] and not failed
                print(f"  {'ok ' if ok else 'FAIL'} {name}: {len(res['checks'])} checks, {len(res['errors'])} errors")
                for e in res["errors"]:
                    problems.append(f"{name}: JS error: {e}")
                for c in failed:
                    problems.append(f"{name}: check failed: {c['name']} {c['msg']}".rstrip())
        finally:
            server.terminate()
    finally:
        if args.keep:
            print("temporary folder kept:", tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    print()
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
