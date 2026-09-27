# Aurora Ops

Aurora forecast dashboard for the Sky Princess Norway cruise (10–24 Oct 2026).
Live at **https://zoltanhorogh.github.io/aurora/**

## How it works

- `scripts/update.py` runs every 3 hours (GitHub Actions). It pulls NOAA SWPC space-weather products,
  NASA DONKI CME model runs and Open-Meteo ECMWF/GFS ensemble cloud forecasts, scores every night of the
  cruise and writes `data/latest.json` plus a snapshot in `data/history.json`.
- Nightly chance = activity × clear sky × darkness × moon & lights
  - activity: P(Kp ≥ Kp needed at the ship's geomagnetic latitude), using NOAA 3-day → 27-day outlook → 27-day recurrence
  - clear sky: share of ensemble members with ≥ 2 consecutive dark hours at ≤ 40 % cloud, blended with the
    ERA5 October climatology (`data/climatology.json`) by lead time
- `scripts/alert.py` runs every 10 minutes and, during the cruise only, pushes an evening outlook and
  "go outside" alerts through [ntfy](https://ntfy.sh) (topic kept in the `NTFY_TOPIC` repository secret).
- `scripts/build_climatology.py` is a one-off that built the climatology file.

The ship position is interpolated from the published itinerary (`config/itinerary.json`), not tracked live.
