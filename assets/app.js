(() => {
  'use strict';

  const OFFSET_H = 2; // ship time = CEST (UTC+2)
  const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];
  const RATING = { GOOD: ['good', '▲'], FAIR: ['warn', '◆'], LOW: ['serious', '▼'], POOR: ['critical', '✕'] };
  const RATING_HEX = { GOOD: '#0ca30c', FAIR: '#fab219', LOW: '#ec835a', POOR: '#d03b3b' };
  const KEY_NIGHTS = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
  const SWPC = 'https://services.swpc.noaa.gov';
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const pct = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
  const shipDate = (t) => new Date(new Date(t).getTime() + OFFSET_H * 3600e3); // read with getUTC*
  const hm = (t) => { const d = shipDate(t); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); };
  const dayLabel = (s) => { const d = new Date(s + 'T12:00:00Z'); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const shortDay = (s) => { const d = new Date(s + 'T12:00:00Z'); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const shortPlace = (p) => String(p).replace(/^At sea \((.*)\)$/, 'At sea · $1');
  const chip = (r) => `<span class="chip ${RATING[r][0]}">${RATING[r][1]} ${r}</span>`;
  const CONF_LEVEL = { 'Trend only': 1, Low: 2, Medium: 3, High: 4 };
  const confSig = (c, withWord) => {
    const lv = CONF_LEVEL[c] || 1;
    const bars = [1, 2, 3, 4].map((i) => `<i style="height:${3 + i * 2.5}px" class="${i <= lv ? 'on' : ''}"></i>`).join('');
    return `<span class="sig" title="Confidence: ${c}"><span class="bars">${bars}</span>${withWord ? 'Confidence: ' : ''}${c}</span>`;
  };
  const eventAt = (n, kind) => (n.events || []).find((e) => e.kind === kind);
  const darkText = (n) => {
    const s = eventAt(n, 'sunset'), a = eventAt(n, 'dark_start'), b = eventAt(n, 'dark_end');
    return (s ? `sunset ${s.local} · ` : '') + `dark ${a ? a.local : n.dark.start}–${b ? b.local : n.dark.end}`;
  };
  const kpNeedText = (k) => (k < 1 ? 'even quiet activity (Kp 0–1) is enough here' : `needs about Kp ${k.toFixed(0)}+ here`);
  const ago = (t) => {
    const m = (Date.now() - new Date(t)) / 60000;
    if (m < 60) return Math.max(1, Math.round(m)) + ' min ago';
    if (m < 48 * 60) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' days ago';
  };

  let D = null;      // latest.json
  let HIST = null;   // history.json
  let VER = null;    // verification.json
  let WX = null;     // weather.json
  let SKY = null;    // sky_obs.json (all-sky camera AI, hourly)
  let LOG = null;    // cruise_log.json (evening forecast + what happened, per cruise night)
  let LAST = null;   // last_night.json (summary of the last finished night up north)
  let TLOG = null;   // tonight_log.json (tonight's basic answer at every forecast run)
  let HP30 = null;   // freshest Hp30 series: data/hp30.json (every 30 min on board) or latest.json
  let MAG = null;    // mag.json (FMI magnetometer swing, every 10 min after dark)
  let selected = null;
  let bzPts = null;  // loaded on demand

  async function getJSON(url) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' → ' + r.status);
    return r.json();
  }

  function tonightDate() {
    const s = shipDate(Date.now());
    if (s.getUTCHours() < 12) s.setUTCDate(s.getUTCDate() - 1);
    const iso = s.toISOString().slice(0, 10);
    return D.nights.some((n) => n.date === iso) ? iso : null;
  }

  function shipNow() {
    const now = Date.now();
    let best = null, bestDt = Infinity;
    for (const r of D.route_hourly) {
      const dt = Math.abs(new Date(r[0]) - now);
      if (dt < bestDt) { bestDt = dt; best = r; }
    }
    const sailing = now >= new Date(D.trip.start) && now <= new Date(D.trip.end);
    return { lat: best[1], lon: best[2], state: best[3], place: best[4], sailing };
  }

  // ------------------------------------------------------------ freshness
  function renderFresh() {
    const ageH = (Date.now() - new Date(D.generated)) / 3600e3;
    const failing = Object.entries(D.sources).filter(([, v]) => !v.ok).map(([k]) => k);
    const cls = ageH > 12 ? 'bad' : ageH > 5 || failing.length ? 'warn' : '';
    $('#fresh').innerHTML = `<span class="dot ${cls}"></span>Updated ${ago(D.generated)}`;
    $('#fresh').title = failing.length ? 'Some sources failed last run: ' + failing.join(', ') : 'All data sources OK';
    $('#sources').innerHTML = 'Last run ' + esc(new Date(D.generated).toUTCString()) + ' · sources: ' +
      Object.entries(D.sources).map(([k, v]) => `${esc(k)} ${v.ok ? '✓' : '✕'}`).join(' · ');
  }

  // ------------------------------------------------------------ phase
  function renderPhase() {
    const now = Date.now();
    const start = new Date(D.trip.start).getTime();
    const end = new Date(D.trip.end).getTime();
    // Fixed phase starts (UTC), each tied to when a forecast reaches the nights that matter
    const steps = [
      ['Trend', '27-day outlook + climate', null],
      ['Early weather', 'ensemble clouds gain weight', '2026-09-27T16:00:00Z'], // global models reach the first Arctic night (16 days)
      ['Sharpening', 'cloud forecasts become useful', '2026-10-04T16:00:00Z'], // MET's 9-day forecast reaches Tromsø and Alta
      ['Final days', 'NOAA 3-day Kp, CME models', '2026-10-07T15:00:00Z'], // the 3 days before departure
      ['On board', 'live nowcast + alerts', D.trip.start],
    ];
    const idx = now > end ? 5 : steps.reduce((k, s, i) => (s[2] && now >= new Date(s[2]).getTime() ? i : k), 0);
    const when = (i) => (i === 0 ? `until ${shortDay(shipDate(steps[1][2]).toISOString().slice(0, 10))}`
      : `from ${shortDay(shipDate(steps[i][2]).toISOString().slice(0, 10))}${i === 4 ? ` ${hm(steps[i][2])}` : ''}`);
    const meaning = [
      'Right now only the <b>general trend</b> is known: the Sun\'s 27-day rhythm and how cloudy October usually is. Treat the percentages as typical odds, not a forecast.',
      'Weather models start to reach the cruise, but at this range they are only a little better than climate. Watch the <b>trend chart</b>: consistent moves matter more than single values.',
      'Cloud forecasts are now genuinely useful. Space weather beyond 3 days is still a trend.',
      'NOAA\'s 3-day Kp forecast covers the nights and any solar eruption heading our way is modelled. This is as good as it gets before the night itself.',
      'On board: check <b>Live now</b> in the evening. Alerts fire when activity, clear sky and darkness line up.',
      'The cruise is over. Hope you saw it!',
    ][idx];
    let big;
    if (now < start) {
      const d = Math.floor((start - now) / 864e5), h = Math.floor(((start - now) % 864e5) / 3600e3);
      big = `T–${d} d ${h} h <span class="hint" style="font-size:14px;font-weight:400">to departure</span>`;
    } else if (now <= end) {
      big = `Day ${Math.floor((now - start) / 864e5) + 1} <span class="hint" style="font-size:14px;font-weight:400">of 14 · ${esc(shortPlace(shipNow().place))}</span>`;
    } else big = 'Welcome home';
    $('#phase').innerHTML = `
      <div class="phase-head"><div class="countdown">${big}</div></div>
      <div class="steps">${steps.map((s, i) => `<div class="step ${i < idx ? 'done' : i === idx ? 'now' : ''}"><b>${s[0]}</b><span>${s[1]}</span><small>${when(i)}</small></div>`).join('')}</div>
      <div class="hint" style="color:var(--text-2)">${meaning}</div>`;
  }

  // ------------------------------------------------------------ gauge + factors
  function gauge(score, r) {
    const R = 64, C = 2 * Math.PI * R, v = Math.max(0, Math.min(1, score));
    return `<svg viewBox="0 0 160 160" width="170" height="170" role="img" aria-label="Chance ${pct(score)}">
      <circle cx="80" cy="80" r="${R}" fill="none" stroke="#24262b" stroke-width="12"/>
      <circle cx="80" cy="80" r="${R}" fill="none" stroke="${RATING_HEX[r]}" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${(C * v).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 80 80)"/>
      <text x="80" y="86" text-anchor="middle" fill="#fff" font-size="34" font-weight="700" font-family="system-ui">${pct(score)}</text>
      <text x="80" y="108" text-anchor="middle" fill="#898781" font-size="11" font-family="system-ui">chance of aurora</text>
    </svg>`;
  }

  function factorRows(n) {
    const c = n.clear, a = n.activity;
    const clearWhy = c.p_met != null
      ? `<b>Source: MET Norway</b> (2.5 km local model): ${esc(c.met_note)}`
      : `<b>Source: global models + climate</b> · ` + (c.p_ens != null
        ? `${pct(c.p_ens)} of ${c.members} runs (${c.models.join(' + ')}) show a clear gap · October climate: ${pct(c.p_clim)} · model weight ${pct(c.weight)} · MET Norway takes over ~2.5 days before`
        : `no weather model reaches this night yet; in past Octobers ${pct(c.p_clim)} of nights here had a clear gap`);
    const need = kpNeedText(n.kp_req);
    const rows = [
      ['Aurora strong enough', n.factors.activity, `${need[0].toUpperCase() + need.slice(1)} · forecast Kp ≈${a.kp != null ? a.kp.toFixed(1) : '–'} (${esc(a.kp_src || '–')})`],
      ['Clear-sky chance', n.factors.clear, clearWhy],
      ['Darkness', n.factors.darkness, `Dark ${n.dark.start}–${n.dark.end} ship time (${n.dark.hours} h)`],
      ['Moon & lights', n.factors.moon_lights, `Moon ${Math.round(n.moon.illum * 100)}% lit, up ${pct(n.moon.up_frac_dark)} of the dark hours${n.state === 'port' ? ' · in port (town lights)' : ' · at sea (darkest skies)'}`],
    ];
    return `<div class="factors">${rows.map(([k, v, why]) => `
      <div class="factor"><div class="name">${k}</div><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div><div class="val">${pct(v)}</div><div class="why">${why}</div></div>`).join('')}
    </div>`;
  }

  function formula(n) {
    const f = n.factors;
    return `<div class="formula">Chance = aurora ${pct(f.activity)} × clear-sky ${pct(f.clear)} × darkness ${pct(f.darkness)} × moon &amp; lights ${pct(f.moon_lights)} = <b style="color:#fff">${pct(n.score)}</b>
      · ${confSig(n.confidence, true)} · looking ${n.lead_days > 0 ? n.lead_days.toFixed(1) + ' days ahead' : 'at tonight'}</div>`;
  }

  // ------------------------------------------------------------ hero
  function renderHero() {
    const t = tonightDate();
    let n, kicker;
    if (t) { n = D.nights.find((x) => x.date === t); kicker = 'Tonight'; }
    else {
      n = D.nights.reduce((b, x) => (x.score > b.score ? x : b), D.nights[0]);
      kicker = new Date() > new Date(D.trip.end) ? 'Best night of the cruise' : 'Best night in the current outlook';
    }
    $('#hero').innerHTML = `
      <div class="gauge-wrap">
        <div class="kicker">${kicker}</div>
        ${gauge(n.score, n.rating)}
        <div>${chip(n.rating)}</div>
        <div class="place">${esc(shortPlace(n.place))}</div>
        <div class="when">${dayLabel(n.date)} · ${darkText(n)}</div>
      </div>
      <div style="display:grid;gap:12px">
        ${factorRows(n)}
        <ul class="notes">${n.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        ${formula(n)}
      </div>`;
  }

  // ------------------------------------------------------------ night cards
  // ------------------------------------------------------------ past nights (during the cruise)
  // A night is over at 06:00 ship time the next morning. Then its card shows what happened instead of an old forecast.
  const isPast = (n) => Date.now() > new Date(n.date + 'T04:00:00Z').getTime() + 864e5;
  const CAMS = [['tromso', 'Tromsø camera', 69.65, 18.96], ['skibotn', 'Skibotn camera', 69.35, 20.36], ['kiruna', 'Kiruna camera', 67.84, 20.41]];
  // The all-sky camera near the ship that night (within 250 km), with its hourly AI log.
  function camNear(n) {
    const R = Math.PI / 180;
    const km = (la, lo) => 6371 * Math.acos(Math.min(1, Math.sin(n.lat * R) * Math.sin(la * R) + Math.cos(n.lat * R) * Math.cos(la * R) * Math.cos((n.lon - lo) * R)));
    const c = CAMS.map(([id, name, la, lo]) => ({ id, name, km: km(la, lo) })).sort((a, b) => a.km - b.km)[0];
    const hrs = c.km <= 250 && SKY && SKY.nights && SKY.nights[n.date] && SKY.nights[n.date][c.id];
    const pick = (w) => Object.keys(hrs).filter((h) => camWord(hrs[h]) === w).sort(hourOrder);
    return hrs ? { name: c.name, hrs, aurora: pick('aurora'), possible: pick('possible aurora') } : null;
  }
  const span = (arr) => (arr.length ? `${arr[0]}–${arr[arr.length - 1]}` : '');
  // One word for an hour of the camera AI log ("bright" = moonlit sky the AI calls dusk/dawn).
  const camWord = (v) => (v.aurora >= 50 ? 'aurora' : (v.bright || 0) >= 30 ? 'possible aurora' : v.dusk >= 50 ? 'bright (moon)'
    : v.clear >= 50 ? 'clear' : v.cloudy >= 50 ? 'cloudy' : 'mixed');
  const hourOrder = (a, b) => ((+a + 12) % 24) - ((+b + 12) % 24);
  function pastSummary(n) {
    const rec = LOG && LOG.nights && LOG.nights[n.date];
    const o = rec && rec.observed, f = rec && rec.forecast, cam = camNear(n);
    let head, cls;
    if (cam && cam.aurora.length) [head, cls] = [`Aurora seen ${span(cam.aurora.map((h) => h + ':00'))}`, 'ok'];
    else if (cam && cam.possible.length) [head, cls] = [`Possible aurora ${span(cam.possible.map((h) => h + ':00'))} (bright sky)`, 'ok'];
    else if (o && !o.clear_dark.length) [head, cls] = ['Cloudy all night', 'why'];
    else if (o && o.hp30_max_dark != null && o.hp30_max_dark >= o.kp_needed) [head, cls] = [`Clear and active: aurora likely (${span(o.clear_dark)})`, 'ok'];
    else if (o) [head, cls] = [`Clear ${o.clear_dark.length} h, but too quiet here`, 'why'];
    else [head, cls] = ['Result soon', 'why'];
    const lines = [
      f ? `Forecast that evening: ${pct(f.score)} ${f.rating}` : 'No evening forecast recorded',
      o ? `Hp30 max ${o.hp30_max_dark != null ? o.hp30_max_dark.toFixed(1) : '–'} (needed ≈${o.kp_needed})` : 'MET analysis arrives in the morning',
      cam ? `${cam.name}: ${cam.aurora.length ? 'aurora' : cam.possible.length ? 'possible aurora' : 'no aurora'} (${Object.keys(cam.hrs).length} h checked)` : '',
    ].filter(Boolean);
    return { head, cls, lines, rec, o, f, cam };
  }

  // ------------------------------------------------------------ last night up north
  function renderLastNight() {
    const el = $('#last-night');
    if (!el) return;
    if (!LAST || !LAST.date) { el.style.display = 'none'; return; }
    const L = LAST;
    const hs = (hours) => hours.reduce((g, h) => ((g.length && (+g[g.length - 1][g[g.length - 1].length - 1] + 1) % 24 === +h)
      ? (g[g.length - 1].push(h), g) : [...g, [h]]), []).map((x) => `${x[0]}–${pad((+x[x.length - 1] + 1) % 24)}`).join(', ');
    const mag = (L.mag || []).map((m) => `${esc(m.name)} ${m.min} nT at ${m.at} <span class="why">(${m.level})</span>`).join(' · ');
    const cams = (L.cams || []).map((c) => `${esc(c.name)}: ${c.aurora.length ? `<span class="ok">aurora ${hs(c.aurora)}</span>`
      : c.possible.length ? `<span class="ok">possible aurora ${hs(c.possible)}</span> <span class="why">(bright sky)</span>`
      : c.cloudy * 2 >= c.checked ? 'cloudy' : c.bright * 2 >= c.checked ? 'bright sky (moon)' : c.clear ? 'clear, no aurora' : 'mixed'}`).join(' · ');
    const clouds = (L.clouds || []).map((c) => `${esc(c.spot)}: ${c.clear_dark == null ? '<span class="why">MET analysis after the morning update</span>'
      : c.clear_dark.length ? `<span class="ok">clear ${c.clear_dark[0]}–${c.clear_dark[c.clear_dark.length - 1]}</span>` : 'cloudy all night'}`).join(' · ');
    const alerts = (L.alerts || []).map((a) => `${a.kind}${a.count > 1 ? ` ×${a.count}` : ''} (${a.last})`).join(' · ');
    const row = (k, v) => (v ? `<div class="ln-row"><span class="k">${k}</span><span>${v}</span></div>` : '');
    el.style.display = '';
    el.innerHTML = `<summary><b>Last night up north</b> <span class="why">· ${shortDay(L.date)}–${shortDay(new Date(new Date(L.date + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10))}, 18:00–06:00</span></summary>
      <div class="pastres ${/^Aurora on|^Possible/.test(L.headline) ? 'ok' : 'why'}" style="margin:4px 0 8px">${esc(L.headline)}</div>
      ${row('Cameras', cams)}${row('Magnetometers', mag)}${row('Activity', L.hp30 ? `Hp30 max ${L.hp30.max.toFixed(1)} at ${L.hp30.at}` : '')}
      ${row('Clouds (MET)', clouds)}${row('Alerts sent', alerts)}
      <p class="hint" style="margin:6px 0 0">Cameras: all-sky camera AI, checked hourly · magnetometers: lowest point vs quiet level (−50 active, −200 strong) · clouds: MET Norway's analysis afterwards.</p>`;
  }

  function renderCards() {
    const t = tonightDate();
    $('#night-cards').innerHTML = D.nights.map((n) => isPast(n) ? (() => {
      const s = pastSummary(n);
      return `
      <button class="night past ${n.date === selected ? 'sel' : ''}" data-date="${n.date}">
        <div class="d">${dayLabel(n.date)} <span class="tag-past">PAST</span></div>
        <div class="p">${esc(shortPlace(n.place))}</div>
        <div class="pastres ${s.cls}">${esc(s.head)}</div>
        <div class="mini">${s.lines.map(esc).join('<br>')}</div>
      </button>`;
    })() : `
      <button class="night ${n.date === selected ? 'sel' : ''} ${n.date === t ? 'tonight' : ''}" data-date="${n.date}">
        <div class="d">${dayLabel(n.date)}</div>
        ${n.mlat >= 64.5 ? '<span class="tag-arctic">ARCTIC</span>' : ''}
        <div class="p">${esc(shortPlace(n.place))}</div>
        <div class="pct">${pct(n.score)}</div>
        <div>${chip(n.rating)}</div>
        <div class="mini">Aurora ${pct(n.factors.activity)} × Clear-sky ${pct(n.factors.clear)}${n.factors.darkness * n.factors.moon_lights < 0.95 ? ` × dark &amp; moon ${pct(n.factors.darkness * n.factors.moon_lights)}` : ''} = ${pct(n.score)}${n.clear.p_met != null ? ' <span class="mettag">MET</span>' : ''}</div>
        ${confSig(n.confidence, false)}
      </button>`).join('');
    document.querySelectorAll('.night').forEach((b) => b.addEventListener('click', () => {
      selected = b.dataset.date;
      renderCards();
      renderDetail();
      scrollToY(yOf($('#night-detail')));
    }));
  }

  // ------------------------------------------------------------ generic chart helpers
  // Charts are drawn at the container's real pixel width, so 11px text stays 11px on a phone.
  const widthOf = (cont) => Math.max(300, Math.min(1000, cont.clientWidth || 700));
  const svgTag = (W, H, label, g) => `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${g}</svg>`;

  function tipBox(container) {
    let tip = container.querySelector('.tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; container.appendChild(tip); }
    return tip;
  }
  function bindHover(container, W, bands, htmlFor, onBand) {
    const svg = container.querySelector('svg');
    const tip = tipBox(container);
    const hide = () => { tip.style.display = 'none'; onBand && onBand(-1); };
    const handler = (ev) => {
      const rect = svg.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * W;
      const i = bands.findIndex(([a, b]) => x >= a && x < b);
      if (i < 0) { hide(); return; }
      onBand && onBand(i);
      tip.innerHTML = htmlFor(i);
      tip.style.display = 'block';
      const cw = container.clientWidth, tw = tip.offsetWidth;
      const cx = ((bands[i][0] + bands[i][1]) / 2 / W) * cw;
      let left = cx + 12;
      if (left + tw > cw) left = cx - tw - 12;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = '6px';
    };
    svg.addEventListener('pointermove', handler);
    svg.addEventListener('pointerdown', handler);
    // Mouse: hide when the pointer leaves. Touch: keep the tooltip after the finger lifts,
    // until the user taps somewhere else (see the document listener below).
    svg.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') hide(); });
    openTips.add({ container, hide });
  }
  const openTips = new Set();
  document.addEventListener('pointerdown', (ev) => {
    for (const t of openTips) {
      if (!document.contains(t.container)) { openTips.delete(t); continue; } // chart was re-rendered
      if (!t.container.contains(ev.target)) t.hide();
    }
  });
  const roundTopBar = (x, y, w, h, r = 4) => {
    if (h <= 0) return '';
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  };
  const gridY = (y, x0, x1, vals, fmt) => vals.map((v, i) =>
    `<line x1="${x0}" x2="${x1}" y1="${y(v)}" y2="${y(v)}" stroke="${i === 0 ? '#383835' : '#2c2c2a'}"/>` +
    `<text x="${x0 - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('');
  const hlBand = (hl, bands, i, top, h) => { hl.innerHTML = i < 0 ? '' : `<rect x="${bands[i][0]}" y="${top}" width="${bands[i][1] - bands[i][0]}" height="${h}" fill="rgba(255,255,255,0.07)"/>`; };

  // ------------------------------------------------------------ night detail (hourly chart + GO/TRY/NO table)
  // Hourly verdicts exist only where MET Norway (2.5 km) covers the hour, and then clouds come from
  // MET alone. Further out, hour-level cloud forecasts from the global models carry no real skill.
  // One cloud line everywhere: ≤40% cloud counts as clear (same as the clear-gap definition in every probability).
  const CLEAR_LINE = 40;
  function hourStatus(h) {
    if (!h.dark) return ['twilight', 'day', ''];
    if (h.cloud_met == null) return ['–', 'far', ''];
    if (h.p_act < 0.25) return ['NO', 'no', 'aurora too weak'];
    if (h.p_act >= 0.5 && h.cloud_met <= CLEAR_LINE) return ['GO', 'go', ''];
    if (h.cloud_met <= 70) return ['TRY', 'try', ''];
    return ['NO', 'no', 'too cloudy'];
  }

  const CLOUD_SVG = 'M4.2 13.5h7.6a3 3 0 0 0 .3-6 4.2 4.2 0 0 0-8 1.1 2.5 2.5 0 0 0 .1 4.9z';
  const MOON_SVG = 'M9.5 1.8a6 6 0 1 0 4.7 9.4A5 5 0 0 1 9.5 1.8z';
  // Moon / moon with cloud / cloud: the same small sky icons in the hour table and in the basic hour strip
  const skyGlyph = (c) => (c <= CLEAR_LINE ? `<path d="${MOON_SVG}" fill="#dfe6ff"/>`
    : c <= 70 ? `<path d="${MOON_SVG}" fill="#dfe6ff" transform="translate(3 -1) scale(.75)"/><path d="${CLOUD_SVG}" fill="#b4bac4"/>`
    : `<path d="${CLOUD_SVG}" fill="#8f96a3"/>`);

  // Sky cell: icon + word + % on the first line, a 0–100% bar with the 40% line and the distance to it below.
  function sky(cloud, range) {
    if (cloud == null) return '<span class="sky none">no forecast yet</span>';
    const c = Math.round(cloud);
    const [word, cls] = c <= CLEAR_LINE ? ['Clear', 'clear'] : c <= 70 ? ['Broken', 'broken'] : ['Overcast', 'overcast'];
    const icon = skyGlyph(c);
    const d = c - CLEAR_LINE;
    return `<span class="sky ${cls}">
      <span class="l1"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${icon}</svg>${word} ${c}%${range ? ` <span class="rng">(${range})</span>` : ''}</span>
      <span class="l2"><span class="cbar"><i class="${d <= 0 ? 'ok' : ''}" style="width:${c}%"></i><em></em></span></span></span>`;
  }

  // ︎ forces text (not emoji) presentation on iOS
  const EVENT_GLYPH = { sunset: '☀︎↓', dark_start: '☾︎', dark_end: '☾︎', sunrise: '☀︎↑', depart: '⚓︎', arrive: '⚓︎' };
  const EVENT_SHORT = { sunset: 'sunset', dark_start: 'dark from', dark_end: 'dark until', sunrise: 'sunrise', depart: 'ship departs', arrive: 'ship arrives' };
  const evIcon = (k) => `<span class="evi ${k}" aria-hidden="true">${EVENT_GLYPH[k] || '•'}</span>`;

  function sunStrip(n) {
    const ev = n.events || [];
    if (!ev.length) return '';
    return `<div class="sunstrip">${ev.map((e) => `<div>${evIcon(e.kind)}<b>${e.local}</b>${EVENT_SHORT[e.kind]}</div>`).join('')}</div>`;
  }

  // How often aurora is seen at each hour of a clear night (Kiruna all-sky camera, 1985-1994, IRF), by UT hour.
  // With USE_TIME_CURVE the best window is the clear stretch with the most aurora-hours, not simply the longest
  // or the first one. false = the previous behaviour (longest stretch).
  const USE_TIME_CURVE = true;
  const AURORA_BY_UT = { 15: 33, 16: 46, 17: 50, 18: 60, 19: 72, 20: 78, 21: 85, 22: 83, 23: 81, 0: 77, 1: 72, 2: 71, 3: 58, 4: 48, 5: 45 };
  const auroraShare = (h) => (AURORA_BY_UT[new Date(h.t).getUTCHours()] ?? 30) / 100;

  function bestWindow(n) {
    if (!metCovers(n)) return null;
    const st = n.hourly.map((h) => hourStatus(h)[0]);
    for (const want of ['GO', 'TRY']) {
      const runs = [];
      let i = 0;
      while (i < st.length) {
        if (st[i] !== want) { i++; continue; }
        let j = i;
        while (j + 1 < st.length && st[j + 1] === want) j++;
        runs.push([i, j]);
        i = j + 1;
      }
      if (!runs.length) continue;
      const worth = (r) => (USE_TIME_CURVE ? n.hourly.slice(r[0], r[1] + 1).reduce((s, h) => s + auroraShare(h), 0) : r[1] - r[0]);
      const best = runs.reduce((b, r) => (worth(r) > worth(b) + 1e-9 ? r : b), runs[0]);
      const text = (r) => `${n.hourly[r[0]].local}–${hm(new Date(new Date(n.hourly[r[1]].t).getTime() + 3600e3))}`;
      const peak = n.hourly.slice(best[0], best[1] + 1).reduce((b, h) => (auroraShare(h) > auroraShare(b) ? h : b));
      return { label: want, text: text(best), peak: peak.local, others: runs.filter((r) => r !== best).map(text) };
    }
    return null;
  }

  // The robot decides whether MET Norway covers the night (80% of the dark hours); a single MET hour
  // in the evening twilight does not count.
  const metCovers = (n) => n.clear.source.startsWith('MET Norway');
  const metFull = (n) => n.clear.source === 'MET Norway'; // "MET Norway (partial)": only the first hours, with a clear gap
  const metFromText = (n) => (n.clear.met_from ? `${dayLabel(shipDate(n.clear.met_from).toISOString().slice(0, 10))} ≈${hm(n.clear.met_from)}` : null);

  // Far nights: no hourly verdicts, just the two numbers that actually mean something that far out.
  function farSummary(n) {
    const c = n.clear;
    return `
      <div class="win none">Verdicts (GO / TRY / NO) appear when MET Norway's local model reaches this night, about 2.5 days before it${metFromText(n) ? `: <b>expected from ${metFromText(n)} ship time</b>` : ''}. Hour-by-hour cloud from the global models has no real skill this far out, so it is not shown; the two numbers below are what they can tell.</div>
      <div class="farbox">
        <div class="fb"><div class="k">Typical October night here</div><div class="v">${c.clim_mean_cloud != null ? Math.round(c.clim_mean_cloud) + '% cloud' : '–'}</div><div class="s">average in the dark hours (clear line: 40%) · a 2+ hour gap under 40% in ${pct(c.p_clim)} of nights (2011–2025)</div></div>
        <div class="fb"><div class="k">Global weather models so far</div><div class="v">${c.p_ens != null ? pct(c.p_ens) + ' of runs' : 'not yet'}</div><div class="s">${c.p_ens != null ? `show a 2+ hour gap under 40% (${c.members} runs, ${c.models.join(' + ')}) · low skill this far out` : 'no model reaches this night yet'}</div></div>
      </div>`;
  }

  function hoursTable(n) {
    const hasMet = metCovers(n);
    const rows = n.hourly.filter((h) => h.sun < -3 && h.cloud_met != null);
    const lastT = rows.length ? rows[rows.length - 1].t : '';
    const events = (n.events || []).filter((e) => (e.kind === 'depart' || e.kind === 'arrive') && (metFull(n) || e.t <= lastT));
    const win = hasMet ? bestWindow(n) : null;
    let html = `<div class="hr head"><span>Time</span><span>Verdict</span><span>Sky · MET</span><span class="kp">Kp fc ≥ need</span></div>`;
    const evRow = (e) => `<div class="ev">${evIcon(e.kind)}${esc(e.label)} ${e.local}</div>`;
    rows.forEach((h) => {
      while (events.length && events[0].t <= h.t) html += evRow(events.shift());
      const [lab, cls, why] = hourStatus(h);
      const met = h.cloud_met != null;
      const right = lab === 'NO' ? `<span class="why">${why}</span>`
        : h.kp >= h.kp_req ? `${h.kp.toFixed(1)} ≥ ${h.kp_req.toFixed(1)} <span class="ok">✓</span>`
        : `<span class="why">${h.kp.toFixed(1)} &lt; ${h.kp_req.toFixed(1)}</span>`;
      const cell = met ? sky(h.cloud_met)
        : sky(h.cloud_mean);
      html += `<div class="hr ${cls} ${met ? '' : 'lowskill'}"><span class="tm">${h.local}</span><span class="st ${cls}">${lab}</span>${cell}<span class="kp">${right}</span></div>`;
    });
    html += events.map(evRow).join('');
    if (!metFull(n) && rows.some((h) => h.dark)) html += `<div class="ev">⏳ Later hours: MET Norway reaches them ${metFromText(n) ? `from ${metFromText(n)} ship time` : 'in a later run'}</div>`;
    // Before MET covers the night the global models have no skill hour by hour: no model rows. If MET already
    // reaches the first dark hours, those are shown (the night's chance still comes from the global models).
    if (!hasMet) {
      const firstHours = rows.some((h) => h.dark)
        ? `<div class="ailabel" style="margin-top:12px">First hours from MET Norway</div><div class="hours2">${html}</div>
           <div class="srcline">These hours already come from MET Norway (no 2-hour clear gap in them yet); the chance for the night still uses the global models until MET reaches the rest.</div>`
        : '';
      return `<h3 style="margin-top:16px">Hour by hour</h3>${sunStrip(n)}${farSummary(n)}${firstHours}`;
    }
    const body = `
      ${win ? `<div class="win ${win.label === 'GO' ? 'go' : 'try'}">★ Best window ${win.text} · ${win.label}</div>` : '<div class="win none">No good window tonight.</div>'}
      <div class="hours2">${html}</div>
      <div class="srcline">Cloud source for this night: ${hasMet
        ? (metFull(n) ? '<b>MET Norway (2.5 km local model) only</b>. The global models are not used once MET covers the night.'
          : '<b>MET Norway (2.5 km local model)</b> for the first hours, which already show a clear gap, so the night counts as clear. The later hours follow in a later run.')
        : '<b>global models + October climate</b> (hourly rows: model average, likely range in brackets). MET Norway takes over about 2.5 days before.'}</div>
      <div class="hint">Sky: Clear ≤40% cloud · Broken 40–70% · Overcast &gt;70%. The white mark on each bar is the 40% line.
        <span class="st go">GO</span> dark, activity chance ≥50% and cloud ≤40% ·
        <span class="st try">TRY</span> activity chance ≥25% and cloud ≤70% · <span class="st no">NO</span> otherwise. Exact numbers: "Show all data" below.</div>`;
    return `<h3 style="margin-top:16px">Hour by hour</h3>${sunStrip(n)}${body}`;
  }

  function renderDetail() {
    const n = D.nights.find((x) => x.date === selected);
    if (!n) return;
    if (isPast(n)) { $('#night-detail').innerHTML = pastDetailHTML(n); return; }
    $('#night-detail').innerHTML = detailHTML(n, 'hourly-chart');
    drawHourly(n, $('#hourly-chart'));
  }

  // A finished night: what the evening forecast said next to what happened, hour by hour.
  function pastDetailHTML(n) {
    const s = pastSummary(n);
    const fc = new Map(((s.f && s.f.hours) || []).map((h) => [h[0], h[1]]));
    const rows = s.o ? s.o.hours : [];
    const camCell = (hm) => {
      if (!s.cam) return '';
      const v = s.cam.hrs[hm.slice(0, 2)];
      return `<td>${!v ? '–' : camWord(v).includes('aurora') ? `<span class="ok">${camWord(v)}</span>` : camWord(v)}</td>`;
    };
    return `
      <div style="display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-bottom:10px">
        <h3 style="margin:0">${dayLabel(n.date)} · ${esc(shortPlace(n.place))}</h3><span class="tag-past">PAST</span>
        <span class="pastres ${s.cls}" style="font-size:18px">${esc(s.head)}</span>
      </div>
      <p class="hint" style="margin-top:0">${s.lines.map(esc).join(' · ')}</p>
      ${rows.length ? `<div class="tbl-wrap"><table>
        <tr><th>Time</th><th>Forecast that evening</th><th>Cloud (MET analysis)</th><th>Hp30</th>${s.cam ? `<th>${esc(s.cam.name)} AI</th>` : ''}</tr>
        ${rows.map((r) => `<tr class="${r[1] > -12 ? 'why' : ''}"><td>${r[0]}${r[1] > -12 ? ' <span class="why">twilight</span>' : ''}</td><td>${fc.get(r[0]) || '–'}</td>
          <td>${r[2] <= 40 ? `<span class="ok">${r[2]}%</span>` : r[2] + '%'}</td><td>${r[3] != null ? r[3].toFixed(1) : '–'}</td>${camCell(r[0])}</tr>`).join('')}
      </table></div>
      <p class="hint">Cloud: MET Norway's analysis at the ship's position that hour (green = clear, ≤40%). Hp30 = planetary activity; ≈${s.o.kp_needed} was needed here. Camera AI only when an all-sky camera was within 250 km.</p>`
        : '<div class="empty">The night is over; the hour-by-hour result appears after the next forecast run in the morning.</div>'}`;
  }

  // Full night view; also reused 1:1 by the model check panel.
  function detailHTML(n, chartId) {
    const hours = n.hourly;
    const hasMet = metCovers(n);
    return `
      <div style="display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-bottom:10px">
        <h3 style="margin:0">${dayLabel(n.date)} · ${esc(shortPlace(n.place))}</h3>${chip(n.rating)}
        <span style="font-size:20px;font-weight:700">${pct(n.score)}</span>${confSig(n.confidence, true)}
      </div>
      <div class="grid2">
        <div>${factorRows(n)}<ul class="notes" style="margin-top:10px">${n.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div>
          <div class="legend">
            <span><i style="background:#3987e5"></i>Cloud cover, MET Norway (left axis)${metFull(n) ? '' : hasMet ? ', first hours only so far' : ', not available yet for this night'} · below the white 40% line = clear enough</span>
            <span><i class="line" style="background:#e8743b"></i>Kp forecast (right axis)</span>
            <span><i class="line" style="background:repeating-linear-gradient(90deg,#e8743b 0 6px,transparent 6px 10px)"></i>Kp needed here · solid above dashed = strong enough</span>
            <span><i class="band"></i>Dark hours</span>
          </div>
          <div class="chart" id="${chartId}"></div>
          ${hasMet ? '' : '<div class="hint">Cloud bars appear when MET Norway\'s local model reaches this night (see Hour by hour below). The Kp lines are already meaningful.</div>'}
          <div class="hint">Times are ship time (UTC+2). <b>Kp forecast</b> = expected geomagnetic activity (0–9). <b>Kp needed</b> = the level at which aurora is clearly visible where the ship is at that hour (higher the further south). <b>Activity chance</b> = probability that the real Kp reaches the needed level, allowing for forecast error. At midnight: ${kpNeedText(n.kp_req)}.</div>
        </div>
      </div>
      ${hoursTable(n)}
      ${formula(n)}
      <details class="table"><summary>Show all data (table)</summary><div class="tbl-wrap"><table>
        <tr><th>Time</th><th>Where</th><th>Sun</th><th>Clear chance (models)</th><th>Cloud models</th><th>Cloud MET</th><th>Kp forecast</th><th>Kp needed</th><th>Activity</th><th>Moon</th></tr>
        ${hours.map((h) => `<tr><td>${h.local}</td><td>${esc(shortPlace(h.place)).slice(0, 26)}</td><td>${h.sun}°</td><td>${pct(h.p_clear_h)}</td><td>${h.cloud_mean ?? '–'}${h.cloud_mean != null ? '%' : ''}</td><td>${h.cloud_met ?? '–'}${h.cloud_met != null ? '%' : ''}</td><td>${h.kp.toFixed(1)}</td><td>${h.kp_req.toFixed(1)}</td><td>${pct(h.p_act)}</td><td>${h.moon_alt > 0 ? Math.round(h.moon_illum * 100) + '%' : 'down'}</td></tr>`).join('')}
      </table></div></details>`;
  }

  function drawHourly(n, cont) {
    if (!cont || !n) return;
    const hours = n.hourly;
    // Left axis: cloud cover % (blue). Right axis: Kp (orange), as the user asked for one combined chart.
    const W = widthOf(cont), H = 262, ml = 40, mr = 30, mt = 22, mb = 46;
    const pw = W - ml - mr, ph = H - mt - mb;
    const bw = pw / hours.length;
    const y = (v) => mt + ph - (v / 100) * ph;
    const kMax = Math.max(6, Math.ceil(Math.max(...hours.map((h) => Math.max(h.kp, h.kp_req))) + 1));
    const yk = (k) => mt + ph - (Math.min(k, kMax) / kMax) * ph;
    const CLOUD_C = '#6da7ec', KP_C = '#e8743b';
    let g = '';
    hours.forEach((h, i) => { g += `<rect x="${ml + i * bw}" y="${mt}" width="${bw + 0.5}" height="${ph}" fill="${h.dark ? '#0e0f11' : '#23252b'}"/>`; });
    for (const v of [0, 25, 50, 75, 100]) {
      g += `<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? '#383835' : '#2c2c2a'}"/>`;
      g += `<text x="${ml - 6}" y="${y(v) + 4}" text-anchor="end" style="fill:${CLOUD_C}">${v}%</text>`;
    }
    for (let k = 0; k <= kMax; k += kMax > 6 ? 2 : 1) g += `<text x="${W - mr + 6}" y="${yk(k) + 4}" style="fill:${KP_C}">${k}</text>`;
    g += `<text x="${ml - 6}" y="${mt - 8}" text-anchor="end" style="fill:${CLOUD_C}">Cloud</text>`;
    g += `<text x="${W - mr + 6}" y="${mt - 8}" style="fill:${KP_C}">Kp</text>`;
    g += '<g class="hl"></g>';
    // Cloud bars: MET Norway where available (solid), otherwise the global-model average (faded) — same as the table.
    // Before MET covers the night, no model bars at all: hour by hour they have no skill that far out.
    hours.forEach((h, i) => {
      const met = h.cloud_met != null;
      const v = met ? h.cloud_met : null; // no model bars: hours already past, or not reached by MET yet
      if (v == null) return;
      const cx = ml + i * bw + bw / 2, w = Math.max(5, bw * 0.46);
      g += `<path d="${roundTopBar(cx - w / 2, y(v), w, y(0) - y(v))}" fill="#3987e5" opacity="${met ? 1 : 0.35}"/>`;
    });
    // Hours MET has not reached yet: say on the chart when their clouds arrive
    const todo = hours.map((h, i) => [h, i]).filter(([h]) => h.dark && h.cloud_met == null && new Date(h.t).getTime() + 3600e3 > Date.now());
    if (todo.length && !metFull(n)) {
      const a = ml + todo[0][1] * bw, b = ml + (todo[todo.length - 1][1] + 1) * bw;
      const when = metFromText(n) ? `from ${metFromText(n)}` : 'about 2.5 days before';
      const none = hours.every((h) => h.cloud_met == null);
      g += `<text x="${(a + b) / 2}" y="${y(88)}" text-anchor="middle" style="fill:#9fb4cc;font-size:12px">${none ? 'Hourly clouds' : 'Clouds for these hours'} ${when}</text>`;
      g += `<text x="${(a + b) / 2}" y="${y(88) + 16}" text-anchor="middle" style="fill:#9fb4cc;font-size:11px;opacity:.8">(MET Norway, ship time)</text>`;
    }
    g += `<line x1="${ml}" x2="${W - mr}" y1="${y(CLEAR_LINE)}" y2="${y(CLEAR_LINE)}" stroke="#fff" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    g += `<text class="ref" x="${ml + 4}" y="${y(CLEAR_LINE) - 5}">clear line 40%</text>`;
    // Kp needed here (dashed) and Kp forecast (solid), both on the right axis
    const cxs = hours.map((_, i) => ml + i * bw + bw / 2);
    g += `<polyline points="${hours.map((h, i) => `${cxs[i]},${yk(h.kp_req)}`).join(' ')}" fill="none" stroke="${KP_C}" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.9"/>`;
    g += `<polyline points="${hours.map((h, i) => `${cxs[i]},${yk(h.kp)}`).join(' ')}" fill="none" stroke="${KP_C}" stroke-width="2.5" stroke-linejoin="round"/>`;
    hours.forEach((h, i) => { if (h.dark) g += `<circle cx="${cxs[i]}" cy="${yk(h.kp)}" r="4" fill="${KP_C}" stroke="#16171a" stroke-width="2"/>`; });
    const every = bw < 34 ? 3 : 2;
    hours.forEach((h, i) => {
      const cx = ml + i * bw + bw / 2;
      if (i % every === 0) g += `<text x="${cx}" y="${H - mb + 16}" text-anchor="middle">${h.local}</text>`;
      if (h.moon_alt > 0) g += `<text x="${cx}" y="${H - mb + 34}" text-anchor="middle" style="fill:#c3c2b7;opacity:${0.35 + 0.65 * h.moon_illum}">☾</text>`;
    });
    g += `<text x="${ml - 6}" y="${H - mb + 34}" text-anchor="end">moon</text>`;
    cont.innerHTML = svgTag(W, H, 'Hourly outlook', g);
    const bands = hours.map((_, i) => [ml + i * bw, ml + (i + 1) * bw]);
    const hl = cont.querySelector('.hl');
    bindHover(cont, W, bands, (i) => {
      const h = hours[i];
      return `<b>${h.local}</b> · ${esc(shortPlace(h.place))}
        <div class="row"><span>Sun</span><span>${h.sun}° ${h.dark ? '(dark)' : '(twilight/day)'}</span></div>
        ${h.cloud_met != null ? `<div class="row"><span>Cloud (MET Norway)</span><span>${h.cloud_met}%</span></div>` : ''}
        <div class="row"><span>Verdict</span><span>${hourStatus(h)[0]} ${hourStatus(h)[2]}</span></div>
        <div class="row"><span>Kp forecast</span><span>${h.kp.toFixed(1)}</span></div>
        <div class="row"><span>Kp needed here</span><span>${h.kp_req.toFixed(1)}</span></div>
        <div class="row"><span>Activity chance</span><span>${pct(h.p_act)}</span></div>
        <div class="row"><span>Moon</span><span>${h.moon_alt > 0 ? Math.round(h.moon_illum * 100) + '% lit, up' : 'below horizon'}</span></div>
        <div class="hint" style="margin-top:4px">${h.kp >= h.kp_req ? 'Forecast activity is above what this spot needs.' : `Forecast is ${(h.kp_req - h.kp).toFixed(1)} short of what this spot needs; the chance comes from forecast uncertainty.`} Kp source: ${esc(h.kp_src)}</div>`;
    }, (i) => hlBand(hl, bands, i, mt, ph));
  }

  // ------------------------------------------------------------ trend chart
  function renderTrend() {
    const runs = (HIST && HIST.runs) || [];
    const el = $('#trend-panel');
    if (!runs.length) { el.innerHTML = '<div class="empty">No history yet.</div>'; return; }
    el.innerHTML = `
      <div class="legend">${KEY_NIGHTS.map((k, i) => `<span><i class="line" style="background:${SERIES[i]}"></i>${dayLabel(k)}</span>`).join('')}</div>
      <div class="chart" id="trend-chart"></div>
      <div class="hint">Each point is one forecast run (every 3 hours). The six Arctic nights are shown. ${runs.length < 3 ? '<b>The trend builds up from now on, so come back in a few days.</b>' : 'A steady rise or fall over several days is more meaningful than a single jump.'}</div>`;
    drawTrend(runs);
  }

  function drawTrend(runs) {
    const cont = $('#trend-chart');
    const W = widthOf(cont), H = 250, ml = 40, mr = 52, mt = 12, mb = 28;
    const pw = W - ml - mr, ph = H - mt - mb;
    const ts = runs.map((r) => new Date(r.t).getTime());
    let t0 = ts[0], t1 = ts[ts.length - 1];
    if (t1 - t0 < 864e5) { t0 -= 864e5 / 2; t1 += 864e5 / 2; }
    const maxV = Math.max(0.3, ...runs.flatMap((r) => KEY_NIGHTS.map((k) => (r.nights[k] ? r.nights[k][0] : 0))));
    const yMax = Math.ceil(maxV * 10 + 0.5) / 10;
    const x = (t) => ml + ((t - t0) / (t1 - t0)) * pw;
    const y = (v) => mt + ph - (v / yMax) * ph;
    const ticks = [];
    for (let v = 0; v <= yMax + 1e-9; v += 0.1) ticks.push(Math.round(v * 10) / 10);
    let g = gridY(y, ml, ml + pw, ticks, (v) => Math.round(v * 100) + '%');
    for (const [thr, lab] of [[0.4, 'GOOD'], [0.25, 'FAIR']]) {
      if (thr <= yMax) g += `<line x1="${ml}" x2="${ml + pw}" y1="${y(thr)}" y2="${y(thr)}" stroke="#555" stroke-dasharray="4 4"/><text class="ref" x="${ml + 4}" y="${y(thr) - 4}">${lab} ≥${thr * 100}%</text>`;
    }
    const nDays = Math.max(1, Math.round((t1 - t0) / 864e5));
    const step = Math.max(1, Math.ceil(nDays / Math.max(2, Math.floor(pw / 70))));
    const d0 = new Date(t0); d0.setUTCHours(0, 0, 0, 0);
    for (let t = d0.getTime() + 864e5; t <= t1; t += 864e5 * step) {
      g += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${new Date(t).getUTCDate()} ${MON[new Date(t).getUTCMonth()]}</text>`;
    }
    g += '<g class="hl"></g>';
    const ends = [];
    KEY_NIGHTS.forEach((k, si) => {
      const p = runs.map((r, i) => (r.nights[k] ? [x(ts[i]), y(r.nights[k][0])] : null)).filter(Boolean);
      if (!p.length) return;
      if (p.length > 1) g += `<polyline points="${p.map((q) => q.join(',')).join(' ')}" fill="none" stroke="${SERIES[si]}" stroke-width="2" stroke-linejoin="round"/>`;
      const last = p[p.length - 1];
      g += `<circle cx="${last[0]}" cy="${last[1]}" r="4.5" fill="${SERIES[si]}" stroke="#16171a" stroke-width="2"/>`;
      ends.push({ y: last[1], k });
    });
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    ends.forEach((e) => { g += `<text class="lbl" x="${ml + pw + 8}" y="${e.y + 4}">${shortDay(e.k)}</text>`; });
    cont.innerHTML = svgTag(W, H, 'Chance per Arctic night over successive forecast runs', g);
    const hl = cont.querySelector('.hl');
    const xs = ts.map(x);
    const bands = xs.map((cx, i) => [i === 0 ? ml : (xs[i - 1] + cx) / 2, i === xs.length - 1 ? ml + pw : (cx + xs[i + 1]) / 2]);
    bindHover(cont, W, bands, (i) => {
      const r = runs[i];
      return `<b>Run ${new Date(r.t).toUTCString().slice(5, 22)} UTC</b>` + KEY_NIGHTS.map((k, si) => r.nights[k]
        ? `<div class="row"><span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${SERIES[si]};margin-right:5px"></i>${shortDay(k)}</span><span>${pct(r.nights[k][0])}</span></div>` : '').join('');
    }, (i) => { hl.innerHTML = i < 0 ? '' : `<line x1="${xs[i]}" x2="${xs[i]}" y1="${mt}" y2="${mt + ph}" stroke="#898781"/>`; });
  }

  // ------------------------------------------------------------ Kp charts
  function kpRefLines(y, x0, x1) {
    let g = '';
    for (const [v, lab] of [[1, 'Tromsø/Alta need ≈1'], [3, 'Trondheim/Ålesund ≈3'], [5, 'G1 storm']]) {
      g += `<line x1="${x0}" x2="${x1}" y1="${y(v)}" y2="${y(v)}" stroke="#777" stroke-dasharray="3 4"/>`;
      g += `<text class="ref" x="${x1 - 2}" y="${y(v) - 4}" text-anchor="end">${lab}</text>`;
    }
    return g;
  }

  function renderKp27() {
    const sw = D.space_weather;
    const el = $('#kp27-panel');
    if (!sw.kp_27day.days.length) { el.innerHTML = '<div class="empty">27-day outlook unavailable.</div>'; return; }
    el.innerHTML = `
      <h3>27-day Kp outlook</h3>
      <div class="legend"><span><i style="background:#3987e5"></i>NOAA outlook (daily max Kp)</span><span><i class="dotm" style="background:#d95926"></i>Observed</span><span><i class="dotm" style="border:2px solid #199e70;background:none"></i>What happened 27 days earlier</span></div>
      <div class="chart" id="kp27-chart"></div>
      <div class="hint">Issued ${esc(sw.kp_27day.issued || '–')} (new issue every Monday). The purple band marks the Arctic nights (13–18 Oct).</div>`;
    drawKp27();
  }

  function drawKp27() {
    const sw = D.space_weather;
    const days = sw.kp_27day.days;
    const cont = $('#kp27-chart');
    const obs = Object.fromEntries(sw.observed_daily.map((o) => [o.date, o.kp_max]));
    const first = new Date(days[0].date + 'T00:00:00Z');
    const last = new Date(Math.max(new Date(days[days.length - 1].date + 'T00:00:00Z'), new Date('2026-10-24T00:00:00Z')));
    const all = [];
    for (let t = first.getTime(); t <= last.getTime(); t += 864e5) all.push(new Date(t).toISOString().slice(0, 10));
    const out = Object.fromEntries(days.map((d) => [d.date, d.kp]));
    const rec = (d) => obs[new Date(new Date(d + 'T00:00:00Z').getTime() - 27 * 864e5).toISOString().slice(0, 10)];
    const today = new Date().toISOString().slice(0, 10);
    const W = widthOf(cont), H = 240, ml = 28, mr = 6, mt = 16, mb = 28;
    const pw = W - ml - mr, ph = H - mt - mb, bw = pw / all.length;
    const yMax = 7;
    const y = (v) => mt + ph - (Math.min(v, yMax) / yMax) * ph;
    const band = (a, b, fill, lab) => {
      const i0 = all.indexOf(a), i1 = all.indexOf(b);
      if (i0 < 0 || i1 < 0) return '';
      return `<rect x="${ml + i0 * bw}" y="${mt}" width="${(i1 - i0 + 1) * bw}" height="${ph}" fill="${fill}"/>` +
        (lab ? `<text x="${ml + i0 * bw + 4}" y="${mt - 4}" class="lbl">${lab}</text>` : '');
    };
    let g = band('2026-10-10', '2026-10-23', '#1d1f24', 'Cruise') + band('2026-10-13', '2026-10-18', '#2a2342', '');
    g += gridY(y, ml, ml + pw, [0, 1, 2, 3, 4, 5, 6, 7], (v) => v);
    g += '<g class="hl"></g>';
    all.forEach((d, i) => {
      const cx = ml + i * bw + bw / 2, w = Math.max(3, bw * 0.55);
      if (out[d] != null) g += `<path d="${roundTopBar(cx - w / 2, y(out[d]), w, y(0) - y(out[d]), 3)}" fill="#3987e5"/>`;
      if (obs[d] != null && d <= today) g += `<circle cx="${cx}" cy="${y(obs[d])}" r="4" fill="#d95926" stroke="#16171a" stroke-width="2"/>`;
      const r = rec(d);
      if (r != null && d > today) g += `<circle cx="${cx}" cy="${y(r)}" r="3.5" fill="none" stroke="#199e70" stroke-width="2"/>`;
      const dd = new Date(d + 'T00:00:00Z');
      if (dd.getUTCDay() === 1) g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${dd.getUTCDate()} ${MON[dd.getUTCMonth()]}</text>`;
    });
    g += kpRefLines(y, ml, ml + pw);
    cont.innerHTML = svgTag(W, H, '27-day Kp outlook', g);
    const hl = cont.querySelector('.hl');
    const bands = all.map((_, i) => [ml + i * bw, ml + (i + 1) * bw]);
    bindHover(cont, W, bands, (i) => {
      const d = all[i];
      return `<b>${dayLabel(d)}</b>
        <div class="row"><span>NOAA outlook</span><span>${out[d] ?? '–'}</span></div>
        <div class="row"><span>${d === today ? 'Observed so far today' : 'Observed'}</span><span>${obs[d] != null && d <= today ? obs[d].toFixed(1) : '–'}</span></div>
        <div class="row"><span>27 days earlier</span><span>${rec(d) != null ? rec(d).toFixed(1) : '–'}</span></div>`;
    }, (i) => hlBand(hl, bands, i, mt, ph));
  }

  function renderKp3() {
    const sw = D.space_weather;
    const el = $('#kp3-panel');
    if (!(sw.kp_3day || []).length) { el.innerHTML = '<div class="empty">3-day forecast unavailable.</div>'; return; }
    el.innerHTML = `
      <h3>Kp: last week &amp; NOAA 3-day forecast</h3>
      <div class="legend"><span><i style="background:#3987e5"></i>Observed / estimated</span><span><i style="background:rgba(57,135,229,.3);border:1.5px solid #3987e5"></i>Forecast</span><span><i style="background:#f2c230;border-radius:50%"></i>Measured Hp30 (half-hourly)</span></div>
      <div class="chart" id="kp3-chart"></div>
      <div class="hint">${esc(sw.three_day.summary || '')} ${sw.three_day.rationale ? '<br>NOAA: ' + esc(sw.three_day.rationale) : ''}</div>`;
    drawKp3();
  }

  function drawKp3() {
    const rows = D.space_weather.kp_3day;
    const cont = $('#kp3-chart');
    const W = widthOf(cont), H = 240, ml = 28, mr = 6, mt = 16, mb = 28;
    const pw = W - ml - mr, ph = H - mt - mb, bw = pw / rows.length;
    const yMax = 7;
    const y = (v) => mt + ph - (Math.min(v, yMax) / yMax) * ph;
    let g = gridY(y, ml, ml + pw, [0, 1, 2, 3, 4, 5, 6, 7], (v) => v);
    g += '<g class="hl"></g>';
    rows.forEach((r, i) => {
      const cx = ml + i * bw + bw / 2, w = Math.max(2, bw * 0.62);
      const path = roundTopBar(cx - w / 2, y(r.kp), w, y(0) - y(r.kp), 2);
      g += r.kind === 'predicted' ? `<path d="${path}" fill="rgba(57,135,229,0.30)" stroke="#3987e5" stroke-width="1.2"/>` : `<path d="${path}" fill="#3987e5"/>`;
      const t = new Date(r.t);
      if (t.getUTCHours() === 0) {
        g += `<line x1="${ml + i * bw}" x2="${ml + i * bw}" y1="${mt}" y2="${mt + ph}" stroke="#2c2c2a"/>`;
        if (t.getUTCDate() % (bw * 8 < 40 ? 2 : 1) === 0) g += `<text x="${ml + i * bw + 2}" y="${H - 8}">${t.getUTCDate()} ${MON[t.getUTCMonth()]}</text>`;
      }
    });
    g += kpRefLines(y, ml, ml + pw);
    // Measured half-hourly Hp30 as dots: short substorm peaks that the 3-hour Kp smooths out.
    const T0 = new Date(rows[0].t).getTime();
    const hpMap = new Map([...(D.space_weather.hp30_week || []), ...(HP30 || [])]);
    const hp = [...hpMap.entries()].map(([ts, v]) => [new Date(ts).getTime(), v]).sort((a, b) => a[0] - b[0]);
    for (const [t, v] of hp) {
      const cx = ml + ((t + 900e3 - T0) / 10800e3) * bw;
      if (cx >= ml && cx <= ml + pw) g += `<circle cx="${cx.toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.2" fill="#f2c230"/>`;
    }
    cont.innerHTML = svgTag(W, H, '3-hourly Kp', g);
    const hl = cont.querySelector('.hl');
    const bands = rows.map((_, i) => [ml + i * bw, ml + (i + 1) * bw]);
    bindHover(cont, W, bands, (i) => {
      const r = rows[i];
      const a = new Date(r.t).getTime();
      const inBlock = hp.filter(([t]) => t >= a && t < a + 10800e3).map((p) => p[1]);
      return `<b>${dayLabel(r.t.slice(0, 10))} ${r.t.slice(11, 16)}–${pad((+r.t.slice(11, 13) + 3) % 24)}:00 UTC</b><div class="row"><span>Kp (${esc(r.kind)})</span><span>${r.kp.toFixed(2)}</span></div>`
        + (inBlock.length ? `<div class="row"><span>Hp30 measured, max</span><span>${Math.max(...inBlock).toFixed(1)}</span></div>` : '');
    }, (i) => hlBand(hl, bands, i, mt, ph));
  }

  function renderSwpcText() {
    const sw = D.space_weather;
    const w = sw.weekly || {};
    const cmes = sw.cmes || [];
    $('#swpc-text').innerHTML = `
      <h3>What the forecasters say</h3>
      <p class="hint" style="margin-top:0">The written forecast of NOAA's space weather forecasters (the people, not a model): the week ahead, the next 3 days, and solar eruptions heading to Earth.</p>
      <p><b>NOAA weekly forecast</b> (${esc(w.period || '')}, issued ${esc(w.issued || '–')}):<br>${esc(w.geomagnetic || 'not available')}</p>
      <p class="hint">Jargon: "CH HSS" = fast solar wind from a coronal hole, the typical source of moderate aurora activity at this stage of the solar cycle. "Unsettled/active" ≈ Kp 3–4, "G1" = Kp 5.</p>
      <p><b>Solar eruptions (CMEs) heading to Earth:</b> ${cmes.length ? '' : 'none in NASA\'s model runs from the last 7 days.'}</p>
      ${cmes.length ? `<ul>${cmes.map((c) => `<li>Arrival ≈ ${esc(dayLabel(c.arrival.slice(0, 10)))} ${hm(c.arrival)} ship time${c.glancing ? ' (glancing blow)' : ''} · expected Kp ${c.kp_min ?? '?'}–${c.kp_max ?? '?'} ${c.link ? `· <a href="${esc(c.link)}" target="_blank" rel="noopener">details</a>` : ''}</li>`).join('')}</ul>` : ''}`;
  }

  // ------------------------------------------------------------ live
  const setTile = (id, v, sub) => { const e = document.getElementById(id); if (e) { e.querySelector('.v').innerHTML = v; e.querySelector('.s').innerHTML = sub; } };

  // Kp level needed for aurora overhead at the ship (same rule as the pipeline).
  function kpNeedAt(lat, lon) {
    const R = Math.PI / 180;
    const mlat = Math.asin(Math.sin(lat * R) * Math.sin(80.8 * R) + Math.cos(lat * R) * Math.cos(80.8 * R) * Math.cos((lon + 72.6) * R)) / R;
    return Math.max(0, Math.min(9, (67.5 - mlat) / 1.8 + 0.5));
  }
  const liveNeed = () => { const s = shipNow(); return kpNeedAt(s.lat, s.lon); };

  // The newer of two Hp30 series (latest.json every 3 h, data/hp30.json every 10 min on board).
  const newerHp30 = (a, b) => ((b && b.length && (!a || !a.length || b[b.length - 1][0] > a[a.length - 1][0])) ? b : (a || []));

  function updateHp30Tile() {
    if (!HP30 || !HP30.length) return setTile('lt-hp', '–', 'not available');
    const need = liveNeed();
    const [ts, v] = HP30[HP30.length - 1];
    const max24 = Math.max(...HP30.map((p) => p[1]));
    const ageMin = Math.round((Date.now() - new Date(ts)) / 60000) - 30; // value covers ts..ts+30min
    setTile('lt-hp', v.toFixed(1),
      `needed here ≈${need.toFixed(0)} ${v >= need ? '✓' : '✕'} · ${hm(new Date(new Date(ts).getTime() + 1800e3))} ship time${ageMin > 90 ? ' (old)' : ''} · 24 h max ${max24.toFixed(1)}`);
  }

  // Nearest FMI magnetometer to the ship (Tromsø area before the cruise). None near the southern ports.
  function updateMagTile() {
    const st = MAG && MAG.stations;
    if (!st || !Object.keys(st).length) return setTile('lt-mag', '–', 'no reading yet (logged after dark only)');
    const s = shipNow();
    const [lat, lon] = s.sailing ? [s.lat, s.lon] : [69.65, 18.96];
    const R = Math.PI / 180;
    const km = (x) => 6371 * Math.acos(Math.min(1, Math.sin(lat * R) * Math.sin(x.lat * R) + Math.cos(lat * R) * Math.cos(x.lat * R) * Math.cos((lon - x.lon) * R)));
    const best = Object.values(st).reduce((b, x) => (!b || km(x) < km(b) ? x : b), null);
    if (km(best) > 300) return setTile('lt-mag', '–', 'no station near the ship here: use Kp, Hp30 and the map');
    const level = best.swing_60 >= 200 ? '<span class="ok">strong: go outside if clear</span>' : best.swing_60 >= 50 ? 'active: aurora likely nearby' : 'quiet';
    const drop = best.change_10 <= -50 ? ` · ⬇ dropped ${-best.change_10} nT in 10 min` : '';
    const old = Date.now() - new Date(best.t) > 40 * 60e3;
    setTile('lt-mag', `${best.swing_60}<small> nT</small>`,
      `${level}${drop} · swing in the last hour at ${esc(best.name)} (${Math.round(km(best) / 10) * 10} km) · ${hm(best.t)} ship time${old ? ' (old: logged after dark only)' : ''}`);
  }

  function refreshNoaaTiles() {
    const need = liveNeed();
    getJSON(`${SWPC}/json/planetary_k_index_1m.json`).then((a) => {
      const k = a[a.length - 1].estimated_kp;
      setTile('lt-kp', k.toFixed(1), `needed here ≈${need.toFixed(0)} ${k >= need ? '✓ enough' : '✕ not enough'}`);
      LIVE.kp = k;
      basicRefresh();
    }).catch(() => setTile('lt-kp', '–', 'offline'));
    getJSON(`${SWPC}/products/summary/solar-wind-mag-field.json`).then((a) => {
      const bz = a[0].bz_gsm;
      setTile('lt-bz', `${bz > 0 ? '+' : ''}${bz}<small> nT</small>`, bz <= -5 ? '✓ strongly south: door open' : bz < 0 ? 'slightly south' : '✕ north: door mostly closed');
    }).catch(() => setTile('lt-bz', '–', 'offline'));
    getJSON(`${SWPC}/products/summary/solar-wind-speed.json`).then((a) => {
      const v = a[0].proton_speed;
      setTile('lt-sw', `${v}<small> km/s</small>`, v >= 500 ? '✓ fast' : v >= 400 ? 'moderate' : 'slow');
    }).catch(() => setTile('lt-sw', '–', 'offline'));
    const st = $('#live-stamp');
    if (st) st.textContent = `Updated ${hm(Date.now())} ship time · refreshes by itself while this page is open (numbers every 2 min, pictures and map every 10 min)`;
  }

  // Files the robot writes: Hp30 and the magnetometer swing.
  async function refreshRobotFiles() {
    const [hp, mag] = await Promise.all([getJSON('data/hp30.json').catch(() => null), getJSON('data/mag.json').catch(() => null)]);
    HP30 = newerHp30(HP30, hp && hp.series);
    if (mag) MAG = mag;
    updateHp30Tile();
    updateMagTile();
    safe(drawMagChart);
    basicRefresh();
  }

  function refreshOvation() {
    const s = shipNow();
    getOvation().then((o) => {
      const [lat, lon, label] = s.sailing ? [s.lat, s.lon, 'at the ship'] : [69.65, 18.96, 'Tromsø (not sailing yet)'];
      const { local, north } = ovationAt(o, lat, lon);
      setTile('lt-ov', `${local}<small> %</small>`, `${label} · ${north}% in view to the north`);
      LIVE.ov = local;
      basicRefresh();
    }).catch(() => setTile('lt-ov', '–', 'offline'));
    drawOvationMap();
    renderRouteOvation();
  }

  // Bigger downloads: OVATION model and map, Bz chart, camera pictures and AI, magnetogram.
  function refreshHeavy() {
    OVATION = null;
    refreshOvation();
    loadBz();
    loadSat();
    document.querySelectorAll('img[data-live]').forEach((img) => { img.src = `${img.dataset.live}?t=${Date.now()}`; });
    loadAiChips();
  }

  // Live values refresh themselves while the page is visible; a hidden tab or a locked phone downloads nothing.
  const LIVE_JOBS = [[2, refreshNoaaTiles], [5, refreshRobotFiles], [10, refreshHeavy]];
  const liveLast = new Map();
  function liveTick() {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    for (const [min, fn] of LIVE_JOBS) {
      if (now - (liveLast.get(fn) || 0) >= min * 60e3 - 5e3) { liveLast.set(fn, now); safe(fn); }
    }
  }
  function startLiveRefresh() {
    const now = Date.now();
    for (const [, fn] of LIVE_JOBS) liveLast.set(fn, now); // everything was just loaded by the first render
    setInterval(liveTick, 30e3);
    document.addEventListener('visibilitychange', liveTick);
  }

  function renderLive() {
    const s = shipNow();
    const t = (k, v, sub, id) => `<div class="tile" ${id ? `id="${id}"` : ''}><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
    $('#live-tiles').innerHTML =
      `<div class="tile ship"><div class="k">Ship</div><div class="v">${esc(shortPlace(s.place))}</div><div class="s">${s.sailing ? `${s.lat.toFixed(1)}°N ${s.lon.toFixed(1)}°E (from itinerary)` : 'Not sailing yet: shows the planned start'}</div></div>` +
      t('Kp now', '…', '', 'lt-kp') + t('Activity now (Hp30)', '…', '', 'lt-hp') + t('Magnetometer', '…', '', 'lt-mag') +
      t('Bz', '…', '', 'lt-bz') + t('Solar wind', '…', '', 'lt-sw') + t('Aurora overhead', '…', 'NOAA OVATION', 'lt-ov');
    refreshNoaaTiles();
    updateHp30Tile();
    updateMagTile();

    // Everything loads automatically (the ship has fast Starlink-based Wi-Fi); ~2.5 MB per page view.
    $('#bz-panel').innerHTML = `<h3>Solar wind Bz, last 24 h</h3>
      <p class="hint">Negative (south) Bz lets solar-wind energy in; 20+ minutes below −5 nT often triggers aurora within the hour.</p>
      <button class="btn" id="bz-btn">Loading…</button><div class="chart" id="bz-chart"></div>`;
    $('#bz-btn').addEventListener('click', loadBz);
    loadBz();

    $('#ovation-panel').innerHTML = `<h3>Aurora right now over Norway</h3>
      <p class="hint" style="margin-top:0">NOAA OVATION model: where aurora is likely overhead in the next 30–90 minutes. It is often also visible a few hundred km south of the coloured band, low in the northern sky.</p>
      <div id="ovmap"></div>
      <div class="legend" style="margin-top:8px"><span><i style="background:#1faa59"></i>possible (≥5%)</span><span><i style="background:#9fd13b"></i>likely (≥20%)</span><span><i style="background:#f2c230"></i>very likely (≥40%)</span><span><i style="background:#e5533d"></i>strong (≥60%)</span></div>
      <div class="hint" id="ovmap-meta"></div>`;
    refreshOvation();
  }

  // OVATION probability overhead (±1°) and the strongest value within view to the north (up to 8° north, ±10° lon).
  function ovationAt(o, lat, lon) {
    const lon360 = ((lon % 360) + 360) % 360;
    let local = 0, north = 0;
    for (const [glon, glat, p] of o.coordinates) {
      const dl = Math.min(Math.abs(glon - lon360), 360 - Math.abs(glon - lon360));
      if (dl <= 1 && Math.abs(glat - lat) <= 1) local = Math.max(local, p);
      if (dl <= 10 && glat >= lat && glat <= lat + 8) north = Math.max(north, p);
    }
    return { local, north };
  }

  // ------------------------------------------------------------ clouds from space (Meteosat) + where they move
  // MET Norway serves EUMETSAT's Meteosat infrared picture of Europe every 15 minutes (day and night).
  // We show the Scandinavian corner of the last hour as a short loop, and the wind at ~3 km height
  // (700 hPa, the level clouds drift with) at the ship, as an arrow: which way the clouds are moving.
  const SAT = 'https://api.met.no/weatherapi/geosatellite/1.4/';
  // Crops of the 1280x720 Europe picture (same 1.6 aspect): northern Norway (Lofoten to Kola) and all of Scandinavia
  const SAT_CROPS = { north: { x: 760, y: 15, w: 200, h: 125, label: 'Northern Norway' }, scand: { x: 600, y: 0, w: 480, h: 300, label: 'Scandinavia' } };
  const SAT_W = 1280, SAT_H = 720;
  let satView = null; // null = follow the ship: northern Norway from Trondheim northwards (and before the cruise), else Scandinavia
  const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  let satTimer = null;

  function renderSat() {
    const el = $('#sat');
    if (!el) return;
    const s = shipNow();
    const view = satView || (!s.sailing || s.lat >= 63 ? 'north' : 'scand');
    const c = SAT_CROPS[view];
    el.innerHTML = `<h3>Clouds from space <span class="why">· last hour</span></h3>
      <p class="hint" style="margin-top:0">Satellite picture (Meteosat, infrared, works at night): <b>white = cloud</b> (the brighter, the higher and colder), <b>blue = clear sea</b>, <b>green = clear land</b>. The frames of the last hour play in a loop, so you can see which way the clouds drift and whether a clear gap is coming.</p>
      <div class="daytabs">${Object.entries(SAT_CROPS).map(([k, v]) => `<button class="btn ${k === view ? 'on' : ''}" data-v="${k}">${v.label}</button>`).join('')}</div>
      <div class="satbox" style="padding-top:${(c.h / c.w) * 100}%"><img id="sat-img" alt="Meteosat infrared picture, ${c.label}" style="width:${(SAT_W / c.w) * 100}%;left:-${(c.x / c.w) * 100}%;top:-${(c.y / c.h) * 100}%"></div>
      <div class="hint" id="sat-time"></div>
      <div id="sat-wind" class="satwind"></div>
      <p class="hint">Norway is squeezed at the top: the satellite sits above the equator and sees the north at a low angle. Thin low cloud or fog can look like clear ground. Sharper pictures when a polar satellite passes (not always over the ship): <a href="https://api.met.no/weatherapi/polarsatellite/1.1/?area=nr&channel=ch4&satellite=noaa&size=l" target="_blank" rel="noopener">northern Norway</a> · <a href="https://api.met.no/weatherapi/polarsatellite/1.1/?area=nm&channel=ch4&satellite=noaa&size=l" target="_blank" rel="noopener">mid Norway</a>. Source: EUMETSAT / MET Norway; wind: Open-Meteo.</p>`;
    el.querySelectorAll('.daytabs button').forEach((b) => b.addEventListener('click', () => { satView = b.dataset.v; renderSat(); }));
    loadSat();
  }

  async function loadSat() {
    const img = document.getElementById('sat-img');
    if (!img) return;
    try {
      // plain fetch: MET's API rejects the cache-busting ?t= parameter that getJSON adds
      const r = await fetch(`${SAT}available.json`, { cache: 'no-store' });
      if (!r.ok) throw new Error('satellite list ' + r.status);
      const list = await r.json();
      const frames = list.filter((x) => x.params.area === 'europe' && x.params.type === 'infrared' && x.params.size === 'normal')
        .map((x) => x.params.time).sort().slice(-4);
      if (!frames.length) throw new Error('no frames');
      const urls = frames.map((t) => `${SAT}?area=europe&type=infrared&size=normal&time=${encodeURIComponent(t)}`);
      urls.forEach((u) => { new Image().src = u; }); // preload the loop
      let i = 0;
      clearInterval(satTimer);
      const show = () => {
        img.src = urls[i];
        $('#sat-time').textContent = `Frame ${i + 1}/${urls.length}: ${hm(frames[i])} ship time${i === urls.length - 1 ? ' (latest)' : ''}`;
        i = (i + 1) % urls.length;
      };
      show();
      satTimer = setInterval(show, 900);
    } catch {
      img.removeAttribute('src');
      $('#sat-time').textContent = 'Satellite picture not available (offline?).';
    }
    loadCloudWind();
  }

  async function loadCloudWind() {
    const box = document.getElementById('sat-wind');
    if (!box) return;
    const s = shipNow();
    const [lat, lon, where] = s.sailing ? [s.lat, s.lon, 'at the ship'] : [69.65, 18.96, 'at Tromsø (not sailing yet)'];
    try {
      const js = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&hourly=wind_speed_700hPa,wind_direction_700hPa&forecast_days=2&timezone=GMT`);
      const t0 = Math.floor(Date.now() / 3600e3) * 3600e3;
      const at = (dh) => {
        const k = js.hourly.time.findIndex((x) => new Date(x + ':00Z').getTime() === t0 + dh * 3600e3);
        return k < 0 ? null : { t: t0 + dh * 3600e3, dir: js.hourly.wind_direction_700hPa[k], v: js.hourly.wind_speed_700hPa[k] };
      };
      const toward = (d) => (d + 180) % 360; // wind direction is where it comes FROM; clouds move the other way
      const word = (d) => COMPASS[Math.round(toward(d) / 45) % 8];
      const arrow = (d, size) => `<svg viewBox="-12 -12 24 24" width="${size}" height="${size}" aria-hidden="true"><g transform="rotate(${toward(d)})"><line x1="0" y1="10" x2="0" y2="-3" stroke="#9fd3ff" stroke-width="3" stroke-linecap="round"/><path d="M0,-11 L6,-2 L-6,-2 Z" fill="#9fd3ff"/></g></svg>`;
      const now = at(0);
      if (!now) throw new Error('no data');
      LIVE.drift = `toward the ${word(now.dir)}`;
      LIVE.from = COMPASS[Math.round(now.dir / 45) % 8]; // wind direction = where new clouds come from
      basicRefresh();
      const later = [3, 6].map(at).filter(Boolean);
      box.innerHTML = `<div class="satwind-now">${arrow(now.dir, 44)}<div><div class="v">Clouds moving toward the ${word(now.dir)}</div>
          <div class="s">about ${Math.round(now.v)} km/h · wind at ~3 km height ${where} · north is up, like the picture</div></div></div>
        <div class="satwind-later">${later.map((x) => `<span>${hm(x.t)} ${arrow(x.dir, 18)} ${word(x.dir)}, ${Math.round(x.v)} km/h</span>`).join('')}</div>`;
    } catch {
      box.innerHTML = '<div class="hint">Cloud drift not available (offline?).</div>';
    }
  }

  // ------------------------------------------------------------ all-sky cameras (ground truth, live)
  const AI_BASE = 'https://tromsoe-ai.cei.uec.ac.jp/~nanjo/public/aurora_alert/';
  const AI_AURORA = ['Arc', 'Discrete', 'Diffuse', 'Aurora but cloudy', 'Aurora but bright'];
  // What the camera AI sees, in plain words. `a` = its percentages.
  // Sun altitude in degrees (low-precision solar position): tells real twilight from a moonlit sky.
  function sunAltAt(t, lat, lon) {
    const R = Math.PI / 180, d = t.getTime() / 864e5 - 10957.5; // days since J2000
    const g = (357.529 + 0.98560028 * d) * R, q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * R, e = (23.439 - 3.6e-7 * d) * R;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ha = (((18.697374558 + 24.06570982441908 * d) % 24) * 15 + lon) * R - ra;
    return Math.asin(Math.sin(lat * R) * Math.sin(dec) + Math.cos(lat * R) * Math.cos(dec) * Math.cos(ha)) / R;
  }

  // The AI reads a moonlit sky as "dusk/dawn" and then hesitates about aurora ("aurora but bright").
  function aiVerdict(a, sunAlt) {
    const aurora = AI_AURORA.reduce((s, k) => s + (a[k] || 0), 0);
    const type = AI_AURORA.reduce((b, k) => ((a[k] || 0) > (a[b] || 0) ? k : b), AI_AURORA[0]);
    const bright = a['Aurora but bright'] || 0;
    if (aurora >= 50) return ['good', `Aurora now (${type.toLowerCase()})`, aurora];
    if ((a['Dusk/Dawn'] || 0) >= 50 && sunAlt != null && sunAlt < -10) {
      return ['moon', bright >= 10 ? `Possible aurora (${Math.round(bright)}%), bright sky` : 'Bright sky (moonlight)', aurora];
    }
    if ((a['Dusk/Dawn'] || 0) >= 50) return ['day', 'Daylight / twilight', aurora];
    if ((a.Cloudy || 0) >= 50) return ['cloud', 'Cloudy', aurora];
    if ((a.Clear || 0) >= 50) return ['clear', 'Clear sky, no aurora', aurora];
    return ['mixed', aurora >= 25 ? `Possible aurora (${Math.round(aurora)}%), mixed sky` : 'Mixed / uncertain', aurora];
  }

  const AI_SITES = [['tromso', 'Tromsø', 'Data.json', 69.65, 18.96], ['skibotn', 'Skibotn (between Tromsø and Alta)', 'Data_skibotn.json', 69.35, 20.36],
    ['kiruna', 'Kiruna (Sweden)', 'Data_kiruna.json', 67.84, 20.41]];
  function renderCams() {
    const el = $('#cams');
    if (!el) return;
    const t = Date.now();
    const sites = AI_SITES;
    el.innerHTML = `<h3>Sky cameras right now</h3>
      <p class="hint" style="margin-top:0">Research all-sky cameras film the whole sky every minute. An AI (Tromsø AI) looks at each picture and says whether it shows aurora, clear sky or cloud. This is what is really happening up north now, even when the ship's sky is cloudy.</p>
      <div class="ailabel">AI verdict on the latest picture</div>
      <div class="aichips">${sites.map(([id, name]) => `<div class="aichip" id="ai-${id}"><div class="k">${esc(name)}</div><div class="v">…</div><div class="s"></div></div>`).join('')}</div>
      <div class="grid2" style="margin-top:10px">
        <figure class="cam"><img src="https://fox.phys.uit.no/ASC/Latest_ASC01.png?t=${t}" data-live="https://fox.phys.uit.no/ASC/Latest_ASC01.png" alt="Skibotn all-sky camera, latest image" loading="lazy"><figcaption>Skibotn (UiT) · <a href="https://fox.phys.uit.no/ASC/ASC01.html" target="_blank" rel="noopener">live page</a> · <a href="https://fox.phys.uit.no/ASC/keogram_ASC01.png?t=${t}" target="_blank" rel="noopener">tonight's keogram</a></figcaption></figure>
        <figure class="cam"><img src="https://www.irf.se/alis/allsky/krn/latest_medium.jpeg?t=${t}" data-live="https://www.irf.se/alis/allsky/krn/latest_medium.jpeg" alt="Kiruna all-sky camera, latest image" loading="lazy"><figcaption>Kiruna (IRF) · <a href="https://www2.irf.se/Observatory/?link=All-sky_sp_camera" target="_blank" rel="noopener">live page</a> · <a href="https://www.irf.se/alis/allsky/krn/latest_nkeogram.gif?t=${t}" target="_blank" rel="noopener">last night's keogram</a></figcaption></figure>
      </div>
      <p class="hint">A round fisheye picture of the whole sky: north is up, the edge is the horizon. In daylight the picture is white or washed out; at night: dark grey all over = cloud, stars = clear, green bands = aurora. Keogram = the whole night squeezed into one picture (time runs left to right). Classification: <a href="https://tromsoe-ai.cei.uec.ac.jp/" target="_blank" rel="noopener">Tromsø AI</a> (UEC Japan).</p>`;
    loadAiChips();
  }

  function loadAiChips() {
    for (const [id, , file, la, lo] of AI_SITES) {
      getJSON(AI_BASE + file).then((js) => {
        const when = new Date(js.Time.replace(' ', 'T') + 'Z');
        const [cls, text, aurora] = aiVerdict(js.Aurora || {}, sunAltAt(when, la, lo));
        const box = document.getElementById(`ai-${id}`);
        if (!box) return;
        box.className = `aichip ${cls}`;
        box.querySelector('.v').textContent = `AI: ${text}`;
        const paused = Date.now() - when > 45 * 60000;
        box.querySelector('.s').textContent = `aurora ${Math.round(aurora)}% · clear ${Math.round(js.Aurora.Clear || 0)}% · cloudy ${Math.round(js.Aurora.Cloudy || 0)}% · picture from ${hm(when)} ship time${paused ? ' (cameras pause in daylight; this is the last dark-sky picture)' : ''}${cls === 'moon' ? ' · the AI is unsure in moonlight: look at the picture' : ''}`;
      }).catch(() => { const box = document.getElementById(`ai-${id}`); if (box) box.querySelector('.v').textContent = 'offline'; });
    }
  }

  // ------------------------------------------------------------ local magnetometers (Tromsø Geophysical Observatory)
  let magSite = 'tro2a';
  function renderMag() {
    const el = $('#mag');
    if (!el) return;
    const sites = [['tro2a', 'Tromsø'], ['sor1a', 'Sørøya (near Alta)']];
    el.innerHTML = `<h3>Local magnetometer <span class="why">· last 24 h</span></h3>
      <p class="hint" style="margin-top:0">The most direct "is something happening right above us" signal. When aurora is active overhead, the Earth's magnetic field there starts to wobble.</p>
      <div class="daytabs">${sites.map(([id, name]) => `<button class="btn ${id === magSite ? 'on' : ''}" data-m="${id}">${name}</button>`).join('')}</div>
      <a href="https://flux.phys.uit.no/Last24/Last24_${magSite}.gif" target="_blank" rel="noopener"><img class="magimg" src="https://flux.phys.uit.no/Last24/Last24_${magSite}.gif?t=${Date.now()}" data-live="https://flux.phys.uit.no/Last24/Last24_${magSite}.gif" alt="Magnetogram, last 24 hours" loading="lazy"></a>
      <p class="hint"><b>How to read it:</b> look at the <b style="color:#6da7ec">blue line</b> (horizontal field). Flat or gently wavy = quiet. A <b>sudden dip of 50+ nT</b> within minutes = a substorm, aurora is active over that area now; <b>200+ nT</b> = strong display. The time axis is UTC: add 2 hours for ship time. Updates every few minutes. Source: Tromsø Geophysical Observatory (UiT).</p>
      <div class="ailabel" style="margin-top:14px">Nearby Finnish station and Hp30, ship time</div>
      <div class="chart" id="mag-chart"></div>
      <p class="hint" id="mag-chart-note"></p>
      <p class="hint">Direct links, if the picture above does not load: <a href="https://flux.phys.uit.no/Last24/Last24_tro2a.gif" target="_blank" rel="noopener">Tromsø magnetogram</a> · <a href="https://flux.phys.uit.no/Last24/Last24_sor1a.gif" target="_blank" rel="noopener">Sørøya magnetogram</a> · <a href="https://flux.phys.uit.no/stackplot/" target="_blank" rel="noopener">all stations on one chart</a> · <a href="https://flux.phys.uit.no/Last24/" target="_blank" rel="noopener">TGO realtime page</a></p>`;
    el.querySelectorAll('.daytabs button').forEach((b) => b.addEventListener('click', () => { magSite = b.dataset.m; renderMag(); }));
    drawMagChart();
  }

  // Our own chart next to the TGO picture: the FMI station near the chosen site (Kilpisjärvi for Tromsø,
  // Masi for Sørøya/Alta) and, on the same ship-time axis, the half-hourly planetary Hp30.
  function drawMagChart() {
    const cont = $('#mag-chart');
    if (!cont) return;
    const code = magSite === 'tro2a' ? 'KIL' : 'MAS';
    const area = magSite === 'tro2a' ? 'Tromsø' : 'Alta';
    const st = MAG && MAG.stations && MAG.stations[code];
    const t1 = Date.now(), t0 = t1 - 24 * 3600e3;
    const W = widthOf(cont), ml = 40, mr = 30, mt = 10, ph = 240, mb = 24;
    const H = mt + ph + mb, pw = W - ml - mr, bottom = mt + ph;
    const x = (t) => ml + ((t - t0) / (t1 - t0)) * pw;

    // Left axis: magnetometer, nT against its quiet level.
    const pts = [];
    if (st && st.series) {
      const s0 = new Date(st.series.t0).getTime(), step = st.series.step_min * 60e3;
      st.series.dev.forEach((v, i) => { const t = s0 + i * step; if (t >= t0 && t <= t1) pts.push([t, v]); });
    }
    const vals = pts.filter((p) => p[1] != null).map((p) => p[1]);
    const lo = Math.min(-150, Math.floor((Math.min(0, ...vals) - 10) / 50) * 50);
    const hi = Math.max(50, Math.ceil((Math.max(0, ...vals) + 10) / 50) * 50);
    const y1 = (v) => mt + ((hi - v) / (hi - lo)) * ph;
    const stepV = hi - lo > 400 ? 100 : 50;
    const ticks = [];
    for (let v = Math.ceil(lo / stepV) * stepV; v <= hi; v += stepV) ticks.push(v);

    // Right axis: Hp30, bars from the bottom.
    const need = kpNeedAt(...(magSite === 'tro2a' ? [69.65, 18.96] : [69.98, 23.25])); // the station's area, not the ship
    const hp = (HP30 || []).map(([ts, v]) => [new Date(ts).getTime(), v]).filter(([t]) => t >= t0 - 1800e3 && t <= t1);
    const hmax = Math.max(4, Math.ceil(Math.max(need, ...hp.map((p) => p[1])) + 0.5));
    const y2 = (v) => bottom - (Math.min(v, hmax) / hmax) * ph;

    let g = '';
    for (let t = Math.ceil(t0 / 3600e3) * 3600e3; t <= t1; t += 3600e3) {
      if (shipDate(t).getUTCHours() % 3) continue;
      g += `<line x1="${x(t)}" x2="${x(t)}" y1="${mt}" y2="${bottom}" stroke="#2c2c2a"/>`;
      g += `<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${hm(t)}</text>`;
    }
    g += ticks.map((v) => `<line x1="${ml}" x2="${ml + pw}" y1="${y1(v)}" y2="${y1(v)}" stroke="#2c2c2a"/><text x="${ml - 6}" y="${y1(v) + 4}" text-anchor="end" style="fill:#6da7ec">${v}</text>`).join('');
    for (let v = 0; v <= hmax; v += hmax > 6 ? 2 : 1) g += `<text x="${ml + pw + 6}" y="${y2(v) + 4}" style="fill:#1faa59">${v}</text>`;
    const bw = (pw / 48) * 0.72;
    for (const [t, v] of hp) {
      const cx = x(t + 900e3);
      if (cx < ml || cx > ml + pw) continue;
      g += `<path d="${roundTopBar(cx - bw / 2, y2(v), bw, bottom - y2(v), 2)}" fill="${v >= need ? '#1faa59' : '#5b6b80'}" opacity="0.45"/>`;
    }
    g += `<line x1="${ml}" x2="${ml + pw}" y1="${y2(need)}" y2="${y2(need)}" stroke="#1faa59" stroke-dasharray="2 4"/>`;
    g += `<text class="ref" x="${ml + pw - 2}" y="${y2(need) - 4}" text-anchor="end">Hp30 needed in ${area} ≈${need.toFixed(1)}</text>`;
    g += `<line x1="${ml}" x2="${ml + pw}" y1="${y1(0)}" y2="${y1(0)}" stroke="#555"/>`;
    for (const [v, lab] of [[-50, '−50 nT: active'], [-200, '−200 nT: strong']]) {
      if (v < lo) continue;
      g += `<line x1="${ml}" x2="${ml + pw}" y1="${y1(v)}" y2="${y1(v)}" stroke="#f2c230" stroke-dasharray="4 4" opacity="0.8"/>`;
      g += `<text class="ref" x="${ml + 4}" y="${y1(v) + 14}">${lab}</text>`;
    }
    let seg = [];
    const flush = () => { if (seg.length > 1) g += `<polyline points="${seg.join(' ')}" fill="none" stroke="#3987e5" stroke-width="1.8" stroke-linejoin="round"/>`; seg = []; };
    for (const [t, v] of pts) { if (v == null) flush(); else seg.push(`${x(t).toFixed(1)},${y1(v).toFixed(1)}`); }
    flush();
    g += '<g class="hl"></g>';
    cont.innerHTML = `<div class="legend"><span><i style="background:#3987e5"></i>${st ? esc(st.name) : 'Magnetometer'}, nT vs quiet level (left)</span><span><i style="background:#1faa59;opacity:.6"></i>Hp30, planetary (right)</span></div>`
      + svgTag(W, H, 'Local magnetometer and Hp30, last 24 hours', g);

    // Hover: half-hour slots with the magnetometer low point and the Hp30 value.
    const slots = [];
    for (let t = Math.floor(t0 / 1800e3) * 1800e3; t < t1; t += 1800e3) slots.push(t);
    const bands = slots.map((t) => [Math.max(ml, x(t)), Math.min(ml + pw, x(t + 1800e3))]);
    const hl = cont.querySelector('.hl');
    bindHover(cont, W, bands, (i) => {
      const a = slots[i], b = a + 1800e3;
      const m = pts.filter(([t, v]) => t >= a && t < b && v != null).map((p) => p[1]);
      const h = hp.find(([t]) => t === a);
      return `<b>${hm(a)}–${hm(b)}</b><div class="row"><span>Magnetometer low</span><span>${m.length ? Math.min(...m) + ' nT' : '–'}</span></div>`
        + `<div class="row"><span>Hp30</span><span>${h ? h[1].toFixed(1) : '–'}</span></div>`;
    }, (i) => hlBand(hl, bands, i, mt, ph));

    const lastT = st && st.t ? new Date(st.t) : null;
    $('#mag-chart-note').innerHTML = `Blue line (left scale): the horizontal magnetic field at ${st ? esc(st.name) : 'the nearby station'} (FMI), about ${magSite === 'tro2a' ? 100 : 70} km from ${area}, compared with its quiet level: below −50 nT = aurora active overhead, below −200 nT = strong. It can dip less or more than the ${magSite === 'tro2a' ? 'Tromsø' : 'Sørøya'} picture above: different spot under the aurora. Green bars (right scale): Hp30, the same kind of measurement averaged over the whole planet.`
      + (!st ? ' <b>No magnetometer data yet</b> (the robot logs it after dark).'
        : t1 - lastT > 40 * 60e3 ? ` The line ends at ${hm(lastT)}: the robot logs it after dark only.` : '');
  }

  // Collapsed extra: the same "overhead now" numbers for every port and every at-sea night position.
  async function renderRouteOvation() {
    const body = $('#route-ov-body');
    if (!body) return;
    const R = Math.PI / 180;
    const kpNeed = (lat, lon) => {
      const m = Math.asin(Math.sin(lat * R) * Math.sin(80.8 * R) + Math.cos(lat * R) * Math.cos(80.8 * R) * Math.cos((lon + 72.6) * R)) / R;
      return Math.max(0, Math.min(9, (67.5 - m) / 1.8 + 0.5));
    };
    const pts = [];
    const seen = new Set();
    for (const st of D.trip.stops) {
      if (seen.has(st.name)) continue;
      seen.add(st.name);
      pts.push({ when: (st.arrive || st.depart).slice(0, 10), where: st.name, lat: st.lat, lon: st.lon });
    }
    for (const n of D.nights) if (n.state === 'sea') pts.push({ when: n.date, where: 'At sea (night)', lat: n.lat, lon: n.lon });
    pts.sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0));
    try {
      const o = await getOvation();
      body.innerHTML = `<div class="tbl-wrap"><table>
        <tr><th>Where</th><th>Overhead now</th><th>In view north</th><th>Kp needed</th></tr>
        ${pts.map((p) => { const v = ovationAt(o, p.lat, p.lon); return `<tr><td>${esc(p.where)} <span class="why">${shortDay(p.when)}</span></td><td>${v.local}%</td><td>${v.north}%</td><td>${kpNeed(p.lat, p.lon).toFixed(1)}</td></tr>`; }).join('')}
      </table></div>
      <p class="hint">Just for fun: what NOAA's OVATION model says right now for each place on the route (sea positions = where the ship will be around midnight). It is the aurora of this moment, not a forecast for the cruise dates.</p>`;
    } catch { body.innerHTML = '<div class="empty">Could not load the NOAA model (offline?).</div>'; }
  }

  // NOAA OVATION grid (1° x 1°) drawn on a Norway-centred map, with route and ship.
  let OVATION = null; // shared promise, so the tile, the map and the route table download the model once
  function getOvation() {
    if (!OVATION) OVATION = getJSON(`${SWPC}/json/ovation_aurora_latest.json`).catch((e) => { OVATION = null; throw e; });
    return OVATION;
  }
  const ovColor = (p) => (p >= 60 ? '#e5533d' : p >= 40 ? '#f2c230' : p >= 20 ? '#9fd13b' : '#1faa59');

  // The map is built once; each refresh only swaps the coloured probability layer.
  let ovMap = null, ovCells = null, ovRenderer = null;
  async function drawOvationMap() {
    const box = $('#ovmap');
    if (!box) return;
    if (!window.L) { box.innerHTML = '<div class="empty">Map library could not load (offline?).</div>'; return; }
    if (!ovMap) box.innerHTML = '<div class="empty">Loading NOAA model…</div>';
    let o;
    try { o = await getOvation(); } catch {
      if (!ovMap) { box.innerHTML = '<div class="empty">Could not load the NOAA model (offline?). <button class="btn" id="ovmap-btn">Retry</button></div>'; $('#ovmap-btn').addEventListener('click', drawOvationMap); }
      return;
    }
    if (!ovMap) {
      box.innerHTML = '';
      box.classList.add('ovmap');
      ovMap = L.map(box, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 8, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · NOAA SWPC OVATION',
      }).addTo(ovMap);
      ovMap.createPane('cells').style.zIndex = 350; // under the route and ship markers
      ovRenderer = L.canvas({ padding: 0.3, pane: 'cells' });
      L.polyline(D.route_hourly.map((r) => [r[1], r[2]]), { color: '#9085e9', weight: 1.5, opacity: 0.7, dashArray: '4 4' }).addTo(ovMap);
      const s = shipNow();
      if (s.sailing) L.circleMarker([s.lat, s.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#3ee08f', fillOpacity: 1 }).addTo(ovMap).bindTooltip('Ship now', { permanent: true, direction: 'right' });
      else for (const [name, lat, lon, dir] of [['Tromsø', 69.65, 18.96, 'left'], ['Alta', 69.98, 23.25, 'right']]) L.circleMarker([lat, lon], { radius: 4, color: '#fff', weight: 1, fillColor: '#fff', fillOpacity: 1 }).addTo(ovMap).bindTooltip(name, { permanent: true, direction: dir });
      ovMap.fitBounds([[61, 4], [75, 30]]);
    }
    if (ovCells) ovCells.remove();
    ovCells = L.layerGroup();
    for (const [glon, glat, p] of o.coordinates) {
      if (p < 5 || glat < 52 || glat > 84) continue;
      const lon = glon > 180 ? glon - 360 : glon;
      if (lon < -30 || lon > 50) continue;
      L.rectangle([[glat - 0.5, lon - 0.5], [glat + 0.5, lon + 0.5]], {
        renderer: ovRenderer, stroke: false, fillColor: ovColor(p), fillOpacity: Math.min(0.75, 0.25 + p / 120), interactive: false,
      }).addTo(ovCells);
    }
    ovCells.addTo(ovMap);
    const ft = o['Forecast Time'] || o['Observation Time'];
    $('#ovmap-meta').textContent = ft ? `Model valid for ${hm(ft)} ship time (${ago(o['Observation Time'] || ft)} data). Refreshes every 10 min while this page is open.` : '';
  }

  async function loadBz() {
    const btn = $('#bz-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      const raw = await getJSON(`${SWPC}/json/rtsw/rtsw_mag_1m.json`);
      const rows = raw.filter((r) => r.active && r.bz_gsm != null).map((r) => [new Date(r.time_tag + 'Z').getTime(), r.bz_gsm]).sort((a, b) => a[0] - b[0]);
      const bins = new Map();
      for (const [t, v] of rows) { const k = Math.floor(t / 600e3) * 600e3; const b = bins.get(k) || [0, 0]; b[0] += v; b[1]++; bins.set(k, b); }
      bzPts = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([t, [s, n]]) => [t, s / n]);
      if (btn) btn.remove();
      drawBz();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Retry (offline?)'; } // on a background refresh keep the last chart
    }
  }

  function drawBz() {
    const cont = $('#bz-chart');
    if (!bzPts || !cont) return;
    const pts = bzPts;
    const W = widthOf(cont), H = 220, ml = 34, mr = 6, mt = 10, mb = 26;
    const pw = W - ml - mr, ph = H - mt - mb;
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    const lim = Math.max(10, Math.ceil(Math.max(...pts.map((p) => Math.abs(p[1]))) / 5) * 5);
    const x = (t) => ml + ((t - t0) / (t1 - t0)) * pw;
    const y = (v) => mt + ph / 2 - (v / lim) * (ph / 2);
    let g = `<rect x="${ml}" y="${y(-5)}" width="${pw}" height="${y(-lim) - y(-5)}" fill="rgba(12,163,12,0.08)"/>`;
    g += `<text x="${ml + 4}" y="${y(-lim) - 4}" class="lbl">below −5: good for aurora</text>`;
    for (let v = -lim; v <= lim; v += 5) g += `<line x1="${ml}" x2="${ml + pw}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? '#555' : '#2c2c2a'}"/><text x="${ml - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    const stepH = pw < 450 ? 6 : 3;
    for (let t = Math.ceil(t0 / (stepH * 3600e3)) * stepH * 3600e3; t <= t1; t += stepH * 3600e3) g += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${hm(t)}</text>`;
    g += '<g class="hl"></g>';
    g += `<polyline points="${pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')}" fill="none" stroke="#3987e5" stroke-width="2" stroke-linejoin="round"/>`;
    cont.innerHTML = svgTag(W, H, 'Solar wind Bz, 10-minute means', g) + '<div class="hint">10-minute means, ship time. Source: NOAA real-time solar wind (L1 point, ~1 h upstream).</div>';
    const xs = pts.map((p) => x(p[0]));
    const bands = xs.map((cx, i) => [i === 0 ? ml : (xs[i - 1] + cx) / 2, i === xs.length - 1 ? ml + pw : (cx + xs[i + 1]) / 2]);
    const hl = cont.querySelector('.hl');
    bindHover(cont, W, bands, (i) => `<b>${hm(pts[i][0])}</b><div class="row"><span>Bz</span><span>${pts[i][1].toFixed(1)} nT</span></div>`,
      (i) => { hl.innerHTML = i < 0 ? '' : `<circle cx="${xs[i]}" cy="${y(pts[i][1])}" r="4.5" fill="#3987e5" stroke="#16171a" stroke-width="2"/>`; });
  }

  // ------------------------------------------------------------ map
  function renderMap() {
    if (!window.L) { $('#map').innerHTML = '<div class="empty">Map library could not load (offline?).</div>'; return; }
    const map = L.map('map', { scrollWheelZoom: false });
    // Standard OSM tiles (no key needed), darkened with a CSS filter on the tile pane.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 10, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const pl = L.polyline(D.route_hourly.map((r) => [r[1], r[2]]), { color: '#9085e9', weight: 2, opacity: 0.8 }).addTo(map);
    const seen = new Set();
    for (const s of D.trip.stops) {
      if (seen.has(s.name)) continue; seen.add(s.name);
      L.circleMarker([s.lat, s.lon], { radius: 4, color: '#fff', weight: 1, fillColor: '#fff', fillOpacity: 1 }).addTo(map).bindTooltip(s.name);
    }
    for (const n of D.nights) {
      L.circleMarker([n.lat, n.lon], { radius: 8, color: '#16171a', weight: 2, fillColor: RATING_HEX[n.rating], fillOpacity: 1 })
        .addTo(map).bindPopup(`<b>${dayLabel(n.date)}</b><br>${esc(shortPlace(n.place))}<br>${pct(n.score)} · ${n.rating}`);
    }
    const s = shipNow();
    if (s.sailing) {
      L.circleMarker([s.lat, s.lon], { radius: 10, color: '#3ee08f', weight: 3, fillColor: '#3ee08f', fillOpacity: 0.35 }).addTo(map).bindTooltip('Ship now (from itinerary)', { permanent: true });
    }
    map.fitBounds(pl.getBounds(), { padding: [20, 20] });
  }

  // ------------------------------------------------------------ verification log (past nights)
  function verificationTable() {
    const recs = VER && VER.nights ? Object.values(VER.nights).filter((r) => r.observed).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.spot.localeCompare(b.spot))) : [];
    if (!recs.length) return '';
    const hoursTxt = (arr) => (arr && arr.length ? `${arr[0]}–${arr[arr.length - 1]} (${arr.length} h)` : 'none');
    const LEADS = [['forecast_2d', '2 days before'], ['forecast_1d', '1 day before'], ['forecast', 'Same evening']];
    // Did a recorded forecast get the clouds right? null when not recorded.
    const judge = (r, key) => {
      const o = r.observed, f = r[key];
      if (!f) return null;
      const good = f.hours.filter((h) => h[1] === 'GO' || h[1] === 'TRY').map((h) => h[0]);
      const clear = new Set([...(o.clear_dark || []), ...(o.clear_twilight || [])]);
      const ok = good.length ? good.some((h) => clear.has(h)) : !clear.size;
      return { ok, good, f };
    };
    const fcCell = (r) => {
      const lines = LEADS.map(([key, label]) => {
        const j = judge(r, key);
        if (!j) return '';
        const win = j.good.length ? `${j.good[0]}–${j.good[j.good.length - 1]}` : 'no window';
        return `<div><span class="why">${label}:</span> ${pct(j.f.score)} ${j.f.rating} · ${win} ${j.ok ? '<span class="ok">✓</span>' : '<span class="why">✕</span>'}</div>`;
      }).join('');
      return lines || '<span class="why">not recorded</span>';
    };
    // What the all-sky camera AI saw that night (Tromsø camera for Tromsø, Skibotn camera for Alta).
    const camCell = (r) => {
      if (r.spot !== 'Tromsø') return '<span class="why">– no camera nearby</span>'; // Skibotn is ~140 km from Alta
      const site = 'tromso';
      const hrs = SKY && SKY.nights && SKY.nights[r.date] && SKY.nights[r.date][site];
      if (!hrs) return '<span class="why">–</span>';
      const list = Object.entries(hrs).sort(([a], [b]) => hourOrder(a, b));
      const hoursOf = (w) => list.filter(([, v]) => camWord(v) === w).map(([h]) => `${h}:00`);
      const aur = hoursOf('aurora'), poss = hoursOf('possible aurora');
      const clear = hoursOf('clear').length, moon = hoursOf('bright (moon)').length;
      const label = site === 'skibotn' ? '<span class="why"> (Skibotn cam)</span>' : '';
      if (aur.length) return `<span class="ok">✓ aurora</span> ${span(aur)} <span class="why">(${aur.length} h)</span>${label}`;
      if (poss.length) return `<span class="ok">possible aurora</span> ${span(poss)} <span class="why">(bright sky, ${poss.length} h)</span>${label}`;
      if (clear) return `clear, no aurora <span class="why">(${clear} h)</span>${label}`;
      if (moon * 2 >= list.length) return `bright sky (moon), AI unsure <span class="why">(${moon} h)</span>${label}`;
      return `cloudy <span class="why">(${list.length} h checked)</span>${label}`;
    };
    const row = (r) => {
      const o = r.observed;
      return `<tr><td>${shortDay(r.date)}</td><td>${esc(r.spot)}</td><td style="text-align:left">${fcCell(r)}</td><td>${hoursTxt(o.clear_dark)}${o.clear_twilight && o.clear_twilight.length ? `<span class="why"> +twilight ${o.clear_twilight.join(', ')}</span>` : ''}</td><td>${camCell(r)}</td><td>${o.hp30_max_dark != null ? o.hp30_max_dark.toFixed(1) : '–'} <span class="why">(need ${o.kp_needed})</span></td></tr>`;
    };
    const score = (key) => {
      const js = recs.map((r) => judge(r, key)).filter(Boolean);
      return js.length ? `${js.filter((j) => j.ok).length} of ${js.length}` : '–';
    };
    const clearNights = recs.filter((r) => r.observed.clear_dark && r.observed.clear_dark.length).length;
    const summary = `<div class="versum">
      <div><b>${score('forecast')}</b><span>same-evening forecasts right about the clouds</span></div>
      <div><b>${score('forecast_1d')} · ${score('forecast_2d')}</b><span>right 1 day · 2 days before</span></div>
      <div><b>${clearNights} of ${recs.length}</b><span>nights had clear dark hours (Tromsø + Alta)</span></div></div>`;
    return `
      <h3 style="margin-top:18px">How did it go? Past nights</h3>
      ${summary}
      <div class="tbl-wrap"><table>
        <tr><th>Night</th><th>Spot</th><th style="text-align:left">Forecast (✓ = clouds right)</th><th>Actually clear (dark)</th><th>Camera saw</th><th>Hp30 max</th></tr>
        ${recs.map(row).join('')}
      </table></div>
      <p class="hint">Forecasts are recorded from 27 Sep on, 2 days before, 1 day before and on the evening itself; the first results appear the morning after. Clear = MET Norway's analysed cloud ≤40% (from its latest runs, not a satellite photo). Camera saw = what the all-sky camera AI saw that night, checked once an hour (from 28 Sep on): the real ground truth. Hp30 max = strongest half-hour of planetary activity in the dark hours; it can underrate local substorms right under the auroral oval.</p>`;
  }

  // ------------------------------------------------------------ model check (next 3 nights in Tromsø and Alta)
  let checkDay = 0;
  let checkSpot = 0;
  const checkNights = () => {
    const mc = D.model_check;
    if (!mc) return [];
    const days = mc.days || [mc.date];
    return mc.nights.filter((n) => (n.date || mc.date) === days[Math.min(checkDay, days.length - 1)]);
  };
  const checkNight = () => checkNights()[checkSpot] || null;

  function renderCheck() {
    const mc = D.model_check;
    const body = $('#check-body');
    if (!mc || !mc.nights.length) { body.innerHTML = '<div class="empty">Model check data will appear after the next update.</div>'; return; }
    const days = mc.days || [mc.date];
    const tabName = (i) => ['Tonight', 'Tomorrow', 'Day after'][i] || dayLabel(days[i]);
    const nowRow = (n) => n.hourly.reduce((b, h) => (Math.abs(new Date(h.t) - Date.now()) < Math.abs(new Date(b.t) - Date.now()) ? h : b));
    body.innerHTML = `
      <p class="hint" style="margin-top:0">${esc(mc.note)} Compare with Norway Lights or yr.no, or just look outside.</p>
      <div class="daytabs">${days.map((d, i) => `<button class="btn ${i === checkDay ? 'on' : ''}" data-day="${i}">${tabName(i)} <span class="why">${shortDay(d)}</span></button>`).join('')}</div>
      <div class="tbl-wrap"><table>
        <tr><th>${dayLabel(days[checkDay])}</th><th>Chance</th><th>Best window</th><th>${checkDay === 0 ? 'MET cloud' : 'Cloud source'}</th></tr>
        ${checkNights().map((n, i) => {
          const w = bestWindow(n);
          // the forecast hour closest to now (the night's hours start at 17:00), with its time so it is not read as "now"
          const r = nowRow(n);
          const last = checkDay === 0 ? (r.cloud_met != null ? `${Math.round(r.cloud_met)}% <span class="why">at ${r.local}</span>` : '–') : esc(n.clear.source);
          return `<tr class="pick ${i === checkSpot ? 'sel' : ''}" data-i="${i}"><td>${esc(n.spot)}</td><td>${pct(n.score)} ${chip(n.rating)}</td><td>${w ? `${w.text} ${w.label}` : metCovers(n) ? 'none' : `<span class="why">not yet${metFromText(n) ? ` · from ${metFromText(n)}` : ''}</span>`}</td><td>${last}</td></tr>`;
        }).join('')}
      </table></div>
      <div id="check-detail" style="border-top:1px solid var(--border);padding-top:12px"></div>
      ${verificationTable()}`;
    body.querySelectorAll('tr.pick').forEach((tr) => tr.addEventListener('click', () => { checkSpot = +tr.dataset.i; renderCheck(); }));
    body.querySelectorAll('.daytabs button').forEach((b) => b.addEventListener('click', () => { checkDay = +b.dataset.day; renderCheck(); }));
    $('#check-detail').innerHTML = detailHTML(checkNight(), 'check-chart');
    drawHourly(checkNight(), $('#check-chart'));
  }

  // ------------------------------------------------------------ itinerary: mark today (ship/Budapest date)
  function markItineraryToday() {
    const today = shipDate(Date.now()).toISOString().slice(0, 10);
    document.querySelectorAll('table.itin tr[data-d]').forEach((tr) => {
      tr.classList.toggle('today', tr.dataset.d === today);
      tr.classList.toggle('past', tr.dataset.d < today);
    });
  }

  // ------------------------------------------------------------ itinerary status line ("Now: …")
  // Local time: England UTC+1, Norway UTC+2 (both summer time until 25 Oct).
  const tzOff = (lat) => (lat < 55 ? 1 : 2);
  const localHm = (t, lat) => { const d = new Date(new Date(t).getTime() + tzOff(lat) * 3600e3); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); };
  const localDay = (t, lat) => { const d = new Date(new Date(t).getTime() + tzOff(lat) * 3600e3); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const inTime = (t) => {
    const m = Math.round((new Date(t) - Date.now()) / 60000);
    if (m < 60) return `in ${m} min`;
    if (m < 48 * 60) return `in ${Math.round(m / 60)} h`;
    return `in ${Math.round(m / 1440)} days`;
  };

  function renderItinNow() {
    const el = $('#itin-now');
    if (!el) return;
    const now = Date.now();
    const stops = D.trip.stops;
    const start = new Date(D.trip.start).getTime(), end = new Date(D.trip.end).getTime();
    let html;
    if (now < start) {
      const s = stops[0];
      html = `<b>Not sailing yet.</b> Departure from ${esc(s.name)} ${localDay(s.depart, s.lat)} ${localHm(s.depart, s.lat)} (${inTime(s.depart)}).`;
    } else if (now > end) {
      html = '<b>Cruise completed.</b> Welcome home!';
    } else {
      const port = stops.find((s) => s.arrive && s.depart && now >= new Date(s.arrive) && now <= new Date(s.depart));
      if (port) {
        html = `<b>Now: in ${esc(port.name)}.</b> Departs ${localDay(port.depart, port.lat)} ${localHm(port.depart, port.lat)} (${inTime(port.depart)}).`;
      } else {
        const next = stops.find((s) => s.arrive && new Date(s.arrive) > now);
        html = next ? `<b>Now: at sea</b> → ${esc(next.name)}, arriving ${localDay(next.arrive, next.lat)} ${localHm(next.arrive, next.lat)} (${inTime(next.arrive)}).` : '<b>Now: at sea.</b>';
      }
    }
    el.innerHTML = `<span class="dot"></span>${html} <span class="why">From the published schedule, not live tracking.</span>`;
  }

  // ------------------------------------------------------------ weather in port
  let wxPort = null;
  const WX_ICON = (sym) => (sym ? `<img class="wxi" src="https://cdn.jsdelivr.net/gh/metno/weathericons@main/weather/svg/${encodeURIComponent(sym)}.svg" alt="${esc(sym.replace(/_/g, ' '))}" loading="lazy">` : '');
  const r1 = (v) => (v == null ? '–' : (Math.round(v * 10) / 10).toString());
  const r0 = (v) => (v == null ? '–' : Math.round(v).toString());
  const kmh = (ms) => (ms == null ? '–' : Math.round(ms * 3.6).toString()); // MET gives m/s
  const LEVEL_CLS = (lvl) => (/red/.test(lvl || '') ? 'critical' : /orange/.test(lvl || '') ? 'serious' : 'warn');

  function wxRows(series, lat, compact) {
    return series.map((e) => {
      const gCls = e.gust >= 20 ? 'wx-red' : e.gust >= 15 ? 'wx-orange' : '';
      const fCls = e.feels != null && e.feels <= 0 ? 'wx-cold' : '';
      const pCls = (e.pr || 0) >= 0.5 ? 'wx-wet' : '';
      const snow = /snow|sleet/.test(e.sym || '') ? ' <span class="wx-snow">snow/sleet</span>' : '';
      const arrow = e.dir != null ? `<span class="warr" style="transform:rotate(${Math.round(e.dir + 180)}deg)">↑</span>` : '';
      const time = `${localHm(e.t, lat)}${e.step === 6 ? '<span class="why">+6h</span>' : ''}`;
      return `<tr><td>${time}</td><td>${WX_ICON(e.sym)}${snow}</td><td>${r1(e.T)}°</td><td class="${fCls}">${r1(e.feels)}°</td>
        <td class="${gCls}">${arrow}${kmh(e.wind)}${e.gust != null ? `<span class="why"> (${kmh(e.gust)})</span>` : ''}</td>
        <td class="${pCls}">${e.pr ? r1(e.pr) : '0'}${e.pp != null && !compact ? `<span class="why"> ${r0(e.pp)}%</span>` : ''}</td>
        <td class="${e.uv >= 6 ? 'wx-orange' : e.uv >= 3 ? 'wx-uv' : ''}">${e.uv != null ? r0(e.uv) : '–'}</td></tr>`;
    }).join('');
  }
  const wxTable = (series, lat, compact) => `<div class="tbl-wrap"><table class="wx">
    <tr><th>Time</th><th>Sky</th><th>°C</th><th>Feels</th><th>Wind</th><th>Rain</th><th>UV</th></tr>${wxRows(series, lat, compact)}</table></div>
    <div class="why" style="margin-top:2px">Wind in km/h, gust in brackets · rain in mm${compact ? '' : ', chance in %'} · UV index for a clear sky: 3+ = use sunscreen</div>`;
  const wxSummaryLine = (s) => (s ? `${r0(s.t_min)}–${r0(s.t_max)} °C · feels ${r0(s.feels_min)} °C · gusts up to ${kmh(s.gust_max)} km/h · rain ${r1(s.precip_total)} mm${s.snow || s.sleet ? ' · <b>snow/sleet</b>' : ''}${s.thunder_max >= 10 ? ' · thunder' : ''}` : '');
  const adviceChips = (a) => (a && a.length ? `<div class="chips">${a.map((x) => `<span class="achip">${esc(x)}</span>`).join('')}</div>` : '');

  // At sea: waves, swell and wind every 3 h at the ship's planned position, per sea leg.
  const CMF_CLS = { calm: 'cmf-calm', gentle: 'cmf-gentle', rough: 'cmf-rough', 'very rough': 'cmf-vrough' };
  const cmf = (c) => (c ? `<span class="cmf ${CMF_CLS[c]}">${c}</span>` : '–');
  function seaView() {
    const legs = WX.sea_legs || [];
    const dayHm = (t, lat) => { const d = new Date(new Date(t).getTime() + tzOff(lat) * 3600e3); return `${DOW[d.getUTCDay()]} ${pad(d.getUTCHours())}:00`; };
    const blocks = legs.map((leg) => {
      const pts = leg.points.filter((p) => p.wave != null);
      const c = leg.climate;
      const lat = leg.points.length ? leg.points[Math.floor(leg.points.length / 2)].lat : 65;
      const head = pts.length
        ? `waves up to <b>${r1(leg.wave_max)} m</b> · ${cmf(leg.comfort)}${leg.covered < 1 ? ` <span class="why">(forecast covers ${Math.round(leg.covered * 100)}% of the leg so far)</span>` : ''}`
        : (c ? `<span class="why">no forecast yet · typical October:</span> ${r1(c.wave_mean)} m on average` : '<span class="why">no forecast yet</span>')
          + (leg.now && leg.now.wave_max != null ? ` <span class="why">· now:</span> ${r1(leg.now.wave_max)} m ${cmf(leg.now.comfort)}` : '');
      const body = pts.length
        ? `<div class="tbl-wrap"><table class="wx"><tr><th>Time</th><th>Waves</th><th>Period</th><th>Wind</th><th>Feel</th></tr>
            ${pts.map((p) => `<tr><td>${dayHm(p.t, p.lat)}</td><td>${r1(p.wave)} m</td><td>${r0(p.period)} s</td>
              <td class="${p.gust >= 20 ? 'wx-red' : p.gust >= 15 ? 'wx-orange' : ''}">${kmh(p.wind)}<span class="why"> (${kmh(p.gust)})</span></td><td>${cmf(p.comfort)}</td></tr>`).join('')}</table></div>
            <div class="why">Every 3 hours at the ship's planned position · wind in km/h, gust in brackets</div>`
        : (c ? `<div class="farbox"><div class="fb"><div class="k">Typical October on this leg (${esc(String(2011))}–2025)</div><div class="v">${r1(c.wave_mean)} m</div><div class="s">average wave height · 1 in 10 hours above ${r1(c.wave_p90)} m</div></div>
            <div class="fb"><div class="k">Rough or worse</div><div class="v">${Math.round(c.share_over_2_5 * 100)}% of hours</div><div class="s">waves over 2.5 m · over 4 m: ${Math.round(c.share_over_4 * 100)}%</div></div></div>
            <div class="why" style="margin-top:6px">The wave forecast reaches about 10 days ahead; after that this switches to an hour-by-hour table.</div>` : '');
      const n = leg.now;
      const nowPart = n && n.series && n.series.length ? `<details class="wx-now"><summary><b>Right now mid-route</b> <span class="why">(${r1(n.lat)}°N ${r1(n.lon)}°E)</span>: next 48 hours · waves up to ${r1(n.wave_max)} m · ${cmf(n.comfort)}</summary>
          <div class="tbl-wrap"><table class="wx"><tr><th>Time</th><th>Waves</th><th>Period</th><th>Wind</th><th>Feel</th></tr>
          ${n.series.map((p) => `<tr><td>${dayHm(p.t, p.lat)}</td><td>${r1(p.wave)} m</td><td>${r0(p.period)} s</td>
            <td class="${p.gust >= 20 ? 'wx-red' : p.gust >= 15 ? 'wx-orange' : ''}">${kmh(p.wind)}<span class="why"> (${kmh(p.gust)})</span></td><td>${cmf(p.comfort)}</td></tr>`).join('')}</table></div>
          <div class="why">The sea there now, not on your crossing date · every 3 hours</div></details>` : '';
      return `<details class="spot" ${pts.length ? 'open' : ''}><summary><b>${esc(leg.label)}</b> <span class="why">${localDay(leg.start, lat)} – ${localDay(leg.end, lat)}</span><br>${head}</summary>${body}${nowPart}</details>`;
    }).join('');
    return `<h3 style="margin:0 0 4px">At sea <span class="why">· waves along the route</span></h3>
      <p class="hint" style="margin-top:0">How much the sea will move the ship on each crossing. Just look at <b>Feel</b>; waves = typical height of the bigger waves, period = seconds between two waves.</p>
      ${blocks}
      <p class="hint">Feel: ${cmf('calm')} under 1.25 m, hardly noticeable · ${cmf('gentle')} 1.25–2.5 m, light motion · ${cmf('rough')} 2.5–4 m, noticeable rolling, seasick-prone take precautions · ${cmf('very rough')} over 4 m, some outer decks may close. One step worse when the period is 10 s or longer (long, slow waves roll even a big ship). Sky Princess is a 145,000-tonne ship with stabilisers. Source: Open-Meteo marine (ECMWF / Météo-France wave models), typical values ERA5.</p>`;
  }

  function renderWeather() {
    const tabs = $('#wx-tabs'), box = $('#wx-port');
    if (!WX || !WX.ports) { box.innerHTML = '<div class="empty">Weather data will appear after the next update.</div>'; return; }
    // Warnings
    const al = WX.alerts || [];
    const sailing = Date.now() >= new Date(D.trip.start) && Date.now() <= new Date(D.trip.end);
    $('#wx-alerts').innerHTML = al.length ? `<details class="panel wx-alerts" ${sailing && al.some((a) => a.places.some((p) => p !== 'Ship route')) ? 'open' : ''}>
      <summary><b>${al.length} official MET Norway warning${al.length > 1 ? 's' : ''}</b> near the ports or the route right now</summary>
      ${al.map((a) => `<div class="walert ${LEVEL_CLS(a.level)}"><b>${esc(a.event || a.title)}</b> · ${esc(a.area || '')}
        <div class="why">${a.from ? `${localDay(a.from, 65)} ${localHm(a.from, 65)}` : ''}–${a.to ? `${localDay(a.to, 65)} ${localHm(a.to, 65)}` : ''} · affects: ${esc(a.places.join(', '))}</div>
        ${a.description ? `<div class="why">${esc(a.description)}</div>` : ''}</div>`).join('')}
      <p class="hint">Before the cruise these are today's warnings along the route, useful to learn how often it happens. During the cruise they matter for the ship and port days.</p></details>` : '';
    // Port tabs
    if (!wxPort) {
      const upcoming = WX.ports.find((p) => new Date(p.window[1]) > Date.now());
      wxPort = (upcoming || WX.ports[0]).id;
    }
    tabs.innerHTML = WX.ports.map((p) => `<button class="btn ${p.id === wxPort ? 'on' : ''}" data-p="${p.id}">${esc(p.name.replace(' (departure)', '').replace(' (arrival)', ''))} <span class="why">${shortDay(p.window[0].slice(0, 10))}</span></button>`).join('')
      + (WX.sea_legs && WX.sea_legs.length ? `<button class="btn ${wxPort === 'SEA' ? 'on' : ''}" data-p="SEA">At sea <span class="why">waves</span></button>` : '');
    tabs.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { wxPort = b.dataset.p; renderWeather(); }));
    if (wxPort === 'SEA') { box.innerHTML = seaView(); return; }
    const p = WX.ports.find((x) => x.id === wxPort);
    const lat = p.id.startsWith('SOU') ? 50.9 : 65;
    const win = `${localDay(p.window[0], lat)} ${localHm(p.window[0], lat)}–${localHm(p.window[1], lat)}`;
    const c = p.climate;
    const portDay = p.series.length
      ? `<div class="wx-sum">${wxSummaryLine(p.summary)}</div>${adviceChips(p.advice)}${wxTable(p.series, lat)}`
      : `<div class="wx-sum">No forecast for this day yet: MET Norway reaches it about 9 days before (6-hourly), hourly from about 2.5 days before.</div>
         ${c ? `<div class="farbox"><div class="fb"><div class="k">Typical for this day (2011–2025)</div><div class="v">${r0(c.temp_min_mean)}–${r0(c.temp_max_mean)} °C</div><div class="s">feels about ${r0(c.feels_mean)} °C on average · wind ${kmh(c.wind_mean)} km/h, gusts up to ~${kmh(c.gust_p90)} km/h</div></div>
         <div class="fb"><div class="k">Rain or snow</div><div class="v">${Math.round(c.wet_hours_share * 100)}% of hours</div><div class="s">${c.snow_share_of_wet > 0.05 ? `${Math.round(c.snow_share_of_wet * 100)}% of those as snow/sleet` : 'almost always rain, not snow'}</div></div></div>` : ''}`;
    const sea = p.sea ? `<div class="wx-sea"><b>Water shuttle (tender), ${esc(p.sea.label)}:</b> ${p.sea.wave_max != null ? `waves up to ${r1(p.sea.wave_max)} m · sea ${r1(p.sea.sst)} °C · ${esc(p.sea.risk)}` : 'sea forecast not available for this day yet (about 8 days ahead)'}</div>` : '';
    const inPort = Date.now() >= new Date(p.window[0]).getTime() - 2 * 3600e3 && Date.now() <= new Date(p.window[1]).getTime();
    const now = !inPort && p.now_series && p.now_series.length ? `<details class="wx-now"><summary><b>Right now at ${esc(p.name.replace(/ \((departure|arrival)\)/, ''))}:</b> next 48 hours · ${wxSummaryLine(p.now_summary)}</summary>
        ${adviceChips(p.now_advice)}${wxTable(p.now_series.filter((_, i) => i % 2 === 0), lat, true)}<p class="hint">Every 2nd hour shown. This is the weather there now, not on your port day.</p></details>` : '';
    const spots = (p.spots || []).map((s) => {
      const has = s.series && s.series.length;
      const summ = has ? s.summary : s.now_summary;
      const adv = has ? s.advice : s.now_advice;
      const vw = has ? s.view : s.now_view;
      const label = has ? 'On your port day' : 'Right now (next 36 h)';
      return `<details class="spot"><summary><b>${esc(s.name)}</b> <span class="why">${s.ele} m · ${s.kind}</span><br>
          <span class="why">${label}:</span> ${wxSummaryLine(summ)}${vw ? ` · <i>${esc(vw)}</i>` : ''}</summary>
          ${adviceChips(adv)}${wxTable((has ? s.series : (s.now_series || []).filter((_, i) => i % 3 === 0)), lat, true)}</details>`;
    }).join('');
    box.innerHTML = `
      <h3 style="margin:0 0 4px">${esc(p.name)} <span class="why">· in port ${win}</span></h3>
      ${portDay}${sea}${now}
      ${spots ? `<h3 style="margin-top:16px">Hikes and viewpoints <span class="why">(forecast at the summit's altitude)</span></h3>${spots}` : ''}
      <p class="hint">Colours: <span class="wx-cold">feels ≤0 °C</span> · <span class="wx-orange">gusts ≥54 km/h</span> · <span class="wx-red">gusts ≥72 km/h</span> · <span class="wx-wet">rain ≥0.5 mm/h</span>. Arrow = where the wind blows to. Times are local.</p>`;
  }

  // ------------------------------------------------------------ nav highlight
  // The sticky header is taller on a phone (title + wrapped tab row) and changes with the content:
  // measure it, so section jumps and anchor links land just below it instead of under it.
  const headerOffset = () => ($('.topbar') ? $('.topbar').offsetHeight : 64) + 8;
  function trackHeader() {
    const set = () => { document.documentElement.style.scrollPaddingTop = headerOffset() + 'px'; };
    set();
    if (window.ResizeObserver && $('.topbar')) new ResizeObserver(set).observe($('.topbar'));
    window.addEventListener('resize', set);
  }

  // Smooth scroll, then check twice and snap to the exact spot: pictures and charts above the target can
  // finish loading while the page moves, and iOS resizes the screen when its address bar appears.
  // A touch or the wheel in between means the user took over: no correction then.
  function scrollToY(getY) {
    let userMoved = false;
    const stop = () => { userMoved = true; };
    window.addEventListener('touchstart', stop, { once: true, passive: true });
    window.addEventListener('wheel', stop, { once: true, passive: true });
    window.scrollTo({ top: getY(), behavior: 'smooth' });
    for (const ms of [700, 1500]) {
      setTimeout(() => {
        const y = getY();
        if (!userMoved && Math.abs(window.scrollY - y) > 3) window.scrollTo({ top: y, behavior: 'instant' });
      }, ms);
    }
  }
  const yOf = (el) => () => Math.max(0, el.getBoundingClientRect().top + window.scrollY - headerOffset()); // 8 px below the header

  function navSpy() {
    trackHeader();
    document.querySelectorAll('#tabs a').forEach((a) => a.addEventListener('click', (ev) => {
      const el = document.querySelector(a.getAttribute('href'));
      if (!el) return;
      ev.preventDefault();
      if (a.getAttribute('href') === '#check') { const p = $('#check-panel'); if (!p.open) p.open = true; }
      scrollToY(yOf(el));
      history.replaceState(null, '', location.pathname + location.search + a.getAttribute('href'));
    }));
    $('#home').addEventListener('click', (ev) => {
      ev.preventDefault();
      scrollToY(() => 0);
      history.replaceState(null, '', location.pathname + location.search);
    });
    const links = [...document.querySelectorAll('#tabs a')];
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    document.querySelectorAll('main section').forEach((s) => obs.observe(s));
  }

  // ------------------------------------------------------------ basic view
  // One screen, no explanations: tonight's answer with an hour strip, "right now", the next nights and
  // last night. Advanced = the full page. The choice is remembered on this device; Basic is the default.
  let MODE = 'basic';
  try { MODE = localStorage.getItem('aurora-mode') || 'basic'; } catch { /* private mode: stay basic */ }
  const LIVE = {}; // live values the basic view reuses: Kp now, OVATION overhead, cloud drift

  function applyMode() {
    document.body.classList.toggle('basic-mode', MODE === 'basic');
    document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === MODE));
    if (MODE === 'basic') safe(renderBasic);
  }
  function setMode(m, then) {
    MODE = m;
    try { localStorage.setItem('aurora-mode', m); } catch { /* ignore */ }
    applyMode();
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (then) setTimeout(then, 50);
  }
  const basicRefresh = () => { if (MODE === 'basic') safe(renderBasic); };

  // From 06:00 ship time "tonight" is the coming night: the cruise night on board, before the cruise Tromsø (practice).
  // "Tonight" = the night in progress; once its darkness is over (about 04:45), the coming night.
  function basicTonight() {
    const pick = (date) => {
      const cruise = D.nights.find((n) => n.date === date);
      if (cruise) return { n: cruise, practice: false };
      const mc = D.model_check && D.model_check.nights.find((n) => n.date === date && n.spot === 'Tromsø');
      return mc ? { n: mc, practice: true } : null;
    };
    const s = shipDate(Date.now());
    if (s.getUTCHours() < 12) s.setUTCDate(s.getUTCDate() - 1);
    const t = pick(s.toISOString().slice(0, 10));
    const dark = t ? t.n.hourly.filter((h) => h.dark) : [];
    if (t && dark.length && new Date(dark[dark.length - 1].t).getTime() + 3600e3 > Date.now()) return t;
    s.setUTCDate(s.getUTCDate() + 1);
    return pick(s.toISOString().slice(0, 10)) || t;
  }
  const cloudRange = (a, b) => (a === b ? `${a}%` : `${a}–${b}%`);

  // Tonight's answer plus its two parts: is there aurora (activity) and can we see it (clouds).
  function basicVerdict(n) {
    const act = n.factors.activity;
    const kp = n.activity.kp != null ? n.activity.kp.toFixed(1) : '?';
    const aur = act >= 0.5 ? { cls: 'ok', word: '✓ Active' } : act >= 0.25 ? { cls: 'mid', word: 'Borderline' } : { cls: 'bad', word: '✕ Too weak' };
    aur.sub = `Kp ${kp} · ${n.kp_req <= 1 ? `${n.kp_req.toFixed(1)} is enough here` : `about ${n.kp_req.toFixed(0)} needed here`}`;
    if (!metCovers(n)) {
      const p = n.clear.p;
      const sky = { cls: p >= 0.5 ? 'ok' : p >= 0.25 ? 'mid' : 'bad', word: `${pct(p)} clear chance`,
        sub: `hour by hour ${metFromText(n) ? `from ${metFromText(n)}` : 'later'}` };
      return { cls: ratingCls(n.rating), big: pct(n.score), small: 'chance', aur, sky, line: 'Too far ahead for hour-by-hour clouds yet.' };
    }
    const hrs = n.hourly.filter((h) => h.dark && h.cloud_met != null);
    const clearH = hrs.filter((h) => h.cloud_met <= CLEAR_LINE).length;
    const range = (hh) => { const c = hh.map((h) => Math.round(h.cloud_met)); return `${cloudRange(Math.min(...c), Math.max(...c))} cloud`; };
    const win = bestWindow(n);
    let sky;
    if (win) {
      const inWin = hrs.filter((h) => hourStatus(h)[0] === win.label);
      sky = inWin.every((h) => h.cloud_met <= CLEAR_LINE)
        ? { cls: 'ok', word: '✓ Clear gap', sub: `${range(inWin)} ${win.text}` }
        : { cls: 'mid', word: 'Partly cloudy', sub: `${range(inWin)} ${win.text}` };
    } else if (clearH) {
      sky = { cls: 'ok', word: '✓ Clear', sub: `${clearH} of ${hrs.length} dark hours ≤40% cloud` };
    } else {
      sky = { cls: 'bad', word: '✕ Cloudy', sub: hrs.length ? `${range(hrs)} all night` : 'no clear hour' };
    }
    const line = aur.cls === 'ok' && sky.cls === 'bad' ? 'The aurora is there, the clouds hide it.'
      : aur.cls === 'bad' && sky.cls === 'ok' ? 'Clear sky, but the aurora is too weak here.'
      : aur.cls === 'bad' && sky.cls === 'bad' ? 'Weak activity and cloudy.'
      : sky.cls === 'mid' ? 'Gaps in the clouds are possible: worth a look outside.'
      : aur.cls === 'mid' ? 'Activity is borderline: maybe a faint glow low in the north.'
      : 'Aurora and a clear sky line up.';
    const extra = win && USE_TIME_CURVE ? ` Best around ${win.peak}${win.others.length ? ` · also ${win.label === 'GO' ? 'clear' : 'partly clear'} ${win.others.join(', ')}` : ''}.` : '';
    if (win) return { cls: win.label === 'GO' ? 'g' : 'y', big: win.label === 'GO' ? 'GO' : 'MAYBE', small: win.text, aur, sky, line: line + extra };
    return { cls: 'n', big: 'NO', small: aur.cls === 'bad' ? 'too quiet here' : 'cloudy', aur, sky, line };
  }

  // "Changed at 15:30: was GO 21:00–23:00 (5–31% cloud), now NO (85–100% cloud)" from the forecast runs of today.
  function basicChange(date) {
    const runs = (TLOG && TLOG[date]) || [];
    if (runs.length < 2) return '';
    const key = (r) => `${r.verdict}|${r.window || ''}`;
    const now = runs[runs.length - 1];
    let i = runs.length - 2;
    while (i >= 0 && key(runs[i]) === key(now)) i--;
    if (i < 0) return '';
    const was = runs[i], at = runs[i + 1].t;
    if (Date.now() - new Date(at) > 18 * 3600e3) return '';
    const fmt = (r) => `${r.verdict === 'far' ? pct(r.score) + ' chance' : r.verdict}${r.window ? ' ' + r.window : ''}${r.cloud ? ` (${cloudRange(r.cloud[0], r.cloud[1])} cloud)` : ''}`;
    const why = was.cloud && now.cloud && (now.cloud[0] - was.cloud[0] >= 20 || was.cloud[0] - now.cloud[0] >= 20)
      ? (now.cloud[0] > was.cloud[0] ? ' The newest cloud forecast is cloudier.' : ' The newest cloud forecast is clearer.')
      : was.kp != null && now.kp != null && Math.abs(now.kp - was.kp) >= 1 ? ' The activity forecast changed.' : '';
    return `Changed at ${hm(at)}: was ${fmt(was)}, now ${fmt(now)}.${why}`;
  }
  const ratingCls = (r) => ({ GOOD: 'g', FAIR: 'y' }[r] || 'n');

  function basicStrip(n) {
    const now = Date.now();
    const hrs = n.hourly.filter((h) => h.sun < -3);
    const cells = hrs.map((h, i) => {
      const over = new Date(h.t).getTime() + 3600e3 < now;
      const st = !h.dark ? 't' : h.cloud_met == null ? (over ? 'x' : 'u') : ({ GO: 'g', TRY: 'y' }[hourStatus(h)[0]] || 'n');
      const ico = h.cloud_met != null ? `<svg class="bico" viewBox="0 0 16 16" aria-hidden="true">${skyGlyph(Math.round(h.cloud_met))}</svg>` : '<span class="bico"></span>';
      return `<div class="${new Date(h.t).getTime() + 3600e3 < now ? 'past' : ''}" data-i="${i}" role="button" tabindex="0">${ico}<i class="${st}"></i>${h.local.slice(0, 2)}</div>`;
    }).join('');
    return `<div class="bstrip" style="grid-template-columns:repeat(${hrs.length},1fr)">${cells}</div>
      <div class="blegend"><span><b class="g"></b>go</span><span><b class="y"></b>maybe</span><span><b class="n"></b>no</span><span><b class="t"></b>twilight (too bright)</span>${
        hrs.some((h) => h.dark && h.cloud_met == null && new Date(h.t).getTime() + 3600e3 >= now) ? '<span><b class="u"></b>not forecast yet</span>' : ''}</div>
      ${USE_TIME_CURVE ? `<div class="bcurve" style="grid-template-columns:repeat(${hrs.length},1fr)">${hrs.map((h) => `<b style="height:${Math.round(auroraShare(h) * 30)}px"></b>`).join('')}</div>
      <div class="blegend"><span><b class="cv"></b>how often aurora is seen at that hour on clear nights (Kiruna, 10 years)</span></div>` : ''}
      <div class="blegend bsky"><span>Icons = clouds only:</span>${[[20, 'clear ≤40%'], [55, 'broken ≤70%'], [90, 'overcast']].map(([c, t]) =>
        `<span><svg viewBox="0 0 16 16" aria-hidden="true">${skyGlyph(c)}</svg>${t}</span>`).join('')}</div>
      <div class="bwhy" id="b-why"><span class="btap">👆 Tap an hour to see why</span></div>`;
  }

  // Why an hour of the strip has its colour, in one line.
  // Activity numbers stand out as violet chips: outlined = forecast, filled = measured
  const kpChip = (v, kind = 'forecast') => `<span class="kp">Kp ${v.toFixed(1)} ${kind}</span>`;
  const hpChip = (v) => `<span class="kp">Hp30 ${v.toFixed(1)} measured</span>`;
  // One measured value per hour: Hp30 (half-hourly, same 0-9 scale as Kp), NOAA's 3-hour Kp only when Hp30 is missing
  const measChip = (hp, kp, need) => (hp != null ? hpChip(hp) + vsNeed([hp], need) : kp != null ? kpChip(kp, 'measured') + vsNeed([kp], need) : '');
  // Measured Kp of the 3-hour blocks overlapping [a, b): NOAA's observed/estimated values, never its forecast
  const kpObs = (a, b) => {
    const v = ((D.space_weather && D.space_weather.kp_3day) || []).filter((r) => r.kind !== 'predicted'
      && new Date(r.t).getTime() < b && new Date(r.t).getTime() + 3 * 3600e3 > a).map((r) => r.kp);
    return v.length ? Math.max(...v) : null;
  };
  // Measured activity against what this place needs: "enough" or "below"
  const vsNeed = (vals, need) => {
    const v = vals.filter((x) => x != null);
    if (!v.length || need == null) return '';
    return Math.max(...v) >= need ? ` → <b class="vs ok">enough</b> (${need.toFixed(1)} needed here)` : ` → <b class="vs">below</b> the ${need.toFixed(1)} needed here`;
  };
  // the freshest series plus the week kept in latest.json, so older nights still have their values
  const hp30All = () => [...((D && D.space_weather && D.space_weather.hp30_week) || []), ...(HP30 || [])];
  const hp30In = (t0) => {
    const v = hp30All().filter(([ts]) => { const x = new Date(ts).getTime(); return x >= t0 && x < t0 + 3600e3; }).map((q) => q[1]);
    return v.length ? Math.max(...v) : null;
  };

  function basicWhy(h, n) {
    const head = `<b>${h.local}</b> · `;
    const t0 = new Date(h.t).getTime();
    const over = t0 + 3600e3 <= Date.now();
    const hp = over ? hp30In(t0) : null, kpm = over ? kpObs(t0, t0 + 3600e3) : null;
    const meas = hp != null || kpm != null ? ` · ${measChip(hp, kpm, h.kp_req)}` : '';
    if (!h.dark) return `${head}<span class="k t">twilight</span> too bright for faint aurora${meas}`;
    if (h.cloud_met == null) {
      return t0 + 3600e3 < Date.now() ? `${head}this hour is over and no forecast was kept for it${meas}`
        : `${head}not forecast yet: MET Norway's hourly forecast reaches this hour ${metFromText(n) ? `from ${metFromText(n)}` : 'in a later run'}`;
    }
    const lab = hourStatus(h)[0];
    const cloud = `cloud ${Math.round(h.cloud_met)}%`;
    const act = `aurora chance ${pct(h.p_act)} (${kpChip(h.kp)}, needed here ${h.kp_req.toFixed(1)})`;
    const why = lab === 'GO' ? `${cloud} (≤40%) and ${act}`
      : lab === 'TRY' ? (h.cloud_met > CLEAR_LINE ? `${cloud}: more than 40% but ≤70%, gaps likely · ${act}` : `${cloud} (≤40%), but ${act} is only 25–50%`)
      : h.p_act < 0.25 ? `${act}: below 25%` : `${cloud}: more than 70% · ${act}`;
    const word = { GO: ['g', 'go'], TRY: ['y', 'maybe'] }[lab] || ['n', 'no'];
    return `${head}<span class="k ${word[0]}">${word[1]}</span> ${why}${meas}${h.cloud_past ? ' · this hour is over: last forecast made before it' : ''}`;
  }

  // Aurora now: the nearest fresh FMI magnetometer when there is one (up north), else Kp / Hp30 / OVATION.
  function basicAuroraNow() {
    const s = shipNow();
    const [lat, lon] = s.sailing ? [s.lat, s.lon] : [69.65, 18.96];
    const need = kpNeedAt(lat, lon);
    if (sunAltAt(new Date(), lat, lon) > -6) return ['day', 'Daylight', 'too bright to see aurora now; check again after dark'];
    const R = Math.PI / 180;
    const km = (x) => 6371 * Math.acos(Math.min(1, Math.sin(lat * R) * Math.sin(x.lat * R) + Math.cos(lat * R) * Math.cos(x.lat * R) * Math.cos((lon - x.lon) * R)));
    const st = Object.values((MAG && MAG.stations) || {})
      .filter((x) => km(x) <= 300 && Date.now() - new Date(x.t) < 40 * 60e3).sort((a, b) => km(a) - km(b))[0];
    if (st) {
      const dev = st.series ? st.series.dev.filter((v) => v != null) : [];
      const last = dev.length ? dev[dev.length - 1] : 0;
      const low = dev.length ? Math.min(...dev.slice(-30)) : 0;
      if (low <= -200 || st.swing_60 >= 200) return ['strong', 'Strong', `magnetometer ${esc(st.name)} ${low} nT: big display overhead`];
      if (low <= -50 || st.change_10 <= -50) return ['active', 'Active', `magnetometer ${esc(st.name)} ${low} nT: aurora moving now`];
      if (last >= 40 && shipDate(Date.now()).getUTCHours() >= 16) return ['charging', 'Charging ↑', `magnetometer rising (+${last} nT): a substorm is likely later tonight`];
      return ['quiet', 'Quiet', `magnetometer ${esc(st.name)} calm`];
    }
    const hp = HP30 && HP30.length ? HP30[HP30.length - 1][1] : null;
    const lvl = Math.max(hp ?? -9, LIVE.kp ?? -9);
    const txt = lvl > -9 ? `Kp/Hp30 ${lvl.toFixed(1)}, needed here ≈${need.toFixed(1)}` : 'live data loading…';
    if (lvl >= need + 1.5 || (LIVE.ov || 0) >= 20) return ['active', 'Active', txt];
    if (lvl >= need) return ['possible', 'Possible', txt];
    return ['quiet', 'Quiet', txt];
  }

  function basicSky(n) {
    const now = Date.now();
    const drift = LIVE.from ? ` · new clouds come from the ${LIVE.from}` : '';
    const h0 = n && n.hourly.find((h) => Math.abs(new Date(h.t) - now) <= 1800e3 && h.cloud_met != null);
    if (!h0) {
      // daytime: tonight's sky in one line
      const dark = n ? n.hourly.filter((h) => h.dark && h.cloud_met != null) : [];
      if (!dark.length) return ['', 'Daytime', `no cloud forecast for tonight yet${drift}`];
      const clear = dark.filter((h) => h.cloud_met <= CLEAR_LINE);
      return [clear.length ? 'ok2' : '', clear.length ? `Tonight: clear from ${clear[0].local}` : 'Tonight: cloudy',
        `${clear.length} of ${dark.length} dark hours clear (MET)${drift}`];
    }
    const c = Math.round(h0.cloud_met);
    const next = n.hourly.filter((h) => new Date(h.t) > now && new Date(h.t) - now <= 4 * 3600e3 && h.cloud_met != null);
    const clearing = c > CLEAR_LINE && next.find((h) => h.cloud_met <= CLEAR_LINE);
    const closing = c <= CLEAR_LINE && next.find((h) => h.cloud_met > 70);
    const big = (c <= CLEAR_LINE ? 'Clear' : c <= 70 ? 'Partly cloudy' : 'Cloudy')
      + (clearing ? ` → clearing ~${clearing.local}` : closing ? ` → clouding over ~${closing.local}` : '');
    return [c <= CLEAR_LINE ? 'ok2' : '', big, `forecast cloud ${c}% (MET)${drift}`];
  }

  function basicShip() {
    const s = shipNow();
    if (!s.sailing) {
      const days = Math.ceil((new Date(D.trip.start) - Date.now()) / 864e5);
      return [days > 0 ? `${days} days to go` : 'Not sailing', 'until then "tonight" is Tromsø, for practice'];
    }
    const now = Date.now();
    const port = D.trip.stops.find((st) => st.arrive && st.depart && new Date(st.arrive) <= now && now <= new Date(st.depart));
    if (port) return [esc(port.name), `in port until ${hm(port.depart)}`];
    const next = D.trip.stops.find((st) => st.arrive && new Date(st.arrive) > now);
    return ['At sea', next ? `next: ${esc(next.name)}, ${dayLabel(next.arrive.slice(0, 10))} ${hm(next.arrive)}` : ''];
  }


  // Hourly weather where you are (weather.json "here"): Tromsø before the cruise, the ship's position on board.
  function basicWeather() {
    const h = WX && WX.here;
    if (!h || !h.series || !h.series.length) return '';
    const rows = h.series.filter((e) => new Date(e.t).getTime() >= Date.now() - 3600e3).filter((_, i) => i % 2 === 0);
    if (!rows.length) return '';
    const places = [...new Set(h.series.map((e) => e.place))];
    return `<div class="b-card"><div class="b-k">Weather here · next 24 hours</div>
      <div class="bplace-s" style="margin-top:4px">${h.sailing ? `where the ship will be each hour: ${esc(places.join(' → '))}` : 'Tromsø, the practice spot until the cruise starts'}</div>
      <div class="wx-sum">${wxSummaryLine(h.summary)}</div>${adviceChips(h.advice)}${wxTable(rows, 65)}
      <p class="hint" style="margin:6px 0 0">Every 2nd hour shown · MET Norway · updated with each forecast run.</p></div>`;
  }

  // Last night, put together on the page from what is already loaded (camera AI log, Hp30, magnetometer,
  // the evening's forecast, MET's cloud analysis when it has arrived), so it is there as soon as the night ends.
  function basicPrevNight(t) {
    if (!t) return null;
    const d0 = new Date(t.n.date + 'T12:00:00Z');
    d0.setUTCDate(d0.getUTCDate() - 1);
    const date = d0.toISOString().slice(0, 10);
    const cruiseN = !t.practice ? D.nights.find((n) => n.date === date) : null;
    const [lat, lon, place] = cruiseN ? [cruiseN.lat, cruiseN.lon, shortPlace(cruiseN.place)] : [69.65, 18.96, 'Tromsø'];
    const R = Math.PI / 180;
    const km = (la, lo) => 6371 * Math.acos(Math.min(1, Math.sin(lat * R) * Math.sin(la * R) + Math.cos(lat * R) * Math.cos(la * R) * Math.cos((lon - lo) * R)));
    const sky = (SKY && SKY.nights && SKY.nights[date]) || {};
    const cams = CAMS.map(([id, name, la, lo]) => ({ name: name.replace(' camera', ''), km: km(la, lo), hrs: sky[id] }))
      .filter((c) => c.hrs && c.km <= 300).sort((a, b) => a.km - b.km);
    const here = cams.find((c) => c.km <= 60) || null;
    const words = (c) => Object.keys(c.hrs).sort(hourOrder).map((h) => [h, camWord(c.hrs[h])]);
    const auroraH = (c) => words(c).filter(([, w]) => w.includes('aurora')).map(([h]) => h);
    const hereA = here ? auroraH(here) : [];
    const hereClear = here ? words(here).filter(([, w]) => w === 'clear' || w.includes('aurora')).map(([h]) => h) : [];
    const hereCloudy = here ? words(here).filter(([, w]) => w === 'cloudy').map(([h]) => h) : [];
    const nearby = cams.filter((c) => c !== here && auroraH(c).length);
    const span = (hh) => hh.reduce((g, h) => ((g.length && (+g[g.length - 1][g[g.length - 1].length - 1] + 1) % 24 === +h)
      ? (g[g.length - 1].push(h), g) : [...g, [h]]), []).map((x) => `${x[0]}–${pad((+x[x.length - 1] + 1) % 24)}`).join(', ');
    // activity during that night (18:00-06:00 ship time)
    const t0 = new Date(date + 'T16:00:00Z').getTime(), t1 = t0 + 12 * 3600e3;
    const hp = hp30All().filter(([ts]) => { const x = new Date(ts).getTime(); return x >= t0 && x < t1; }).map((q) => q[1]);
    const hpMax = hp.length ? Math.max(...hp) : null;
    const kpMax = kpObs(t0, t1);
    let magMin = null;
    for (const st of Object.values((MAG && MAG.stations) || {})) {
      if (!st.series || km(st.lat, st.lon) > 300) continue;
      const s0 = new Date(st.series.t0).getTime(), step = st.series.step_min * 60e3;
      st.series.dev.forEach((v, i) => { const x = s0 + i * step; if (v != null && x >= t0 && x < t1 && (magMin == null || v < magMin)) magMin = v; });
    }
    const top = hpMax != null ? ['Hp30', hpMax] : kpMax != null ? ['Kp', kpMax] : null;
    const act = [top ? `${top[1] >= 2 ? 'active' : 'quiet'} night (${top[0]} max ${top[1].toFixed(1)})` : '', magMin != null && magMin <= -50 ? `magnetometer ${magMin} nT` : '']
      .filter(Boolean).join(', ');
    // MET's analysis of the clouds afterwards
    const obs = cruiseN ? LOG && LOG.nights && LOG.nights[date] && LOG.nights[date].observed
      : VER && VER.nights && VER.nights[`${date}|Tromsø`] && VER.nights[`${date}|Tromsø`].observed;
    const metClear = obs ? obs.clear_dark : null;
    const metDark = obs && obs.hours ? obs.hours.filter((r) => r[1] <= -12 && r[2] != null) : [];
    const metClearH = metDark.filter((r) => r[2] <= CLEAR_LINE).map((r) => r[0].slice(0, 2));
    const metCloudyH = metDark.filter((r) => r[2] > CLEAR_LINE).map((r) => r[0].slice(0, 2));
    // at sea there is no place name to put in a sentence: talk about the ship instead
    const atSea = /^At sea/.test(place);
    const skyAt = atSea ? 'the sky over the ship' : place;
    // "clear" like everywhere on the page: at least 2 consecutive clear hours (a single clear hour is not a gap)
    const gap = (hh) => hh.some((h, i) => i > 0 && (+hh[i - 1].slice(0, 2) + 1) % 24 === +h.slice(0, 2));
    const clearHere = here ? gap(hereClear) : metClear ? gap(metClear) : null;
    // tiles
    const aur = hereA.length ? { cls: 'ok', word: '✓ Overhead', sub: `${here.name} camera: aurora ${span(hereA)}${act ? ' · ' + act : ''}` }
      : nearby.length ? { cls: 'mid', word: 'Seen nearby', sub: `${act ? act + ' · ' : ''}cameras: ${nearby.map((c) => `${c.name} ${span(auroraH(c))}`).join(', ')}` }
      : cams.length ? { cls: 'bad', word: 'None seen', sub: act || 'cameras saw no aurora' }
      : { cls: 'mid', word: act ? (top && top[1] >= 2 ? 'Active' : 'Quiet') : 'No data', sub: act || 'no camera nearby' };
    const skyT = here
      ? (hereCloudy.length && !hereClear.length ? { cls: 'bad', word: '✕ Cloudy', sub: `camera: cloudy ${span(hereCloudy)}` }
        : hereClear.length && !hereCloudy.length ? { cls: 'ok', word: '✓ Clear', sub: `camera: clear ${span(hereClear)}` }
        : { cls: 'mid', word: 'Partly clear', sub: `camera: cloudy ${span(hereCloudy)}, clear ${span(hereClear)}` })
      : metDark.length ? (!metClearH.length ? { cls: 'bad', word: '✕ Cloudy', sub: `MET analysis: cloudy ${span(metCloudyH)}` }
        : !metCloudyH.length ? { cls: 'ok', word: '✓ Clear', sub: `MET analysis: clear ${span(metClearH)}` }
        : { cls: 'mid', word: gap(metClearH) ? 'Partly clear' : 'Mostly cloudy', sub: `MET analysis: cloudy ${span(metCloudyH)}, clear ${span(metClearH)}` })
      : { cls: 'mid', word: 'Later', sub: "MET's cloud analysis arrives in the morning" };
    // verdict
    // A camera here sees the whole sky down to the horizon: if it saw no aurora, nothing was visible here.
    // Without a camera nobody can confirm it: clear hours + enough measured activity for this latitude = "Maybe".
    const need = obs && obs.kp_needed != null ? obs.kp_needed : null;
    const strong = top != null && need != null && top[1] >= need;
    const vs = top && need != null ? `${top[0]} max ${top[1].toFixed(1)}, ${need.toFixed(1)} needed here` : '';
    const big = hereA.length ? ['g', 'Seen', `aurora ${span(hereA)}`]
      : here ? ['n', 'Not seen', 'here']
      : clearHere == null ? ['u', 'Not known yet', "MET's cloud analysis comes later"]
      : !clearHere ? ['n', 'Not seen', 'cloudy']
      : nearby.length ? ['y', 'Maybe', 'aurora nearby, clear here']
      : strong ? ['y', 'Maybe', 'clear and strong enough']
      : ['n', 'Not seen', 'too quiet'];
    const names = nearby.map((c) => c.name).join(' and ');
    const clearTxt = metClear && metClear.length ? `clear ${span(metClear.map((h) => h.slice(0, 2)))}` : 'clear hours';
    const line = hereA.length ? `Aurora was out over ${place} and the camera saw it: hope you did too!`
      : nearby.length && here && hereClear.length ? `Aurora was out over ${names}, but the ${here.name} camera saw none, not even in its clear hour${hereClear.length > 1 ? 's' : ''} (${span(hereClear)}).`
      : nearby.length && clearHere === false ? `Aurora was out over ${names}, but ${skyAt} was cloudy.`
      : nearby.length && clearHere ? `Aurora was out nearby (${names}) and the sky here had clear hours: low in the north it may have been visible.`
      : here ? (clearHere ? 'Clear sky, but no aurora on the camera.' : 'Cloudy, and no aurora on the camera.')
      : clearHere == null ? 'No camera here; the cloud analysis is not in yet.'
      : !clearHere ? `No clear dark hours${vs ? ` (${vs})` : ''}: nothing to see.`
      : strong ? `No camera here to confirm it, but it was ${clearTxt} and activity was strong enough (${vs}): aurora was possible.`
      : `It was ${clearTxt}, but activity was too weak for this latitude${vs ? ` (${vs})` : ''}.`;
    // the evening's forecast and whether it was right about the clouds
    const runs = (TLOG && TLOG[date]) || [];
    const ev = runs.filter((r) => new Date(r.t) < new Date(date + 'T19:00:00Z')).pop() || runs[0];
    let fc = '';
    if (ev) {
      const said = ev.verdict === 'far' ? `${pct(ev.score)} chance` : `${ev.verdict}${ev.window ? ' ' + ev.window : ''}${ev.cloud ? ` (${cloudRange(ev.cloud[0], ev.cloud[1])} cloud)` : ''}`;
      const right = clearHere == null || ev.verdict === 'far' ? '' : ((ev.verdict === 'NO') === !clearHere ? ' · <span class="ok">✓ right</span>' : ' · ✕ wrong about the clouds');
      fc = `Forecast that evening: ${esc(said)}${right}`;
    }
    const alerts = LAST && LAST.date === date && LAST.alerts && LAST.alerts.length ? LAST.alerts.map((a) => `${a.kind} ${a.last}`).join(', ') : '';
    // one hour strip for the place itself: its camera when there is one, else MET's cloud analysis
    const HOURS = ['19', '20', '21', '22', '23', '00', '01', '02', '03', '04', '05'];
    const cls = { aurora: 'a', 'possible aurora': 'a', clear: 'cl', cloudy: 'c', 'bright (moon)': 'm', mixed: 'c' };
    const metAt = {}, sunAt = {}, needAt = {};
    for (const r of (obs && obs.hours) || []) { metAt[r[0].slice(0, 2)] = r[2]; sunAt[r[0].slice(0, 2)] = r[1]; needAt[r[0].slice(0, 2)] = r[4]; }
    const hourInfo = HOURS.map((hh) => {
      const t = new Date(`${+hh >= 12 ? date : new Date(new Date(date + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10)}T${hh}:00:00Z`).getTime() - OFFSET_H * 3600e3;
      let mag = null;
      for (const st of Object.values((MAG && MAG.stations) || {})) {
        if (!st.series || km(st.lat, st.lon) > 300) continue;
        const s0 = new Date(st.series.t0).getTime(), step = st.series.step_min * 60e3;
        st.series.dev.forEach((v, i) => { const x = s0 + i * step; if (v != null && x >= t && x < t + 3600e3 && (mag == null || v < mag)) mag = v; });
      }
      return { hh, cloud: metAt[hh] ?? null, kp: kpObs(t, t + 3600e3), hp: hp30In(t), need: needAt[hh] ?? need ?? kpNeedAt(lat, lon), mag };
    });
    const camTxt = (c, v) => (v ? `${esc(c.name)} camera: <b>${camWord(v)}</b> (AI: aurora ${v.aurora}%, clear ${v.clear}%, cloud ${v.cloudy}%)` : `${esc(c.name)} camera: no picture`);
    const others = cams.filter((c) => c !== here);
    const why = (i) => {
      const h = hourInfo[i];
      const near = others.filter((c) => c.hrs[h.hh]).map((c) => `${esc(c.name)} ${camWord(c.hrs[h.hh])}`).join(', ');
      const parts = [here ? camTxt(here, here.hrs[h.hh]) : '', h.cloud != null ? `MET analysis ${atSea ? "at the ship's position" : 'for ' + esc(place)}: cloud ${Math.round(h.cloud)}%` : '',
        near ? `cameras nearby: ${near}` : '',
        measChip(h.hp, h.kp, h.need), h.mag != null ? `magnetometer ${h.mag} nT` : ''].filter(Boolean);
      return `<b>${h.hh}:00</b> · ${parts.join(' · ')}`;
    };
    // icon: MET's analysis for this place; without it, what the camera here saw
    const icon = (i) => {
      const h = hourInfo[i];
      const v = here && here.hrs[h.hh];
      const cl = h.cloud != null ? Math.round(h.cloud) : v ? (camWord(v) === 'cloudy' ? 90 : camWord(v) === 'clear' || camWord(v).includes('aurora') ? 10 : null) : null;
      return cl != null ? `<svg class="bico" viewBox="0 0 16 16" aria-hidden="true">${skyGlyph(cl)}</svg>` : '<span class="bico"></span>';
    };
    // bar colour: the camera here; without a camera, MET's clouds (twilight = too bright)
    const bar = (hh) => {
      if (here) return here.hrs[hh] ? cls[camWord(here.hrs[hh])] : 'na';
      if (metAt[hh] == null) return 'na';
      return sunAt[hh] > -12 ? 'm' : metAt[hh] <= CLEAR_LINE ? 'cl' : 'c';
    };
    const hasStrip = !!here || Object.keys(metAt).length > 0;
    const strips = hasStrip ? `<div class="rowlab">${esc(here ? `${here.name} camera, hour by hour` : `${atSea ? "At the ship's position" : place}: clouds afterwards (MET analysis), hour by hour`)}</div>
      <div class="pstrip" data-row="0">${HOURS.map((h, i) => `<div data-i="${i}" role="button" tabindex="0">${icon(i)}<i class="${bar(h)}"></i>${h}</div>`).join('')}</div>
      <div class="bwhy" id="b-lastwhy"><span class="btap">👆 Tap an hour to see what happened</span></div>
      <div class="blegend">${here ? '<span><b class="a"></b>aurora</span>' : ''}<span><b class="cl"></b>clear${here ? ', no aurora' : ' (≤40%)'}</span><span><b class="c"></b>cloudy</span><span><b class="m"></b>${here ? 'bright (moon / twilight)' : 'twilight (too bright)'}</span></div>` : '';
    return { date, place, practice: t.practice, skyHead: atSea ? 'Sky at the ship' : `Sky in ${place}`, big, aur, sky: skyT, line, fc, alerts, strips, why: (i) => why(i), short: `${big[1]}${big[0] === 'n' ? ' here' : ': ' + big[2]} · ${line}` };
  }

  function prevNightCard(P) {
    return `<div class="b-card" id="b-last"><div class="b-k">Last night · ${dayLabel(P.date)} <span class="btag">MORNING</span></div>
      <div class="bplace">📍 ${esc(P.place)}</div>
      <div class="bplace-s">${P.practice ? 'practice spot until the cruise starts' : 'where the ship was that night, from the published itinerary'}</div>
      <div class="b-big"><span class="b-sym ${P.big[0]}">${{ g: '✓', y: '?', n: '✕', u: '…' }[P.big[0]]}</span><span class="b-verdict">${esc(P.big[1])} <small>${esc(P.big[2])}</small></span></div>
      <div class="bfx">${[['Aurora', P.aur], [P.skyHead, P.sky]].map(([k, f]) =>
        `<div class="bf ${f.cls}"><div class="h">${esc(k)}</div><div class="w">${esc(f.word)}</div><div class="s">${esc(f.sub)}</div></div>`).join('')}</div>
      <div class="bline">${esc(P.line)}</div>
      ${P.fc ? `<div class="b-sub">${P.fc}${P.alerts ? ` · alerts: ${esc(P.alerts)}` : ''}</div>` : ''}
      ${P.strips}
    </div>`;
  }

  function renderBasic() {
    const el = $('#basic');
    if (!el || !D) return;
    const t = basicTonight();
    const s = shipNow();
    let tonight = `<div class="b-card"><div class="b-k">Tonight</div><div class="b-sub" style="margin-top:6px">${
      Date.now() > new Date(D.trip.end) ? 'The cruise is over. The last nights are under Advanced.' : 'No forecast for tonight yet.'}</div></div>`;
    if (t) {
      const v = basicVerdict(t.n);
      tonight = `<div class="b-card">
        <div class="b-k">Tonight · ${dayLabel(t.n.date)}</div>
        <div class="bplace">📍 ${esc(t.practice ? 'Tromsø' : shortPlace(t.n.place))}</div>
        <div class="bplace-s">${t.practice ? 'practice spot until the cruise starts' : "where the ship is tonight, from the published itinerary (not live GPS)"}</div>
        <div class="b-big"><span class="b-dot ${v.cls}"></span><span class="b-verdict">${v.big} <small>${esc(v.small)}</small></span></div>
        <div class="bfx">${[['Aurora', v.aur], ['Sky', v.sky]].map(([k, f]) =>
          `<div class="bf ${f.cls}"><div class="h">${k}</div><div class="w">${esc(f.word)}</div><div class="s">${esc(f.sub)}</div></div>`).join('')}</div>
        <div class="bline">${esc(v.line)}</div>
        ${basicChange(t.n.date) ? `<div class="bchange">↻ ${esc(basicChange(t.n.date))}</div>` : ''}
        <div class="b-sub">${esc(darkText(t.n))}</div>
        ${basicStrip(t.n)}</div>`;
    }
    const [acls, aword, atxt] = basicAuroraNow();
    const [scls, sword, stxt] = basicSky(t && t.n);
    const [shipword, shiptxt] = basicShip();
    const tile = (k, v, cls, txt) => `<div class="nt"><div class="b-k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${txt}</div></div>`;
    const upcoming = D.nights.filter((n) => !isPast(n) && !(t && !t.practice && n.date === t.n.date));
    // Last night: a full card above tonight in the morning (until noon), one line further down later in the day
    const P = basicPrevNight(t);
    const morning = shipDate(Date.now()).getUTCHours() < 12 && !!t && t.n.date === shipDate(Date.now()).toISOString().slice(0, 10);
    el.innerHTML = `${P && morning ? prevNightCard(P) : ''}${tonight}
      <div class="b-card"><div class="b-k">Right now · ${hm(Date.now())}</div>
        <div class="now3">${tile('Aurora now', aword, 'a-' + acls, atxt)}${tile('Sky here', sword, scls, stxt)}${tile(s.sailing ? 'Ship' : 'Cruise', shipword, '', shiptxt)}</div></div>
      <div class="b-card"><div class="b-k">${s.sailing ? 'Next nights' : 'Cruise nights'} · <span class="btap">tap one for the details</span></div>
        <div class="bnights">${upcoming.map((n) => `<button class="bnc" data-date="${n.date}"><div class="d">${dayLabel(n.date).slice(0, 6)}</div>
          <div class="p">${esc(shortPlace(n.place)).replace(/^At sea · /, 'at sea · ')}</div><div class="v">${pct(n.score)}</div>
          <div class="r" style="color:${RATING_HEX[n.rating]}">${n.rating}</div><div class="bar" style="background:${RATING_HEX[n.rating]}"></div></button>`).join('')}</div></div>
      ${P && !morning ? `<div class="b-card"><div class="b-k">Last night · ${dayLabel(P.date)} · ${esc(P.place)}</div><div class="blast">${esc(P.short)}</div>${P.fc ? `<div class="b-sub" style="margin-top:4px">${P.fc}</div>` : ''}</div>` : ''}
      ${basicWeather()}
      <div class="balerts">🔔 ${s.sailing ? "You'll get a notification when it's time to go out." : 'Test alerts are on until the cruise starts.'}</div>
      <details class="bhow"><summary>How is this decided?</summary>
        <p><b>Where</b>: before the cruise, "tonight" is Tromsø, for practice. On board it follows the ship's planned position hour by hour, from Princess' published itinerary: the port while docked, the route between ports at sea. It is not live GPS, so a change of course or schedule is not known here.</p>
        <p><b>Tonight, hour by hour</b> (MET Norway's local forecast, about 2.5 days ahead):
          <span class="k g">go</span> dark, cloud ≤40% and aurora chance ≥50% ·
          <span class="k y">maybe</span> cloud ≤70% and aurora chance ≥25% ·
          <span class="k n">no</span> otherwise ·
          <span class="k t">twilight</span> sun 3–12° below the horizon, too bright for faint aurora.
          The two tiles under the answer split it in two: <b>Aurora</b> (is the activity strong enough here: active, borderline, too weak) and <b>Sky</b> (clear gap, partly cloudy, cloudy).
          The small icon above each hour shows the clouds only (moon = clear, moon with cloud = broken, cloud = overcast); the colour combines clouds and aurora activity.
          Tap an hour in the strip to see its numbers. The big answer is the green stretch (yellow if there is none) with the best aurora hours: on clear nights aurora is seen most often around midnight (about 85% of clear nights at 23–00 h, 60% at 20 h; Kiruna all-sky camera statistics, the small green bars under the strip). Aurora chance = how likely the forecast activity (Kp) reaches the level needed at that latitude.
          Nights further ahead show the overall chance instead, until MET's forecast reaches them.</p>
        <p><b>Aurora now</b> comes from the nearest magnetometer when there is one (Tromsø and Alta area):
          <b>Quiet</b> = calm field ·
          <b>Charging ↑</b> = in the evening the field has risen 40+ nT above its quiet level: energy is building up, a substorm often follows later in the night (in last season's data 86% of such evenings, usually 01–03 h) ·
          <b>Active</b> = it dropped 50+ nT within half an hour: aurora is moving overhead now ·
          <b>Strong</b> = 200+ nT: a big display.
          Where there is no magnetometer (further south): <b>Active</b> when Kp/Hp30 is 1.5 above the level needed here or the NOAA model shows 20%+ overhead, <b>Possible</b> when it just reaches the level.
          <b>Daylight</b> = the sun is less than 6° below the horizon.</p>
        <p><b>Sky here</b>: MET's cloud forecast for this hour: clear ≤40%, partly cloudy ≤70%, cloudy above. "Clearing" or "clouding over" = a change within the next 4 hours. In the daytime it sums up tonight's dark hours. "New clouds come from the north-west" = the wind at about 3 km height, which moves the clouds: look that way on the satellite picture (Advanced › Live) to see what is coming.</p>
        <p><b>Nights</b>: overall chance = aurora × clear sky × darkness × moon and lights. GOOD 40%+, FAIR 25%+, LOW 10%+, POOR below (same colours as in the advanced view).</p>
      </details>
      <a href="#" class="badv" id="b-adv">Advanced view: all numbers, charts and explanations →</a>`;
    if (t) {
      const hrs = t.n.hourly.filter((h) => h.sun < -3);
      el.querySelectorAll('.bstrip > div').forEach((c) => c.addEventListener('click', () => {
        el.querySelectorAll('.bstrip > div').forEach((x) => x.classList.toggle('sel', x === c));
        $('#b-why').innerHTML = basicWhy(hrs[+c.dataset.i], t.n);
      }));
    }
    el.querySelectorAll('.bnc').forEach((b) => b.addEventListener('click', () => setMode('advanced', () => {
      selected = b.dataset.date;
      renderCards();
      renderDetail();
      scrollToY(yOf($('#night-detail')));
    })));
    $('#b-adv').addEventListener('click', (ev) => { ev.preventDefault(); setMode('advanced'); });
    if (P && morning) {
      el.querySelectorAll('#b-last .pstrip > div').forEach((c) => c.addEventListener('click', () => {
        el.querySelectorAll('#b-last .pstrip > div').forEach((x) => x.classList.toggle('sel', x === c));
        $('#b-lastwhy').innerHTML = P.why(+c.dataset.i);
      }));
    }
  }

  // ------------------------------------------------------------ boot
  const safe = (fn) => { try { fn(); } catch (e) { console.error(e); } };

  async function boot() {
    try {
      let hpFile;
      [D, HIST, VER, hpFile, WX, SKY, MAG] = await Promise.all([getJSON('data/latest.json'), getJSON('data/history.json').catch(() => null),
        getJSON('data/verification.json').catch(() => null), getJSON('data/hp30.json').catch(() => null),
        getJSON('data/weather.json').catch(() => null), getJSON('data/sky_obs.json').catch(() => null), getJSON('data/mag.json').catch(() => null)]);
      [LOG, LAST, TLOG] = await Promise.all([getJSON('data/cruise_log.json').catch(() => null), getJSON('data/last_night.json').catch(() => null),
        getJSON('data/tonight_log.json').catch(() => null)]);
      HP30 = newerHp30((D.space_weather && D.space_weather.hp30) || [], hpFile && hpFile.series);
    } catch (e) {
      $('#fresh').innerHTML = '<span class="dot bad"></span>data unavailable';
      $('#hero').innerHTML = `<div class="empty">Could not load the forecast data (${esc(e.message)}). Check the connection and reload.</div>`;
      return;
    }
    // Deep link from notifications: ?night=YYYY-MM-DD opens that night's detail.
    const wanted = new URLSearchParams(location.search).get('night');
    const linked = D.nights.some((n) => n.date === wanted) ? wanted : null;
    selected = linked || tonightDate() || D.nights.reduce((b, x) => (x.score > b.score ? x : b), D.nights[0]).date;
    [renderFresh, renderPhase, renderHero, renderLastNight, renderCards, renderDetail, renderTrend, renderKp27, renderKp3, renderSwpcText, renderLive, renderSat, renderCams, renderMag, renderMap, markItineraryToday, renderItinNow, renderWeather, navSpy].forEach(safe);
    startLiveRefresh();
    document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    applyMode();
    // The check panel is collapsed: build it on first open so its chart can measure its width.
    $('#check-panel').addEventListener('toggle', () => { if ($('#check-panel').open) safe(renderCheck); });
    if (linked) {
      // instant jump (the CSS smooth scrolling would animate and can be interrupted); repeat once late content has loaded
      const jump = () => window.scrollTo({ top: $('#night-detail').getBoundingClientRect().top + window.scrollY - headerOffset(), behavior: 'instant' });
      setTimeout(jump, 250);
      setTimeout(jump, 1200);
    }

    let lastW = window.innerWidth, timer = null;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (Math.abs(window.innerWidth - lastW) < 30) return;
        lastW = window.innerWidth;
        const n = D.nights.find((x) => x.date === selected);
        [() => drawHourly(n, $('#hourly-chart')), () => drawHourly(checkNight(), $('#check-chart')),
          () => HIST && drawTrend(HIST.runs), drawKp27, drawKp3, drawBz, drawMagChart].forEach(safe);
      }, 200);
    });
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
})();
