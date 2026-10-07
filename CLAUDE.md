# Aurora Ops: notes for Claude sessions

This repo is public. The page (GitHub Pages) is an aurora forecast for the owner's Norway cruise
(itinerary in `config/itinerary.json`). The owner often works from a phone.

## How to work with the owner
- Reply in Hungarian, in plain words. Bottom line first (1-3 sentences), details only if needed.
  End every reply with a separate `## Következő lépések` block and one question.
- Code, comments, commit messages: English only.
- Times: always ship time = Hungarian time (UTC+2 in October), labelled "ship time". Never bare UTC.
- Never edit or push without an agreed plan. Even when the owner names a fix: describe before -> after
  (exact text or a screenshot) and push only after an explicit OK ("mehet fel").
- Before each batch: `git tag before-audit-<X>` at HEAD; push the tag together with the batch.
- Before every push: `python tools/preflight.py` (about 10 min) and report its last line
  (`preflight: N scenarios, 0 errors`). Needs Chrome/Chromium and network access to the data sources.
- Push order: commit first, then `git pull --rebase`, then `git push` (the robots commit every 10 minutes).
- Every page change bumps the cache version: `?v=N` in `index.html` and `aurora-vN` in `sw.js`.
- Basic view stays simple. New numbers get their own big tile, not a footnote.
  Tables must fit a 390 px phone screen without sideways scrolling.
- Mind the token use: short answers, no long reports unless asked.

## Never publish
- No names or contact details, on the page or in the repo.
- Never print the ntfy topic (GitHub secret `NTFY_TOPIC`) and never echo any secret in a workflow:
  the Actions logs of a public repo are public.
- No planning spreadsheets or documents (`*.xlsx`, `*.docx`, `*.pdf` are gitignored).
- Link preview (OG tags) without ship name or dates.

## What runs where
- `scripts/update.py` -> `data/latest.json` (forecast, nights, model check). Workflow `update.yml`:
  hourly at :47 during the cruise, every 3 h otherwise; also dispatched hourly by cron-job.org.
- `scripts/alert.py` -> ntfy alerts; `sky_log.py` (all-sky camera AI log), `mag_log.py` (FMI magnetometers).
  Workflow `alert.yml`, dispatched every 10 min by cron-job.org (GitHub's own schedule has gaps).
  The two workflows wake each other up when the other one's data gets old.
- `scripts/weather.py` -> `data/weather.json` (ports, hikes, sea legs); `scripts/notify.py` (morning digest).
- `assets/app.js` + `assets/style.css` + `index.html`: the page (Basic and Advanced views); `sw.js` cache.
- `tools/preflight.py`: end-to-end checks of the pipeline and the page at several clock moments.

## Emergency (from the GitHub phone app)
- Page stale: Actions -> "Update forecast" -> Run workflow.
- Bad or too many alerts: Actions -> "Aurora alerts" -> ... -> Disable workflow.

## Decided rules (do not change without asking)
- Never say "Quiet" for aurora. Camera (Tromsø AI) is the sky truth near a camera (<= 60 km, picture <= 20 min).
- Substorm = a nearby station <= -50 nT, or a 50 nT change within 10 min. "Clear" = <= 40% cloud, a clear
  stretch = 2+ dark hours.
- Alert texts keep clouds, magnetometer, Hp30 and solar wind speed; no "needs Kp", Bz or OVATION.
- Declined, do not re-propose: long night-run job, Pushover, Alta as practice spot, wave/port-wind checks,
  Tromsø AI site pictures in Advanced.
