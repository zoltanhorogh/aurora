# Aurora Ops

Aurora forecast dashboard for the Sky Princess Norway cruise (10–24 Oct 2026).
Live at **https://zoltanhorogh.github.io/aurora/**

## How it works

- `scripts/update.py` runs every 3 hours, and every hour during the cruise (GitHub Actions). It pulls NOAA SWPC
  space-weather products, NASA CCMC DONKI CME model runs, MET Norway cloud forecasts and Open-Meteo ECMWF/GFS
  ensembles, scores every night of the cruise and writes `data/latest.json` plus a snapshot in `data/history.json`.
- Nightly chance = activity × clear sky × darkness × moon & lights
  - activity: P(Kp ≥ Kp needed at the ship's geomagnetic latitude), using NOAA 3-day → 27-day outlook → 27-day
    recurrence, raised in the window of a modelled CME arrival
  - clear sky: MET Norway's 2.5 km model once it covers the night (≥ 2 consecutive dark hours with ≤ 40 % cloud);
    further ahead the share of ensemble members with such a gap, blended with the ERA5 October climatology
    (`data/climatology.json`) by lead time
- Inland cloud check: for the dark hours in Tromsø and Alta (and Tromsø every night before the cruise) MET Norway's
  clouds at the usual chase-tour areas behind the coastal mountains (`INLAND` in `update.py`); the page says whether
  one of them has a clear stretch still to come that here has not.
- A night is over when its darkness ends at its place; it then keeps its last forecast, and the page shows what
  happened instead (MET Norway's cloud analysis, GFZ Hp30, the all-sky camera AI, the FMI magnetometers).
- `scripts/alert.py` runs every 10 minutes after `sky_log.py` (all-sky camera AI, the most auroral picture of each
  hour) and `mag_log.py` (FMI magnetometers). Before the cruise it sends test alerts; on board an evening outlook
  and "go outside" alerts through [ntfy](https://ntfy.sh) (topic in the `NTFY_TOPIC` repository secret).
  Measured activity is Hp30 (GFZ Potsdam), never NOAA's 1-minute Kp.
- `scripts/notify.py`: morning digest and change alerts, only about nights that are not over.
- `scripts/weather.py`: port, hike and sea forecasts, MET Norway warnings, and the hourly weather where you are.
- `tools/preflight.py` must pass before every push: it runs the pipeline on moved copies of the cruise and checks
  the page in headless Chrome at many moments (`--quick`, default, `--timeline` for every day of the trip).

The ship position is interpolated from the published itinerary (`config/itinerary.json`), not tracked live.

Data: NOAA SWPC, NASA CCMC DONKI, MET Norway (CC BY 4.0), GFZ Potsdam Hp30 (CC BY 4.0), Open-Meteo (CC BY 4.0),
FMI IMAGE magnetometers (CC BY 4.0), Tromsø Geophysical Observatory, UiT and IRF all-sky cameras, Tromsø AI (UEC).
`tools/fixtures/` holds one real evening (1 Oct 2026) of FMI magnetometer and GFZ Hp30 data for the checks.
