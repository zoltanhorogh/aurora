(() => {
  'use strict';

  const OFFSET_H = 2; // ship time = CEST (UTC+2)
  const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];
  const RATING = { GOOD: ['good', '▲'], FAIR: ['warn', '◆'], LOW: ['serious', '▼'], POOR: ['critical', '✕'] };
  const RATING_HEX = { GOOD: '#0ca30c', FAIR: '#fab219', LOW: '#ec835a', POOR: '#d03b3b' };
  let KEY_NIGHTS = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']; // the Arctic nights; from latest.json once loaded
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
  const kpNeedText = (k) => (k < 1 ? `even quiet activity is enough here (Kp ${k.toFixed(1)} needed)` : `needs about Kp ${k.toFixed(0)}+ here`);
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
  let MAG = null;    // mag.json (FMI magnetometer swing, several times an hour after dark)
  let SHOCK = null;  // shock.json (jumps of the solar wind at the L1 satellite: a CME arriving)
  let selected = null;
  let bzPts = null;  // loaded on demand

  // Reloading keeps the place you were at (this tab only). A link's #section or ?night= (from a notification) is used
  // once and then taken out of the address: otherwise every reload jumped there again, and too early, while the
  // content above it was still loading (Safari, 1 Oct 2026: "always jumps to the nights").
  try { history.scrollRestoration = 'manual'; } catch { /* old browsers */ }
  const LINK = (() => {
    const q = new URLSearchParams(location.search);
    const link = { night: q.get('night'), hash: location.hash.length > 1 ? location.hash : '' };
    if (link.night || link.hash) {
      q.delete('night');
      try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '')); } catch { /* ignore */ }
    }
    return link;
  })();
  const SCROLL_KEY = 'aurora-scroll';
  const saveScroll = () => { try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ y: Math.round(window.scrollY), mode: MODE })); } catch { /* private mode */ } };

  async function getJSON(url) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' → ' + r.status);
    return r.json();
  }

  // The cruise night shown as "tonight" (null before and after the cruise nights): the same night as in the
  // basic view, i.e. the night in progress until its darkness ends, then the coming night.
  function tonightDate() {
    const t = basicTonight();
    return t && t.n && !t.practice ? t.date : null;
  }

  function shipNow() {
    const now = Date.now();
    let best = null, bestDt = Infinity;
    for (const r of D.route_hourly) {
      const dt = Math.abs(new Date(r[0]) - now);
      if (dt < bestDt) { bestDt = dt; best = r; }
    }
    const sailing = now >= new Date(D.trip.start) && now <= new Date(D.trip.end);
    // practice (Tromsø) until the first cruise night becomes "tonight", then the ship (Southampton on the
    // morning of departure) until the arrival, then the cruise is over
    const phase = now > new Date(D.trip.end) ? 'over' : now >= new Date(D.trip.cruise_day_from || D.trip.start) ? 'cruise' : 'practice';
    return { lat: best[1], lon: best[2], state: best[3], place: best[4], sailing, phase, aboard: phase === 'cruise' };
  }
  // The position the live numbers refer to, and how to name it.
  const herePos = () => {
    const s = shipNow();
    return s.aboard ? [s.lat, s.lon, 'at the ship'] : [69.65, 18.96, s.phase === 'over' ? 'Tromsø (the cruise is over)' : 'Tromsø (not sailing yet)'];
  };

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
    // Phase starts, each tied to when a forecast reaches the nights that matter (from the trip, not fixed dates)
    const before = (date, days) => new Date(new Date(date + 'T16:00:00Z').getTime() - days * 864e5).toISOString();
    const steps = [
      ['Trend', '27-day outlook + climate', null],
      ['Early weather', 'ensemble clouds gain weight', before(KEY_NIGHTS[0], 16)], // global models reach the first Arctic night (16 days)
      ['Sharpening', 'cloud forecasts become useful', before(KEY_NIGHTS[0], 9)], // MET's 9-day forecast reaches Tromsø and Alta
      ['Final days', 'NOAA 3-day Kp, CME models', new Date(start - 3 * 864e5).toISOString()], // the 3 days before departure
      ['On board', 'live nowcast + alerts', D.trip.start],
    ];
    const idx = now > end ? 5 : steps.reduce((k, s, i) => (s[2] && now >= new Date(s[2]).getTime() ? i : k), 0);
    const when = (i) => (i === 0 ? `until ${shortDay(shipDate(steps[1][2]).toISOString().slice(0, 10))}`
      : `from ${shortDay(shipDate(steps[i][2]).toISOString().slice(0, 10))}${i === 4 ? ` ${hm(steps[i][2])} ship time` : ''}`);
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
      const day = (t) => new Date(shipDate(t).toISOString().slice(0, 10)).getTime(); // calendar day, ship time
      big = `Day ${Math.round((day(now) - day(start)) / 864e5) + 1} <span class="hint" style="font-size:14px;font-weight:400">of ${Math.round((day(end) - day(start)) / 864e5) + 1} · ${esc(shortPlace(shipNow().place))}</span>`;
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
  // A night is over when its darkness ends at its place (the ship's position): the same rule everywhere on the
  // page and in the robot's files. Then its card shows what happened instead of an old forecast.
  const nightEnd = (n) => {
    const e = eventAt(n, 'dark_end');
    if (e) return new Date(e.t).getTime();
    const dark = n.hourly.filter((h) => h.dark);
    return dark.length ? new Date(dark[dark.length - 1].t).getTime() + 3600e3 : new Date(n.date + 'T04:00:00Z').getTime() + 864e5;
  };
  const isPast = (n) => Date.now() >= nightEnd(n);
  const CAMS = [['tromso', 'Tromsø camera', 69.65, 18.96], ['skibotn', 'Skibotn camera', 69.35, 20.36], ['kiruna', 'Kiruna camera', 67.84, 20.41]];
  // Whole hours as ranges, gaps kept: ["21:00", "22:00", "00:00"] or ["21", "22", "00"] -> "21–23, 00–01"
  const span = (arr) => arr.map((h) => String(h).slice(0, 2)).reduce((g, h) => ((g.length && (+g[g.length - 1][g[g.length - 1].length - 1] + 1) % 24 === +h)
    ? (g[g.length - 1].push(h), g) : [...g, [h]]), []).map((x) => `${x[0]}–${pad((+x[x.length - 1] + 1) % 24)}`).join(', ');
  // One word for an hour of the camera AI log ("bright" = moonlit sky the AI calls dusk/dawn).
  const camWord = (v) => (v.aurora >= 50 ? 'aurora' : (v.bright || 0) >= 30 ? 'possible aurora' : v.dusk >= 50 ? 'bright (moon)'
    : v.clear >= 50 ? 'clear' : v.cloudy >= 50 ? 'cloudy' : 'mixed');
  const hourOrder = (a, b) => ((+a + 12) % 24) - ((+b + 12) % 24);
  // A finished cruise night in the advanced view: the same verdict as the basic view's "Last night" (nightResult):
  // ✓ Seen only from the place's own camera, ? Maybe, ✕ Not seen, … not known yet.
  const SYM = { g: '✓', y: '?', n: '✕', u: '…' };
  function pastSummary(n) {
    const R = nightResult(n.date);
    const rec = LOG && LOG.nights && LOG.nights[n.date];
    const o = rec && rec.observed, f = rec && rec.forecast;
    const lines = [R.line, f ? `Forecast that evening: ${pct(f.score)} ${f.rating}` : 'No evening forecast recorded', R.measured].filter(Boolean);
    return { head: `${SYM[R.big[0]]} ${R.head}`, cls: { g: 'ok', y: 'y', n: 'n', u: 'why' }[R.big[0]], lines, rec, o, f,
      cam: R.here ? { name: `${R.here.name} camera`, hrs: R.here.hrs } : null };
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
      : c.clear_dark.length ? `<span class="ok">clear ${span(c.clear_dark)}</span>` : 'cloudy all night'}`).join(' · ');
    const alerts = (L.alerts || []).map((a) => `${a.kind}${a.count > 1 ? ` ×${a.count}` : ''} (${a.last})`).join(' · ');
    const row = (k, v) => (v ? `<div class="ln-row"><span class="k">${k}</span><span>${v}</span></div>` : '');
    el.style.display = '';
    el.innerHTML = `<summary><b>Last night up north</b> <span class="why">· ${shortDay(L.date)}–${shortDay(new Date(new Date(L.date + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10))}, 18:00–06:00</span></summary>
      <div class="pastres ${/^Aurora on|^Possible/.test(L.headline) ? 'ok' : 'why'}" style="margin:4px 0 8px">${esc(L.headline)}</div>
      ${row('Cameras', cams)}${row('Magnetometers', mag)}${row('Activity', L.hp30 ? `Hp30 max ${L.hp30.max.toFixed(1)} at ${L.hp30.at}` : '')}
      ${row('Clouds (MET)', clouds)}${row('Alerts sent', alerts)}
      <p class="hint" style="margin:6px 0 0">Cameras: all-sky camera AI, checked several times an hour (the most auroral picture of each hour) · magnetometers: lowest point vs quiet level (−50 active, −200 strong) · clouds: MET Norway's analysis afterwards.</p>`;
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
  // Tap-to-explain cells: tapping the selected cell again clears the highlight and puts the hint back.
  function tapSelect(cells, c, show, box, hint) {
    const again = c.classList.contains('sel');
    cells.forEach((x) => x.classList.toggle('sel', !again && x === c));
    box.innerHTML = again ? `<span class="btap">${hint}</span>` : show();
    return !again;
  }

  function bindHover(container, W, bands, htmlFor, onBand) {
    const svg = container.querySelector('svg');
    const tip = tipBox(container);
    let cur = -1; // band whose tooltip is showing
    const hide = () => { tip.style.display = 'none'; cur = -1; onBand && onBand(-1); };
    const handler = (ev) => {
      const rect = svg.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * W;
      const i = bands.findIndex(([a, b]) => x >= a && x < b);
      if (i < 0) { hide(); return; }
      // a second tap on the same band clears the highlight (touch; the mouse just hovers)
      if (ev.type === 'pointerdown' && ev.pointerType !== 'mouse' && i === cur) { hide(); return; }
      cur = i;
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
  const UNKNOWN_GLYPH = '<text x="8" y="12.5" text-anchor="middle" font-size="12" font-weight="700" fill="#8f96a3">?</text>'; // clouds not known
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

  // Hours that are over keep their clouds (the robot carries the last forecast), but a stretch that is over is
  // no answer for tonight any more: only stretches with an hour still to come count, weighted by those hours.
  const hourAhead = (h) => new Date(h.t).getTime() + 3600e3 > Date.now();
  function bestWindow(n) {
    if (!metCovers(n)) return null;
    const st = n.hourly.map((h) => hourStatus(h)[0]);
    for (const want of ['GO', 'TRY']) {
      const runs = [];
      let i = 0;
      // a window is at least 2 hours (the clear-gap rule everywhere); a "maybe" window may include "go" hours
      const ok = (s) => s === want || (want === 'TRY' && s === 'GO');
      while (i < st.length) {
        if (!ok(st[i])) { i++; continue; }
        let j = i;
        while (j + 1 < st.length && ok(st[j + 1])) j++;
        if (j > i && hourAhead(n.hourly[j])) runs.push([i, j]);
        i = j + 1;
      }
      if (!runs.length) continue;
      const left = (r) => n.hourly.slice(r[0], r[1] + 1).filter(hourAhead);
      const worth = (r) => (USE_TIME_CURVE ? left(r).reduce((s, h) => s + auroraShare(h), 0) : left(r).length);
      const best = runs.reduce((b, r) => (worth(r) > worth(b) + 1e-9 ? r : b), runs[0]);
      const text = (r) => `${n.hourly[r[0]].local}–${hm(new Date(new Date(n.hourly[r[1]].t).getTime() + 3600e3))}`;
      const peak = left(best).reduce((b, h) => (auroraShare(h) > auroraShare(b) ? h : b));
      return { label: want, text: text(best), peak: peak.local, hours: n.hourly.slice(best[0], best[1] + 1), others: runs.filter((r) => r !== best).map(text) };
    }
    return null;
  }

  // The robot decides whether MET Norway covers the night (80% of the dark hours); a single MET hour
  // in the evening twilight does not count.
  const metCovers = (n) => n.clear.source.startsWith('MET Norway');
  const metFull = (n) => n.clear.source === 'MET Norway'; // "MET Norway (partial)": only the first hours, with a clear gap
  // when MET's hourly forecast reaches a night, rounded up to the full hour (the robot's runs are not to the minute)
  const metFromText = (n) => {
    if (!n.clear.met_from) return null;
    const t = Math.ceil(new Date(n.clear.met_from).getTime() / 3600e3) * 3600e3;
    return `${dayLabel(shipDate(t).toISOString().slice(0, 10))} around ${hm(t)}`;
  };

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

  // ------------------------------------------------------------ inland cloud check (chase tours from Tromsø and Alta)
  // The robot keeps MET's clouds at the usual tour areas behind the coastal mountains for the dark hours in port
  // (n.inland). The answer uses the hours still to come and the clear-gap rule of the whole page (2+ hours ≤40%):
  // "clearer inland" when a tour area has such a gap and here has none, or one at least 2 hours shorter.
  function inlandView(n) {
    const I = n && n.inland;
    if (!I) return null;
    const ahead = I.t.map((t) => new Date(t).getTime() + 3600e3 > Date.now());
    if (!ahead.some(Boolean)) return null;
    const gap = (vals) => {
      let best = null;
      for (let i = 0; i < vals.length; i++) {
        if (!ahead[i] || vals[i] == null || vals[i] > CLEAR_LINE) continue;
        let j = i;
        while (j + 1 < vals.length && ahead[j + 1] && vals[j + 1] != null && vals[j + 1] <= CLEAR_LINE) j++;
        if (j > i && (!best || j - i > best[1] - best[0])) best = [i, j];
        i = j;
      }
      return best && { len: best[1] - best[0] + 1, text: `${I.local[best[0]]}–${hm(new Date(I.t[best[1]]).getTime() + 3600e3)}` };
    };
    const here = gap(I.here);
    const clear = I.spots.map((s) => ({ ...s, gap: gap(s.cloud) })).filter((s) => s.gap).sort((a, b) => b.gap.len - a.gap.len);
    const best = clear[0];
    if (best && (!here || best.gap.len >= here.len + 2)) {
      const also = clear.slice(1).map((s) => `${s.name} ${s.gap.text}`);
      return { cls: 'ok', text: `Inland: clearer at ${best.name} ${best.gap.text} (${best.drive} drive)${also.length ? ` · also ${also.join(', ')}` : ''}` };
    }
    if (here) return { cls: '', text: `Inland: no clearer than here (clear here ${here.text})` };
    return { cls: '', text: `Inland: cloudy too (${I.spots.map((s) => s.name).join(', ')})` };
  }

  function inlandTable(I) {
    const now = Date.now();
    const cell = (v, i) => `<td class="${new Date(I.t[i]).getTime() + 3600e3 < now ? 'past' : ''}">${v == null ? '–'
      : `<svg class="bico" viewBox="0 0 16 16" aria-hidden="true">${skyGlyph(v)}</svg><span class="${v <= CLEAR_LINE ? 'ok' : ''}">${v}</span>`}</td>`;
    const row = (name, sub, vals) => `<tr><th>${esc(name)}<small>${esc(sub)}</small></th>${vals.map(cell).join('')}</tr>`;
    return `<div class="tbl-wrap"><table class="itab"><tr><th><small>cloud %</small></th>${I.local.map((l) => `<th>${l.slice(0, 2)}</th>`).join('')}</tr>
      ${row(I.port, 'here', I.here)}${I.spots.map((s) => row(s.name, `${s.drive} drive`, s.cloud)).join('')}</table></div>`;
  }
  const INLAND_NOTE = (I) => `Clouds (MET Norway) at the usual chase-tour areas inland from ${esc(I.port)}, behind the coastal mountains, where it is often clearer. Green = clear (≤40%). Drive times are rough, one way; the tour company decides on the night where to go.`;

  function inlandBasic(n) {
    const v = inlandView(n);
    if (!v) return '';
    return `<details class="binland"><summary><span class="${v.cls}">🚗 ${esc(v.text)}</span></summary>
      ${inlandTable(n.inland)}<div class="b-sub">${INLAND_NOTE(n.inland)} <span class="bgo" data-go="inland" role="button" tabindex="0">In the advanced view ›</span></div></details>`;
  }

  function inlandAdvanced(n) {
    const v = inlandView(n);
    if (!v) return '';
    return `<div class="inl"><h4>Inland cloud check · tour areas from ${esc(n.inland.port)}</h4>
      <p class="${v.cls}">🚗 ${esc(v.text)}</p>${inlandTable(n.inland)}<p class="hint">${INLAND_NOTE(n.inland)}</p></div>`;
  }

  // ------------------------------------------------------------ NOAA storm watch
  // Storm-level blocks (G1+ = Kp 4.67+, NOAA's scale) in NOAA's 3-day forecast that are not over yet, joined into
  // periods. The cause comes from NOAA's own reasoning for that (UT) day; without one, a NASA CME arrival nearby.
  const G_WORD = { G1: 'minor', G2: 'moderate', G3: 'strong', G4: 'severe', G5: 'extreme' };
  const gLevel = (kp) => (kp >= 8.67 ? 'G5' : kp >= 7.67 ? 'G4' : kp >= 6.67 ? 'G3' : kp >= 5.67 ? 'G2' : 'G1');
  // where "here" is at a moment: Tromsø before the cruise, the ship's planned position on board
  const placeAt = (t) => {
    if (t < new Date(D.trip.cruise_day_from).getTime()) return [69.65, 18.96, 'Tromsø'];
    const r = (D.route_hourly || []).reduce((b, x) => (!b || Math.abs(new Date(x[0]) - t) < Math.abs(new Date(b[0]) - t) ? x : b), null);
    return r ? [r[1], r[2], r[3] === 'sea' ? 'at sea' : r[4]] : [69.65, 18.96, 'Tromsø'];
  };
  function stormCause(p) {
    const sw = D.space_weather || {};
    const txt = (sw.three_day || {}).rationale || '';
    // NOAA names the (UT) days of its forecast: "... on 02 Oct (due to ... the 28 Sep CME) and 04 Oct (as ... CH/HSS ...)";
    // the text after this day's name up to the next forecast day's name is about this day
    const keysOf = (t) => { const d = new Date(t); return [`${pad(d.getUTCDate())} ${MON[d.getUTCMonth()]}`, `${MON[d.getUTCMonth()]} ${pad(d.getUTCDate())}`]; };
    const own = keysOf(p.a);
    const i = Math.max(...own.map((k) => txt.indexOf(k)));
    if (i >= 0) {
      const rest = txt.slice(i + 6);
      const others = [...new Set((sw.kp_3day || []).map((r) => r.t.slice(0, 10)))].flatMap((day) => keysOf(`${day}T00:00:00Z`)).filter((k) => !own.includes(k));
      const seg = rest.slice(0, Math.min(rest.length, ...others.map((k) => rest.indexOf(k)).filter((x) => x >= 0)));
      const cme = /CME/.test(seg), ch = /\bCH\b|CH\/HSS|coronal hole|HSS/.test(seg);
      if (cme && ch) return 'a solar eruption (CME) and fast wind from a coronal hole';
      if (cme) return 'a solar eruption (CME)';
      if (ch) return 'fast solar wind from a coronal hole';
    }
    const near = (sw.cmes || []).some((c) => { const t = new Date(c.arrival).getTime(); return t > p.a - 18 * 3600e3 && t < p.b + 6 * 3600e3; });
    return near ? 'a solar eruption (CME)' : '';
  }
  function stormPeriods() {
    const now = Date.now();
    const blocks = ((D.space_weather || {}).kp_3day || []).filter((r) => r.kind !== 'observed' && r.kp >= 4.67)
      .map((r) => ({ a: new Date(r.t).getTime(), b: new Date(r.t).getTime() + 3 * 3600e3, kp: r.kp }))
      .filter((k) => k.b > now).sort((x, y) => x.a - y.a);
    const out = [];
    for (const k of blocks) {
      const last = out[out.length - 1];
      if (last && last.b === k.a) { last.b = k.b; last.kp = Math.max(last.kp, k.kp); } else out.push({ ...k });
    }
    return out.map((p) => {
      const [lat, lon, place] = placeAt((p.a + p.b) / 2);
      // which half hours of it are dark there (sun 12° below the horizon, the page's darkness)
      const dark = [];
      for (let t = p.a; t < p.b; t += 1800e3) if (sunAltAt(new Date(t + 900e3), ...placeAt(t + 900e3).slice(0, 2)) <= -12) dark.push(t);
      const darkTxt = dark.length === (p.b - p.a) / 1800e3 ? '' : !dark.length ? 'not dark there'
        : `dark there only ${hm(dark[0])}–${hm(dark[dark.length - 1] + 1800e3)}`;
      return { ...p, g: gLevel(p.kp), cause: stormCause(p), place, need: kpNeedAt(lat, lon), darkTxt };
    });
  }
  // The last jump of the solar wind at the L1 satellite within `hours` (the robot's shock.json)
  const recentShock = (hours) => {
    const ev = ((SHOCK && SHOCK.events) || []).filter((e) => Date.now() - new Date(e.at) < hours * 3600e3);
    return ev.length ? ev[ev.length - 1] : null;
  };
  // when the front reaches Earth: 1.5 million km from L1 at the measured speed (300 km/s: ~85 minutes, 600 km/s: ~40)
  const shockReach = (e) => new Date(e.at).getTime() + (1.5e6 / Math.max(e.after.v, 200)) * 1000;
  // Basic: a short tag only (the user: "a basic oldalra nem kell ennyire bonyolult"); the numbers are in the advanced view
  const shockTag = (e) => `☄️ <b>CME arriving about ${hm(shockReach(e))}</b> (${e.level})`;
  const shockText = (e) => {
    const b = e.before, a = e.after;
    const reach = shockReach(e);
    return `${e.level} jump: ${b.v} → ${a.v} km/s, density ×${Math.round(a.n / b.n)}, Bt ${Math.round(b.bt)} → ${Math.round(a.bt)} nT · reaches Earth about ${hm(reach)}`;
  };
  const stormWhen = (p) => `${dayLabel(shipDate(p.a).toISOString().slice(0, 10))} ${hm(p.a)}–${hm(p.b)}`;
  const stormHere = (p) => (p.kp - p.need >= 2 ? 'if it comes and the sky is clear, a bright, moving display'
    : p.kp >= p.need ? 'if it comes, it should reach here too' : 'probably not enough this far south');

  // Basic: one line on the Tonight card when a storm period falls into tonight's dark hours
  function stormBasic(n) {
    if (!n || shipNow().phase === 'over') return '';
    const dark = n.hourly.filter((h) => h.dark).map((h) => new Date(h.t).getTime());
    if (!dark.length) return '';
    const a = Math.min(...dark), b = Math.max(...dark) + 3600e3;
    const p = stormPeriods().find((x) => x.a < b && x.b > a);
    const sh = recentShock(6);
    if (!p && sh) {
      return `<div class="bstorm" id="b-storm" role="button" tabindex="0">${shockTag(sh)}. <span class="btap">Details ›</span></div>`;
    }
    if (!p) return '';
    return `<div class="bstorm" id="b-storm" role="button" tabindex="0">${sh ? `${shockTag(sh)}. ` : ''}⚡ <b>NOAA storm watch:</b> ${G_WORD[p.g]} storm (${p.g}, Kp ${p.kp.toFixed(1)}) expected tonight ${hm(p.a)}–${hm(p.b)}${p.cause ? `, from ${p.cause}` : ''}. About ${n.kp_req.toFixed(1)} is enough here: ${stormHere({ ...p, need: n.kp_req })}. <span class="btap">Details ›</span></div>`;
  }

  // Advanced: the storm periods of the next days, NOAA's reasoning, the CME model and what is measured now
  function renderStorm() {
    const el = $('#storm');
    if (!el) return;
    const P = stormPeriods();
    const sh = recentShock(12);
    if ((!P.length && !sh) || shipNow().phase === 'over') { el.style.display = 'none'; el.innerHTML = ''; return; }
    const sw = D.space_weather || {};
    const cmes = (sw.cmes || []).filter((c) => new Date(c.arrival).getTime() > Date.now() - 24 * 3600e3);
    el.style.display = '';
    el.innerHTML = `<h3>⚡ NOAA storm watch</h3>
      ${sh ? `<p class="shock">☄️ <b>CME arrived at the solar wind satellite ${hm(sh.at)}</b> (${dayLabel(shipDate(sh.at).toISOString().slice(0, 10))}): ${esc(shockText(sh))}.</p>` : ''}
      ${P.length ? `<p class="hint" style="margin-top:0">NOAA's 3-day forecast has storm-level activity coming: G1 or more = Kp 4.7+. Scale: G1 minor · G2 moderate · G3 strong · G4 severe · G5 extreme. Times are ship time.</p>
      <div class="tbl-wrap"><table class="storm">
        <tr><th>When</th><th>Level</th><th>Cause</th><th>Needed there</th></tr>
        ${P.map((p) => `<tr><td>${stormWhen(p)}</td><td>${p.g} ${G_WORD[p.g]} · Kp ${p.kp.toFixed(1)}</td><td>${esc(p.cause || 'not stated')}</td>
          <td>${esc(p.place)} ${p.need.toFixed(1)} → ${p.kp - p.need >= 2 ? '<span class="ok">well above</span>' : p.kp >= p.need ? '<span class="ok">enough</span>' : 'below'}${p.darkTxt ? `<br><span class="why">${p.darkTxt}</span>` : ''}</td></tr>`).join('')}
      </table></div>` : '<p class="hint" style="margin-top:0">No storm level in NOAA\'s 3-day forecast. Times are ship time.</p>'}
      ${sw.three_day && sw.three_day.rationale ? `<p><b>NOAA's reasoning:</b> ${esc(sw.three_day.rationale)}</p>` : ''}
      ${cmes.length ? `<p><b>NASA CME model:</b> ${cmes.map((c) => `modelled arrival ${dayLabel(shipDate(c.arrival).toISOString().slice(0, 10))} ${hm(c.arrival)}${c.glancing ? ' (glancing blow)' : ''}, Kp ${c.kp_min ?? '?'}–${c.kp_max ?? '?'}`).join(' · ')}</p>` : ''}
      <p id="storm-now"></p>
      <p class="hint">The timing is often hours off: NOAA updates this forecast several times a day, and a CME can arrive many hours earlier or later than modelled, or miss. What is measured now shows whether it has started.
        The solar wind is measured by a satellite 1.5 million km towards the Sun (the L1 point), 40–85 minutes before it reaches Earth (the faster, the sooner): <b>speed</b> (calm 300–400 km/s), <b>density</b> (particles per cm³, calm 2–10; a CME's front packs them several times tighter), <b>Bt</b> (strength of its magnetic field in nanotesla, calm ~5) and <b>Bz</b> (the north–south part of that field: south, negative, opens the door). A CME arrival shows as a sudden jump of all of them; the robot checks for it several times an hour and sends a ☄️ alert.</p>`;
    updateStormNow();
  }
  function updateStormNow() {
    const el = $('#storm-now');
    if (!el) return;
    const hp = hp30Now();
    const parts = [LIVE.sw != null ? `solar wind ${LIVE.sw} km/s (a CME usually pushes it to 450+)` : null,
      LIVE.bt != null ? `Bt ${LIVE.bt} nT (storms usually 10+)` : null,
      hp != null ? `Hp30 ${hp.toFixed(1)} (storm level 4.7+)` : null].filter(Boolean);
    if (!parts.length) { el.innerHTML = '<b>Now:</b> loading the live values…'; return; }
    const signs = [LIVE.sw >= 450 && 'fast solar wind', LIVE.bt >= 10 && 'strong magnetic field', hp != null && hp >= 4.67 && 'storm level measured'].filter(Boolean);
    // after a CME's front has arrived, "no sign" would contradict the arrival line: say it is weak so far
    const sh = recentShock(12);
    el.innerHTML = `<b>Now (${hm(Date.now())}):</b> ${parts.join(' · ')} → ${signs.length ? `<span class="ok">under way: ${signs.join(', ')}</span>`
      : sh ? `arrived ${hm(sh.at)}, no storm level so far` : 'no sign of it yet'}`;
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
      <p class="hint">Cloud: MET Norway's analysis at the ship's position that hour (green = clear, ≤40%). Hp30 = planetary activity; ≈${s.o.kp_needed} was needed here. Camera AI only when the place has its own all-sky camera (within 60 km).</p>`
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
      ${inlandAdvanced(n)}
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
        <div class="row"><span>Sky</span><span>${h.dark ? 'dark' : h.sun < -3 ? 'twilight' : 'daylight'}</span></div>
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
    const tos = kpNeedAt(69.65, 18.96), alta = kpNeedAt(69.98, 23.25); // the same numbers as "needed here" everywhere
    for (const [v, lab] of [[tos, `needed: Tromsø ≈${tos.toFixed(1)}, Alta ≈${alta.toFixed(1)}`], [3, 'Trondheim/Ålesund ≈3'], [5, 'G1 storm']]) {
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
      <div class="hint">Issued ${esc(sw.kp_27day.issued || '–')} (new issue every Monday). The purple band marks the Arctic nights (${shortDay(KEY_NIGHTS[0])}–${shortDay(KEY_NIGHTS[KEY_NIGHTS.length - 1])}).</div>`;
    drawKp27();
  }

  function drawKp27() {
    const sw = D.space_weather;
    const days = sw.kp_27day.days;
    const cont = $('#kp27-chart');
    const obs = Object.fromEntries(sw.observed_daily.map((o) => [o.date, o.kp_max]));
    const first = new Date(days[0].date + 'T00:00:00Z');
    const last = new Date(Math.max(new Date(days[days.length - 1].date + 'T00:00:00Z'), new Date(shipDate(D.trip.end).toISOString().slice(0, 10) + 'T00:00:00Z')));
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
    let g = band(D.nights[0].date, D.nights[D.nights.length - 1].date, '#1d1f24', 'Cruise') + band(KEY_NIGHTS[0], KEY_NIGHTS[KEY_NIGHTS.length - 1], '#2a2342', '');
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
    // an empty list only means "none" when NASA's service answered; otherwise say it is not known
    const cmeDown = D.sources && D.sources.nasa_donki_cme && !D.sources.nasa_donki_cme.ok;
    $('#swpc-text').innerHTML = `
      <h3>What the forecasters say</h3>
      <p class="hint" style="margin-top:0">The written forecast of NOAA's space weather forecasters (the people, not a model): the week ahead, the next 3 days, and solar eruptions heading to Earth.</p>
      <p><b>NOAA weekly forecast</b> (${esc(w.period || '')}, issued ${esc(w.issued || '–')}):<br>${esc(w.geomagnetic || 'not available')}</p>
      <p class="hint">Jargon: "CH HSS" = fast solar wind from a coronal hole, the typical source of moderate aurora activity at this stage of the solar cycle. "Unsettled/active" ≈ Kp 3–4, "G1" = Kp 5.</p>
      <p><b>Solar eruptions (CMEs) heading to Earth:</b> ${cmes.length ? '' : cmeDown ? 'not known right now: NASA\'s CME model service did not answer at the last update, so the forecast runs without it.' : 'none in NASA\'s model runs from the last 7 days.'}</p>
      ${cmes.length ? `<ul>${cmes.map((c) => `<li>Arrival ≈ ${esc(dayLabel(shipDate(c.arrival).toISOString().slice(0, 10)))} ${hm(c.arrival)} ship time${c.glancing ? ' (glancing blow)' : ''} · expected Kp ${c.kp_min ?? '?'}–${c.kp_max ?? '?'} ${c.link ? `· <a href="${esc(c.link)}" target="_blank" rel="noopener">details</a>` : ''}</li>`).join('')}</ul>` : ''}`;
  }

  // ------------------------------------------------------------ live
  const setTile = (id, v, sub) => { const e = document.getElementById(id); if (e) { e.querySelector('.v').innerHTML = v; e.querySelector('.s').innerHTML = sub; } };

  // Kp level needed for aurora overhead at the ship (same rule as the pipeline).
  function kpNeedAt(lat, lon) {
    const R = Math.PI / 180;
    const mlat = Math.asin(Math.sin(lat * R) * Math.sin(80.8 * R) + Math.cos(lat * R) * Math.cos(80.8 * R) * Math.cos((lon + 72.6) * R)) / R;
    return Math.max(0, Math.min(9, (67.5 - mlat) / 1.8 + 0.5));
  }
  // Live "here": Tromsø (the practice spot) before the cruise, the ship from the day of departure (herePos)
  const liveNeed = () => { const [lat, lon] = herePos(); return kpNeedAt(lat, lon); };

  // The newer of two Hp30 series (latest.json every 3 h, data/hp30.json several times an hour).
  const newerHp30 = (a, b) => ((b && b.length && (!a || !a.length || b[b.length - 1][0] > a[a.length - 1][0])) ? b : (a || []));

  let hpSel = null; // the half hour tapped in the Hp30 tile (kept across refreshes)
  const hpWhy = (t, v, need) => `<b>${hm(new Date(t))}–${hm(new Date(t + 1800e3))}</b> · ${v == null ? 'no value' : `<span class="kp">Hp30 ${v.toFixed(1)} measured</span>${vsNeed([v], need)}`}`;
  function updateHp30Tile() {
    if (!HP30 || !HP30.length) return setTile('lt-hp', '–', 'not available');
    const need0 = liveNeed();
    // every half hour we have, oldest first (fresh file + the week in latest.json)
    const byT = new Map();
    for (const [ts, v] of hp30All()) byT.set(new Date(ts).getTime(), v);
    const pts = [...byT.entries()].sort((a, b) => a[0] - b[0]);
    if (pts.length >= 2) {
      const [tl, vl] = pts[pts.length - 1], vp = pts[pts.length - 2][1];
      const arrow = vl - vp >= 0.3 ? ['↑', 'rising'] : vl - vp <= -0.3 ? ['↓', 'falling'] : ['→', 'steady'];
      // last 12 hours as 24 half-hour bars (hours on the axis), green where it reached the level needed here; tap a bar
      const slots = Array.from({ length: 24 }, (_, k) => tl - (23 - k) * 1800e3);
      const top = Math.max(3, need0 + 1, ...slots.map((t) => byT.get(t) ?? 0));
      if (!slots.includes(hpSel)) hpSel = null;
      const cells = slots.map((t) => {
        const v = byT.get(t);
        return `<div data-t="${t}" class="${t === hpSel ? 'sel' : ''}">${v == null ? '' : `<i class="${v >= need0 ? 'ok' : ''}" style="height:${Math.max(3, (v / top) * 100).toFixed(1)}%"></i>`}</div>`;
      }).join('');
      const axis = slots.map((t) => { const d = shipDate(t); return `<span>${d.getUTCMinutes() === 0 && d.getUTCHours() % 2 === 0 ? pad(d.getUTCHours()) : ''}</span>`; }).join('');
      const max24 = Math.max(...pts.filter(([t]) => t > tl - 24 * 3600e3).map(([, v]) => v));
      const old = Date.now() - tl > 120 * 60e3 ? ' · <b>old data</b>' : '';
      setTile('lt-hp', `${vl.toFixed(1)} <span class="magarrow">${arrow[0]}</span> <span class="magword">${arrow[1]}</span>`,
        `<div class="hpc">${cells}<div class="need" style="bottom:${((need0 / top) * 100).toFixed(1)}%"><span>${need0.toFixed(1)} needed here</span></div></div>
        <div class="hpax">${axis}</div>
        <div class="bwhy" id="hp-why">${hpSel ? hpWhy(hpSel, byT.get(hpSel), need0) : '<span class="btap">👆 Tap a bar to see that half hour</span>'}</div>
        <div>now ${vl.toFixed(1)} · 24 h max ${max24.toFixed(1)} · needed here ≈${need0.toFixed(1)} ${vl >= need0 ? '✓ enough' : '✕ not enough'}${old}</div>
        <div class="why">last 12 hours, ship time · green = enough here · grey = below</div>`);
      const hpCells = document.querySelectorAll('#lt-hp .hpc > div[data-t]');
      hpCells.forEach((c) => c.addEventListener('click', () => {
        const on = tapSelect(hpCells, c, () => hpWhy(+c.dataset.t, byT.get(+c.dataset.t), need0), $('#hp-why'), '👆 Tap a bar to see that half hour');
        hpSel = on ? +c.dataset.t : null;
      }));
      return;
    }
    const need = liveNeed();
    const [ts, v] = HP30[HP30.length - 1];
    const max24 = Math.max(...HP30.map((p) => p[1]));
    const ageMin = Math.round((Date.now() - new Date(ts)) / 60000) - 30; // value covers ts..ts+30min
    setTile('lt-hp', v.toFixed(1),
      `needed here ≈${need.toFixed(1)} ${v >= need ? '✓' : '✕'} · ${hm(new Date(new Date(ts).getTime() + 1800e3))} ship time${ageMin > 90 ? ' (old)' : ''} · 24 h max ${max24.toFixed(1)}`);
  }

  // Nearest FMI magnetometer to the ship (Tromsø area before the cruise). None near the southern ports.
  // A station's story this evening (from 16:00 ship time; after midnight: since 16:00 the day before):
  // value now vs the quiet level, its 10-minute trend, the highest rise and the deepest dip with their times.
  const eveningFrom = () => {
    const sd = shipDate(Date.now());
    if (sd.getUTCHours() < 12) sd.setUTCDate(sd.getUTCDate() - 1);
    return new Date(sd.toISOString().slice(0, 10) + 'T16:00:00Z').getTime() - OFFSET_H * 3600e3;
  };
  const magPts = (st) => {
    const s0 = new Date(st.series.t0).getTime(), step = st.series.step_min * 60e3, now = Date.now();
    return st.series.dev.map((v, i) => [s0 + i * step, v]).filter(([t, v]) => v != null && t <= now);
  };
  // the change over the 10 minutes ending at point i of a 1-minute series
  const d10At = (pts, i) => { let j = i; while (j > 0 && pts[j - 1][0] >= pts[i][0] - 600e3) j--; return pts[i][1] - pts[j][1]; };
  // Substorm moments since `from` at the nearby stations: one of them at -50 nT or lower, or a 10-minute change of
  // 50 nT or more either way (on 1 Oct 2026 the substorm started with a +83 nT jump at Kilpisjärvi; Masi went to -90).
  const MAG_JUMP = 50;
  const SLOW_RISE = 30; // nT per 10 min: a faster rise is part of a substorm, not "charging" (tuned on 29 Sep-1 Oct 2026)
  function substormTimes(list, from) {
    const ev = [];
    for (const pts of list) pts.forEach(([t, v], i) => { if (t >= from && (v <= -MAG_JUMP || Math.abs(d10At(pts, i)) >= MAG_JUMP)) ev.push(t); });
    return ev.sort((a, b) => a - b);
  }
  // Hp30 now: the higher of the last two published half hours (one hour: no flicker around the need), or null when
  // the newest is older than 2 hours. A half hour is published about 30 minutes after it starts.
  function hp30Now() {
    const now = Date.now();
    const pub = hp30All().map(([ts, v]) => [new Date(ts).getTime(), v]).filter(([t]) => t + 1800e3 <= now).sort((a, b) => a[0] - b[0]);
    if (!pub.length || now - pub[pub.length - 1][0] > 120 * 60e3) return null;
    return Math.max(...pub.slice(-2).map((p) => p[1]));
  }

  function magStory(st) {
    if (!st || !st.series) return null;
    const from = eveningFrom();
    const pts = magPts(st);
    if (!pts.length) return null;
    const [tNow, now] = pts[pts.length - 1];
    const ago = pts.filter(([t]) => t <= tNow - 10 * 60e3).pop();
    const eve = pts.filter(([t]) => t >= from);
    const span = eve.length ? eve : pts.slice(-180);
    const peak = span.reduce((b, p) => (p[1] > b[1] ? p : b)), low = span.reduce((b, p) => (p[1] < b[1] ? p : b));
    return { pts, tNow, now, d10: ago ? now - ago[1] : 0, peak, low, evening: eve.length > 0 };
  }
  const nT = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`;

  // Last 3 hours as a small line around the quiet level (dashed 0 line)
  function magSpark(pts) {
    const p = pts.filter(([t]) => t >= pts[pts.length - 1][0] - 3 * 3600e3);
    if (p.length < 2) return '';
    const t0 = p[0][0], t1 = p[p.length - 1][0], m = Math.max(60, ...p.map(([, v]) => Math.abs(v)));
    const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * 200, y = (v) => 22 - (v / m) * 20;
    const line = p.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return `<svg class="magspark" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="200" y1="22" y2="22" stroke="#555a63" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
      <polyline points="${line}" fill="none" stroke="#9fd3ff" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function updateMagTile() {
    const st = MAG && MAG.stations;
    if (!st || !Object.keys(st).length) return setTile('lt-mag', '–', 'no reading yet (logged after dark only)');
    const [lat, lon] = herePos();
    const R = Math.PI / 180;
    const km = (x) => 6371 * Math.acos(Math.min(1, Math.sin(lat * R) * Math.sin(x.lat * R) + Math.cos(lat * R) * Math.cos(x.lat * R) * Math.cos((lon - x.lon) * R)));
    const best = Object.values(st).reduce((b, x) => (!b || km(x) < km(b) ? x : b), null);
    if (km(best) > 300) return setTile('lt-mag', '–', 'no station near the ship here: use Kp, Hp30 and the map');
    const old = Date.now() - new Date(best.t) > 40 * 60e3;
    const where = `${esc(best.name)} (${Math.round(km(best) / 10) * 10} km) · ${hm(best.t)} ship time${old ? ' (old: logged after dark only)' : ''}`;
    const m = magStory(best);
    if (!m) return setTile('lt-mag', `${best.swing_60}<small> nT</small>`, `swing in the last hour · ${where}`);
    // + = field pushed up (energy building), − = dip (substorm, aurora moving); arrow = last 10 minutes
    const arrow = m.d10 >= 5 ? '↑' : m.d10 <= -5 ? '↓' : '→';
    // the same substorm rule as the basic "Aurora now" (any nearby station, the last half hour): a 1-2 minute spike
    // between two 10-minute looks is still a substorm (Kilpisjärvi +83 nT at 22:49 on 1 Oct 2026, back to -2 at 22:51)
    const near = Object.values(st).filter((x) => x.series && km(x) <= 300).map(magPts).filter((p) => p.length);
    const recentSub = substormTimes(near, Date.now() - 1800e3).length > 0;
    const word = m.now <= -50 || best.change_10 <= -50 || Math.abs(m.d10) >= MAG_JUMP || recentSub ? 'substorm'
      : m.d10 >= 5 ? 'rising' : m.d10 <= -5 ? 'falling' : Math.abs(m.now) < 20 ? 'calm' : 'steady';
    const strong = m.now <= -200 || best.swing_60 >= 200 ? ' · <span class="ok">strong: go outside if clear</span>' : '';
    const when = m.evening ? 'this evening' : 'last 3 h';
    setTile('lt-mag', `${nT(m.now)}<small> nT</small> <span class="magarrow">${arrow}</span> <span class="magword ${word}">${word}</span>`,
      `${magSpark(m.pts)}<div>${when}: ${[[m.low, 'lowest'], [m.peak, 'peak']].sort((x, y) => x[0][0] - y[0][0])
        .map(([q, k]) => `${k} ${nT(q[1])} at ${hm(new Date(q[0]))}`).join(' → ')} → now ${nT(m.now)}${strong}</div>
      <div class="why">${word === 'calm' ? 'calm field: no substorm now, quiet arcs still possible · ' : ''}vs the quiet level · ${where}</div>`);
  }

  function refreshNoaaTiles() {
    const need = liveNeed();
    getJSON(`${SWPC}/products/summary/solar-wind-mag-field.json`).then((a) => {
      const bz = a[0].bz_gsm;
      LIVE.bt = a[0].bt;
      safe(updateStormNow);
      setTile('lt-bz', `${bz > 0 ? '+' : ''}${bz}<small> nT</small>`, bz <= -5 ? '✓ strongly south: door open' : bz < 0 ? 'slightly south' : '✕ north: door mostly closed');
    }).catch(() => setTile('lt-bz', '–', 'offline'));
    getJSON(`${SWPC}/products/summary/solar-wind-speed.json`).then((a) => {
      const v = a[0].proton_speed;
      LIVE.sw = v;
      safe(updateStormNow);
      setTile('lt-sw', `${v}<small> km/s</small>`, v >= 500 ? '✓ fast' : v >= 400 ? 'moderate' : 'slow');
    }).catch(() => setTile('lt-sw', '–', 'offline'));
    const st = $('#live-stamp');
    if (st) st.textContent = `Updated ${hm(Date.now())} ship time · refreshes by itself while this page is open (numbers every 2 min, pictures and map every 10 min)`;
  }

  // Files the robot writes: Hp30 and the magnetometer swing.
  async function refreshRobotFiles() {
    const [hp, mag, shock] = await Promise.all([getJSON('data/hp30.json').catch(() => null), getJSON('data/mag.json').catch(() => null),
      getJSON('data/shock.json').catch(() => null)]);
    if (shock) { SHOCK = shock; safe(renderStorm); }
    HP30 = newerHp30(HP30, hp && hp.series);
    if (mag) MAG = mag;
    updateHp30Tile();
    updateMagTile();
    safe(updateStormNow);
    safe(drawMagChart);
    basicRefresh();
  }

  function refreshOvation() {
    const [lat, lon, label] = herePos();
    getOvation().then((o) => {
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
      (s.aboard ? `<div class="tile ship"><div class="k">Ship</div><div class="v">${esc(shortPlace(s.place))}</div><div class="s">${s.lat.toFixed(1)}°N ${s.lon.toFixed(1)}°E (from itinerary)</div></div>`
        : s.phase === 'over' ? '<div class="tile ship"><div class="k">Reference</div><div class="v">Tromsø</div><div class="s">the cruise is over; the live numbers are for Tromsø</div></div>'
        : '<div class="tile ship"><div class="k">Practice spot</div><div class="v">Tromsø</div><div class="s">until the cruise starts, all live numbers are for Tromsø</div></div>') +
      t('Activity now (Hp30)', '…', '', 'lt-hp').replace('class="tile"', 'class="tile wide"') + t('Magnetometer', '…', '', 'lt-mag') +
      t('Bz', '…', '', 'lt-bz') + t('Solar wind', '…', '', 'lt-sw') + t('Aurora overhead', '…', 'NOAA OVATION', 'lt-ov');
    refreshNoaaTiles();
    updateHp30Tile();
    updateMagTile();

    // Everything loads automatically (the ship has fast Starlink-based Wi-Fi); ~2.5 MB per page view.
    $('#bz-panel').innerHTML = `<h3>Solar wind, last 24 h</h3>
      <p class="hint">Measured 1.5 million km towards the Sun (L1), 40–85 minutes before it reaches us. <b>Bz</b> negative (south) lets the energy in: 20+ minutes below −5 nT often triggers aurora within the hour. A CME's front = a sudden step up of field, speed and density together (☄️ line). <a href="https://www.swpc.noaa.gov/products/real-time-solar-wind" target="_blank" rel="noopener">NOAA's own solar wind plot ↗</a></p>
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
    const view = satView || (!s.aboard || s.lat >= 63 ? 'north' : 'scand');
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
    const [lat, lon, label] = herePos();
    const where = label === 'at the ship' ? label : `at ${label}`;
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
  // Tromsø AI keograms: the last night's until the camera starts again in the evening, older nights from the archive
  const KEO_DIR = { tromso: ['archives', ''], skibotn: ['archives_skibotn', '_skibotn'], kiruna: ['archives_kiruna', '_kiruna'] };
  function keogramUrl(id, date) {
    const [dir, suffix] = KEO_DIR[id];
    const s = shipDate(Date.now());
    const yesterday = new Date(s.getTime() - 864e5).toISOString().slice(0, 10);
    if (date === yesterday && s.getUTCHours() < 16) return `${AI_BASE}latest_keo${suffix}.png`;
    return `${AI_BASE}${dir}/${date.slice(0, 4)}_season/keo/keo_${date.replace(/-/g, '')}.png`;
  }
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
    // the same thresholds as the hourly night log (camWord), so "now" and "last night" never disagree
    if (aurora >= 50) return ['good', `Aurora now (${type.toLowerCase()})`, aurora];
    if (bright >= 30) return ['moon', `Possible aurora (${Math.round(bright)}%), bright sky`, aurora];
    // a bright sky with the sun less than 14 degrees down is dawn or dusk (Skibotn 05:15 on 3 Oct 2026, sun -11 degrees,
    // was called moonlight); deeper in the night it is the moon
    if ((a['Dusk/Dawn'] || 0) >= 50 && sunAlt != null && sunAlt < -14) return ['moon', 'Bright sky (moonlight)', aurora];
    if ((a['Dusk/Dawn'] || 0) >= 50) return ['day', 'Daylight / twilight', aurora];
    if ((a.Clear || 0) >= 50) return ['clear', 'Clear sky, no aurora', aurora];
    if ((a.Cloudy || 0) >= 50) return ['cloud', 'Cloudy', aurora];
    return ['mixed', 'Mixed / uncertain', aurora];
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
      if (s.aboard) L.circleMarker([s.lat, s.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#3ee08f', fillOpacity: 1 }).addTo(ovMap).bindTooltip('Ship now', { permanent: true, direction: 'right' });
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
      const [raw, wind] = await Promise.all([getJSON(`${SWPC}/json/rtsw/rtsw_mag_1m.json`), getJSON(`${SWPC}/json/rtsw/rtsw_wind_1m.json`).catch(() => [])]);
      // 10-minute means of the active satellite: Bz and Bt (field), speed and density (plasma)
      const bins = new Map();
      const add = (r, k, v) => {
        if (!r.active || v == null) return;
        const b = Math.floor(new Date(r.time_tag + 'Z').getTime() / 600e3) * 600e3;
        const o = bins.get(b) || {};
        (o[k] = o[k] || []).push(v);
        bins.set(b, o);
      };
      for (const r of raw) { add(r, 'bz', r.bz_gsm); add(r, 'bt', r.bt); }
      for (const r of wind) { add(r, 'v', r.proton_speed); add(r, 'n', r.proton_density); }
      const mean = (a) => (a && a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
      bzPts = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([t, o]) => ({ t, bz: mean(o.bz), bt: mean(o.bt), v: mean(o.v), n: mean(o.n) }))
        .filter((p) => p.bz != null);
      if (btn) btn.remove();
      drawBz();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Retry (offline?)'; } // on a background refresh keep the last chart
    }
  }

  // Three rows over one time axis: Bt and Bz (nT), speed (km/s), density (per cm³, log); ☄️ = a CME front the robot found
  function drawBz() {
    const cont = $('#bz-chart');
    if (!bzPts || !cont) return;
    const pts = bzPts;
    const W = widthOf(cont), ml = 40, mr = 8, mt = 8, gap = 22, mb = 26, hB = 150, hV = 74, hN = 74;
    const H = mt + hB + gap + hV + gap + hN + mb;
    const pw = W - ml - mr;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const x = (t) => ml + ((t - t0) / (t1 - t0)) * pw;
    const lim = Math.max(10, Math.ceil(Math.max(...pts.map((q) => Math.max(Math.abs(q.bz), q.bt || 0))) / 5) * 5);
    const yB = (v) => mt + hB / 2 - (v / lim) * (hB / 2);
    const top2 = mt + hB + gap, top3 = top2 + hV + gap;
    const vs = pts.map((q) => q.v).filter((v) => v != null);
    const vMax = Math.max(600, Math.ceil(Math.max(0, ...vs) / 100) * 100), vMin = 200;
    const yV = (v) => top2 + hV - ((Math.min(vMax, Math.max(vMin, v)) - vMin) / (vMax - vMin)) * hV;
    const yN = (n) => top3 + hN - ((Math.log10(Math.min(100, Math.max(0.1, n))) + 1) / 3) * hN;
    const line = (y1, k) => `<line x1="${ml}" x2="${ml + pw}" y1="${y1}" y2="${y1}" stroke="${k ? '#555' : '#2c2c2a'}"/>`;
    let g = `<rect x="${ml}" y="${yB(-5)}" width="${pw}" height="${yB(-lim) - yB(-5)}" fill="rgba(12,163,12,0.08)"/>`;
    for (let v = -lim; v <= lim; v += 5) g += line(yB(v), v === 0) + `<text x="${ml - 6}" y="${yB(v) + 4}" text-anchor="end">${v}</text>`;
    g += `<text x="${ml + 4}" y="${mt + 12}" class="lbl">Bt (white) · Bz (blue), nT · green: below −5, good for aurora</text>`;
    for (let v = 300; v <= vMax; v += 100) g += line(yV(v), false) + `<text x="${ml - 6}" y="${yV(v) + 4}" text-anchor="end">${v}</text>`;
    g += `<text x="${ml + 4}" y="${top2 - 6}" class="lbl">Speed, km/s · 450+ as in storms</text>`;
    for (const n of [0.1, 1, 10, 100]) g += line(yN(n), false) + `<text x="${ml - 6}" y="${yN(n) + 4}" text-anchor="end">${n}</text>`;
    g += `<text x="${ml + 4}" y="${top3 - 6}" class="lbl">Density, particles per cm³ (calm 2–10)</text>`;
    const stepH = pw < 450 ? 6 : 3;
    for (let t = Math.ceil(t0 / (stepH * 3600e3)) * stepH * 3600e3; t <= t1; t += stepH * 3600e3) g += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${hm(t)}</text>`;
    for (const e of (SHOCK && SHOCK.events) || []) {
      const t = new Date(e.at).getTime();
      if (t < t0 || t > t1) continue;
      g += `<line x1="${x(t)}" x2="${x(t)}" y1="${mt}" y2="${top3 + hN}" stroke="#e05a5a" stroke-width="1.5"/><text x="${x(t) + 4}" y="${mt + hB - 6}" class="lbl" style="fill:#f08a8a">☄️ CME ${hm(t)}</text>`;
    }
    g += '<g class="hl"></g>';
    // one polyline per unbroken stretch of a value
    const path = (k, y, color, w) => {
      let d = '', on = false;
      for (const q of pts) {
        if (q[k] == null) { on = false; continue; }
        d += `${on ? 'L' : 'M'}${x(q.t).toFixed(1)},${y(q[k]).toFixed(1)}`;
        on = true;
      }
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round"/>`;
    };
    g += path('bt', yB, '#d9d9d9', 1.5) + path('bz', yB, '#3987e5', 2) + path('v', yV, '#e5c14a', 1.8) + path('n', yN, '#e8743b', 1.8);
    cont.innerHTML = svgTag(W, H, 'Solar wind, 10-minute means', g) + '<div class="hint">10-minute means, ship time. Source: NOAA real-time solar wind (L1 point).</div>';
    const xs = pts.map((q) => x(q.t));
    const bands = xs.map((cx, i) => [i === 0 ? ml : (xs[i - 1] + cx) / 2, i === xs.length - 1 ? ml + pw : (cx + xs[i + 1]) / 2]);
    const hl = cont.querySelector('.hl');
    const f = (v, d, u) => (v == null ? '–' : `${v.toFixed(d)} ${u}`);
    bindHover(cont, W, bands, (i) => `<b>${hm(pts[i].t)}</b><div class="row"><span>Bz</span><span>${f(pts[i].bz, 1, 'nT')}</span></div>
      <div class="row"><span>Bt</span><span>${f(pts[i].bt, 1, 'nT')}</span></div><div class="row"><span>Speed</span><span>${f(pts[i].v, 0, 'km/s')}</span></div>
      <div class="row"><span>Density</span><span>${f(pts[i].n, 1, '/cm³')}</span></div>`,
      (i) => { hl.innerHTML = i < 0 ? '' : `<line x1="${xs[i]}" x2="${xs[i]}" y1="${mt}" y2="${top3 + hN}" stroke="#aaa" stroke-dasharray="3 3"/>`; });
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
    if (s.aboard) {
      L.circleMarker([s.lat, s.lon], { radius: 10, color: '#3ee08f', weight: 3, fillColor: '#3ee08f', fillOpacity: 0.35 }).addTo(map).bindTooltip('Ship now (from itinerary)', { permanent: true });
    }
    map.fitBounds(pl.getBounds(), { padding: [20, 20] });
  }

  // ------------------------------------------------------------ verification log (past nights)
  function verificationTable() {
    const recs = VER && VER.nights ? Object.values(VER.nights).filter((r) => r.observed).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.spot.localeCompare(b.spot))) : [];
    if (!recs.length) return '';
    // Stretches of 2+ consecutive hours (the clear-gap rule of the whole page) in a list of true/false hours
    const runs = (flags) => {
      const out = [];
      for (let i = 0; i < flags.length; i++) {
        if (!flags[i]) continue;
        let j = i;
        while (j + 1 < flags.length && flags[j + 1]) j++;
        if (j > i) out.push([i, j]);
        i = j;
      }
      return out;
    };
    const runText = (axis, rs) => rs.map(([a, b]) => `${axis[a].slice(0, 2)}–${pad((+axis[b].slice(0, 2) + 1) % 24)}`).join(', ');
    // Was a recorded forecast right about the clouds? Right = it said a clear stretch and there was one at that time,
    // or it said none and there was none. A forecast made before MET's hourly forecast reached the night is not judged.
    const judge = (r, key) => {
      const o = r.observed, f = r[key];
      if (!f) return null;
      if (f.hours.every((h) => h[1] === '–' || h[1] === 'twilight')) return { early: true, f };
      const axis = o.hours.map((h) => h[0]);
      const said = axis.map((l) => { const h = f.hours.find((x) => x[0] === l); return !!h && (h[1] === 'GO' || h[1] === 'TRY'); });
      const real = axis.map((l) => (o.clear_dark || []).includes(l));
      const fr = runs(said), rr = runs(real);
      const ok = fr.length ? fr.some(([a, b]) => rr.some(([c, d]) => a <= d && c <= b)) : !rr.length;
      return { ok, f, said: fr.length ? `clear ${runText(axis, fr)}` : 'no clear stretch' };
    };
    const LEADS = [['forecast', 'that evening'], ['forecast_1d', '1 day before'], ['forecast_2d', '2 days before']];
    const score = (key) => {
      const js = recs.map((r) => judge(r, key)).filter((j) => j && !j.early);
      return js.length ? `${js.filter((j) => j.ok).length} of ${js.length}` : '–';
    };
    const camHours = (r) => {
      if (r.spot !== 'Tromsø') return null; // Skibotn is ~140 km from Alta
      return (SKY && SKY.nights && SKY.nights[r.date] && SKY.nights[r.date].tromso) || null;
    };
    const card = (r) => {
      const o = r.observed;
      const axis = o.hours.map((h) => h[0]);
      const ev = r.forecast;
      const cam = camHours(r);
      const fcCls = (l) => {
        const h = ev && ev.hours.find((x) => x[0] === l);
        return !h || h[1] === '–' ? 'u' : h[1] === 'twilight' ? 't' : { GO: 'g', TRY: 'y' }[h[1]] || 'n';
      };
      const realCls = (h) => (h[2] <= 40 ? 'g' : h[2] <= 70 ? 'y' : 'n');
      const aur = (l) => {
        const v = cam && cam[l.slice(0, 2)];
        return v && camWord(v) === 'aurora' ? ' aur' : v && camWord(v) === 'possible aurora' ? ' aur maybe' : '';
      };
      const cols = `grid-template-columns:repeat(${axis.length},1fr)`;
      const j = judge(r, 'forecast');
      const head = !j ? '<span class="vres u">no evening forecast recorded</span>'
        : j.early ? '<span class="vres u">evening forecast had no hours yet</span>'
        : j.ok ? '<span class="vres ok">✓ forecast right</span>' : '<span class="vres n">✕ forecast wrong</span>';
      const real = runs(o.hours.map((h) => h[1] <= -12 && h[2] <= 40));
      const camTxt = !cam ? (r.spot === 'Tromsø' ? 'camera: no record' : 'no camera nearby')
        : (() => { const a = Object.keys(cam).filter((h) => camWord(cam[h]) === 'aurora').sort(hourOrder); return a.length ? `camera saw aurora ${span(a)}` : 'camera saw no aurora'; })();
      const hp = o.hp30_max_dark;
      const act = hp == null ? '' : `activity up to Hp30 ${hp.toFixed(1)} (${o.kp_needed} needed: ${hp >= o.kp_needed ? 'enough' : 'too weak'})`;
      const earlier = LEADS.slice(1).map(([key, label]) => {
        const x = judge(r, key);
        if (!x) return '';
        return x.early ? `${label}: ${pct(x.f.score)} ${x.f.rating}, too early for hours`
          : `${label} ${x.ok ? '✓' : '✕'} (${x.said})`;
      }).filter(Boolean);
      return `<div class="vcard">
        <div class="vhead"><b>${shortDay(r.date)} · ${esc(r.spot)}</b>${head}</div>
        <div class="vlab">Said that evening</div>
        <div class="vstrip" style="${cols}">${axis.map((l) => `<i class="${fcCls(l)}"></i>`).join('')}</div>
        <div class="vlab">What happened</div>
        <div class="vstrip" style="${cols}">${o.hours.map((h) => `<i class="${realCls(h)}${h[1] > -12 ? ' tw' : ''}${aur(h[0])}"></i>`).join('')}</div>
        <div class="vaxis" style="${cols}">${axis.map((l) => `<span>${l.slice(0, 2)}</span>`).join('')}</div>
        <div class="vtext">Said: ${j && !j.early ? j.said : '–'} · Happened: ${real.length ? `clear ${runText(axis, real)}` : 'no clear stretch'} · ${camTxt}${act ? ` · ${act}` : ''}</div>
        ${earlier.length ? `<div class="vtext why">Earlier forecasts: ${earlier.join(' · ')}</div>` : ''}
      </div>`;
    };
    const clearNights = recs.filter((r) => runs(r.observed.hours.map((h) => h[1] <= -12 && h[2] <= 40)).length).length;
    return `
      <details class="vwrap" id="ver"><summary><b>How did it go? Past nights</b> <span class="why">· evening forecast right on ${score('forecast')}</span></summary>
      <p class="vsum">The evening forecast got the clouds right on <b>${score('forecast')}</b> nights · 1 day before <b>${score('forecast_1d')}</b> · 2 days before <b>${score('forecast_2d')}</b>. A clear stretch happened on <b>${clearNights} of ${recs.length}</b> nights (Tromsø and Alta together).</p>
      <p class="hint" style="margin-top:0"><b>Right</b> = it said a clear stretch (2+ dark hours ≤40% cloud) and there was one at that time, or it said none and there was none. Forecasts made before MET's hourly forecast reached the night are shown but not counted.</p>
      <div class="vlegend"><span><b class="g"></b>go / clear ≤40%</span><span><b class="y"></b>maybe / broken ≤70%</span><span><b class="n"></b>no / cloudy</span><span><b class="t"></b>twilight</span><span><b class="g aur"></b>camera saw aurora (Tromsø)</span></div>
      <div class="vgrid">${recs.map(card).join('')}</div>
      <p class="hint">Upper strip: the forecast's verdict for each hour that evening (the run before 20:00). Lower strip: MET Norway's analysed cloud afterwards (from its latest runs, not a satellite photo); faded = twilight. Camera = the Tromsø all-sky camera AI (checked several times an hour since 2 Oct, once an hour before). Hp30 = strongest half hour of planetary activity in the dark hours.</p>
      </details>`;
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
  const tzName = (lat) => (tzOff(lat) === 1 ? ' UK time' : ' ship time');
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
      html = `<b>Not sailing yet.</b> Departure from ${esc(s.name)} ${localDay(s.depart, s.lat)} ${localHm(s.depart, s.lat)}${tzName(s.lat)} (${inTime(s.depart)}).`;
    } else if (now > end) {
      html = '<b>Cruise completed.</b> Welcome home!';
    } else {
      const port = stops.find((s) => s.arrive && s.depart && now >= new Date(s.arrive) && now <= new Date(s.depart));
      if (port) {
        html = `<b>Now: in ${esc(port.name)}.</b> Departs ${localDay(port.depart, port.lat)} ${localHm(port.depart, port.lat)}${tzName(port.lat)} (${inTime(port.depart)}).`;
      } else {
        const next = stops.find((s) => s.arrive && new Date(s.arrive) > now);
        html = next ? `<b>Now: at sea</b> → ${esc(next.name)}, arriving ${localDay(next.arrive, next.lat)} ${localHm(next.arrive, next.lat)}${tzName(next.lat)} (${inTime(next.arrive)}).` : '<b>Now: at sea.</b>';
      }
    }
    el.innerHTML = `<span class="dot"></span>${html} <span class="why">From the published schedule, not live tracking.</span>`;
  }

  // ------------------------------------------------------------ weather in port
  let wxPort = null;
  const WX_ICON = (sym) => (sym ? `<img class="wxi" src="https://cdn.jsdelivr.net/gh/metno/weathericons@main/weather/svg/${encodeURIComponent(sym)}.svg" alt="${esc(sym.replace(/_/g, ' '))}" loading="lazy">` : '');
  const r1 = (v) => (v == null ? '–' : (Math.round(v * 10) / 10).toString());
  const r0 = (v) => (v == null ? '–' : Math.round(v).toString());
  const r0range = (a, b) => (r0(a) === r0(b) ? r0(a) : `${r0(a)}–${r0(b)}`); // never "13–13"
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
  const wxSummaryLine = (s) => (s ? `${r0range(s.t_min, s.t_max)} °C · feels ${r0(s.feels_min)} °C · gusts up to ${kmh(s.gust_max)} km/h · rain ${r1(s.precip_total)} mm${s.snow || s.sleet ? ' · <b>snow/sleet</b>' : ''}${s.thunder_max >= 10 ? ' · thunder' : ''}` : '');
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
         ${c ? `<div class="farbox"><div class="fb"><div class="k">Typical for this day (2011–2025)</div><div class="v">${r0range(c.temp_min_mean, c.temp_max_mean)} °C</div><div class="s">feels about ${r0(c.feels_mean)} °C on average · wind ${kmh(c.wind_mean)} km/h, gusts up to ~${kmh(c.gust_p90)} km/h</div></div>
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

  // Put the page at a spot once it is built, again when late content (charts, pictures) has grown above it;
  // a touch or the wheel in between means the user took over.
  function settle(getY) {
    let userMoved = false;
    const stop = () => { userMoved = true; };
    window.addEventListener('touchstart', stop, { once: true, passive: true });
    window.addEventListener('wheel', stop, { once: true, passive: true });
    for (const ms of [0, 250, 1200]) setTimeout(() => { if (!userMoved) window.scrollTo({ top: getY(), behavior: 'instant' }); }, ms);
  }

  function navSpy() {
    trackHeader();
    document.querySelectorAll('#tabs a').forEach((a) => a.addEventListener('click', (ev) => {
      const el = document.querySelector(a.getAttribute('href'));
      if (!el) return;
      ev.preventDefault();
      if (a.getAttribute('href') === '#check') { const p = $('#check-panel'); if (!p.open) p.open = true; }
      scrollToY(yOf(el)); // no #section in the address: a reload would jump there instead of staying put
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
    document.querySelectorAll('main section, #mag').forEach((s) => obs.observe(s));
  }

  // ------------------------------------------------------------ basic view
  // One screen, no explanations: tonight's answer with an hour strip, "right now", the next nights and
  // last night. Advanced = the full page. The choice is remembered on this device; Basic is the default.
  let MODE = 'basic';
  try { MODE = localStorage.getItem('aurora-mode') || 'basic'; } catch { /* private mode: stay basic */ }
  const LIVE = {}; // live values the basic view reuses: OVATION overhead, cloud drift

  function applyMode() {
    document.body.classList.toggle('basic-mode', MODE === 'basic');
    document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === MODE));
    if (MODE === 'basic') safe(renderBasic);
  }
  function setMode(m, then) {
    MODE = m;
    try { localStorage.setItem('aurora-mode', m); } catch { /* ignore */ } // the choice is remembered on this device
    applyMode();
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (then) setTimeout(then, 50);
  }
  const basicRefresh = () => { if (MODE === 'basic') safe(renderBasic); };

  // "Tonight" = the night in progress until its darkness ends at its place (nightEnd), then the coming night.
  // Before the cruise nights it is Tromsø (practice, from the model check); after the last one there is none (n: null).
  function basicTonight() {
    const first = D.nights[0].date, last = D.nights[D.nights.length - 1].date;
    const pick = (date) => {
      const cruise = D.nights.find((n) => n.date === date);
      if (cruise) return { date, n: cruise, practice: false };
      const mc = date < first && D.model_check ? D.model_check.nights.find((n) => n.date === date && n.spot === 'Tromsø') : null;
      return { date, n: mc || null, practice: date < first };
    };
    const s = shipDate(Date.now());
    if (s.getUTCHours() < 12) s.setUTCDate(s.getUTCDate() - 1);
    const t = pick(s.toISOString().slice(0, 10));
    if (t.n && nightEnd(t.n) > Date.now()) return t;
    s.setUTCDate(s.getUTCDate() + 1);
    const next = pick(s.toISOString().slice(0, 10));
    return next.n || next.date > last ? next : t;
  }
  const cloudRange = (a, b) => (a === b ? `${a}%` : `${a}–${b}%`);

  // Tonight's answer plus its two parts: is there aurora (activity) and can we see it (clouds).
  function basicVerdict(n) {
    const act = n.factors.activity;
    const kp = n.activity.kp != null ? n.activity.kp.toFixed(1) : '?';
    const aur = act >= 0.5 ? { cls: 'ok', word: '✓ Active' } : act >= 0.25 ? { cls: 'mid', word: 'Borderline' } : { cls: 'bad', word: '✕ Too weak' };
    const kps = n.hourly.filter((h) => h.dark).map((h) => h.kp);
    const lo = kps.length ? Math.min(...kps).toFixed(1) : kp, hi = kps.length ? Math.max(...kps).toFixed(1) : kp;
    aur.sub = `Kp ${lo === hi ? lo : `${lo}–${hi}`} tonight · ${n.kp_req <= 1 ? `${n.kp_req.toFixed(1)} is enough here` : `about ${n.kp_req.toFixed(0)} needed here`}`;
    if (!metCovers(n)) {
      const p = n.clear.p;
      const sky = { cls: p >= 0.5 ? 'ok' : p >= 0.25 ? 'mid' : 'bad', word: `${pct(p)} clear chance`,
        sub: `hour by hour ${metFromText(n) ? `from ${metFromText(n)}` : 'later'}` };
      return { cls: ratingCls(n.rating), big: pct(n.score), small: 'chance', aur, sky, line: 'Too far ahead for hour-by-hour clouds yet.' };
    }
    // the dark hours still to come (all of them before the night starts): what is over is not tonight's answer any more
    const all = n.hourly.filter((h) => h.dark && h.cloud_met != null);
    const hrs = all.filter(hourAhead);
    const rest = hrs.length < all.length ? 'for the rest of the night' : 'all night';
    const clearH = hrs.filter((h) => h.cloud_met <= CLEAR_LINE).length;
    const range = (hh) => { const c = hh.map((h) => Math.round(h.cloud_met)); return `${cloudRange(Math.min(...c), Math.max(...c))} cloud`; };
    const win = bestWindow(n);
    let sky;
    if (win) {
      const inWin = win.hours;
      sky = inWin.every((h) => h.cloud_met <= CLEAR_LINE)
        ? { cls: 'ok', word: '✓ Clear gap', sub: `${range(inWin)} ${win.text}` }
        : { cls: 'mid', word: 'Partly cloudy', sub: `${range(inWin)} ${win.text}` };
    } else if (hrs.some((h, i) => i > 0 && h.cloud_met <= CLEAR_LINE && hrs[i - 1].cloud_met <= CLEAR_LINE && new Date(h.t) - new Date(hrs[i - 1].t) === 3600e3)) {
      sky = { cls: 'ok', word: '✓ Clear', sub: `${clearH} of ${hrs.length} dark hours ≤40% cloud${hrs.length < all.length ? ' still to come' : ''}` };
    } else if (clearH) {
      // single clear hours only: no 2-hour gap, so no window (the clear-gap rule everywhere on the page)
      sky = { cls: 'mid', word: 'Mostly cloudy', sub: `only single clear hours: ${span(hrs.filter((h) => h.cloud_met <= CLEAR_LINE).map((h) => h.local))}` };
    } else {
      sky = { cls: 'bad', word: '✕ Cloudy', sub: hrs.length ? `${range(hrs)} ${rest}` : 'no clear hour' };
    }
    const line = !win && sky.word === 'Mostly cloudy' ? 'Only single clear hours: a short gap at best, no clear stretch.'
      : aur.cls === 'ok' && sky.cls === 'bad' ? 'The aurora is there, the clouds hide it.'
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
  function basicChange(date, v) {
    const runs = (TLOG && TLOG[date]) || [];
    if (runs.length < 2) return '';
    const key = (r) => `${r.verdict}|${r.window || ''}`;
    const now = runs[runs.length - 1];
    // the robot's latest answer must still be the one on the card: when a window has ended since its last run,
    // the card already says something else and an older "now" would contradict it
    const shown = v.big === 'GO' || v.big === 'MAYBE' ? `${v.big}|${v.small}` : v.big === 'NO' ? 'NO|' : 'far|';
    if (key(now) !== shown) return '';
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

  // Aurora now, from the nearby FMI magnetometers when there are any (up north), else Hp30 and the NOAA model.
  // Never "quiet": a calm field only means no substorm right now; quiet arcs are common at these latitudes, so a calm
  // field is "Possible" when the measured activity (Hp30, last hour) is enough for this place, else "Low".
  function basicAuroraNow() {
    const [lat, lon] = herePos();
    const need = kpNeedAt(lat, lon);
    if (sunAltAt(new Date(), lat, lon) > -6) return ['day', 'Daylight', 'too bright to see aurora now; check again after dark'];
    const hp = hp30Now();
    const hpTxt = hp != null ? `Hp30 ${hp.toFixed(1)}, ${need.toFixed(1)} needed here` : 'no fresh Hp30';
    const R = Math.PI / 180;
    const km = (x) => 6371 * Math.acos(Math.min(1, Math.sin(lat * R) * Math.sin(x.lat * R) + Math.cos(lat * R) * Math.cos(x.lat * R) * Math.cos((lon - x.lon) * R)));
    const near = Object.values((MAG && MAG.stations) || {})
      .filter((x) => x.series && km(x) <= 300 && Date.now() - new Date(x.t) < 40 * 60e3).sort((a, b) => km(a) - km(b));
    const list = near.map(magPts).filter((p) => p.length);
    if (list.length) {
      const now = Date.now();
      const low = Math.min(...list.map((p) => Math.min(...p.filter(([t]) => t > now - 1800e3).map((q) => q[1]), 0)));
      if (low <= -200 || near.some((s) => s.swing_60 >= 200)) return ['strong', 'Strong', `magnetometer ${nT(low)} nT: big display overhead`];
      const ev = substormTimes(list, eveningFrom());
      const recent = ev.filter((t) => t > now - 1800e3);
      if (recent.length) return ['active', 'Active', `substorm on the magnetometer at ${hm(new Date(recent[recent.length - 1]))}: aurora moving now`];
      // charging: a slow rise of the nearest station since tonight's last substorm (or since 16:00)
      const p0 = list[0];
      const since = p0.filter(([t]) => t >= (ev.length ? ev[ev.length - 1] : eveningFrom()));
      if (since.length) {
        const peak = since.reduce((b, p) => (p[1] > b[1] ? p : b));
        const rise = p0.map((p, i) => [p[0], d10At(p0, i)]).filter(([t]) => t >= peak[0] - 3600e3 && t <= peak[0]).map((q) => q[1]);
        if (peak[1] >= 40 && Math.max(...rise) < SLOW_RISE) {
          return ['charging', 'Charging ↑', `magnetometer rose slowly to ${nT(peak[1])} nT at ${hm(new Date(peak[0]))} (now ${nT(p0[p0.length - 1][1])}): energy is building, a substorm often follows later in the night`];
        }
      }
      // a calm field: tonight's substorm (if any) for context, Hp30 for "enough here"
      let after = '';
      if (ev.length) {
        let s = ev[ev.length - 1];
        for (let k = ev.length - 1; k >= 0 && s - ev[k] <= 1800e3; k--) s = ev[k];
        after = ` · after the ${hm(new Date(s))}–${hm(new Date(ev[ev.length - 1]))} substorm; another one can follow`;
      }
      if (hp == null) return ['quiet', 'No data', `calm field, no fresh Hp30${after}`];
      return hp >= need ? ['possible', 'Possible', `calm field (no substorm now), but the activity is enough here: ${hpTxt}; look north if the sky is clear${after}`]
        : ['low', 'Low', `calm field, and the activity is below what this place needs: ${hpTxt}${after}`];
    }
    // no magnetometer nearby (the southern ports): Hp30 and the NOAA model
    if (hp == null) return (LIVE.ov || 0) >= 20 ? ['active', 'Active', `NOAA model: ${LIVE.ov}% overhead`] : ['quiet', 'No data', 'no fresh Hp30'];
    if (hp >= need + 1.5 || (LIVE.ov || 0) >= 20) return ['active', 'Active', hpTxt];
    return hp >= need ? ['possible', 'Possible', hpTxt] : ['low', 'Low', hpTxt];
  }

  function basicSky(n) {
    const now = Date.now();
    const drift = LIVE.from ? ` · new clouds come from the ${LIVE.from}` : '';
    const h0 = n && n.hourly.find((h) => Math.abs(new Date(h.t) - now) <= 1800e3 && h.cloud_met != null);
    if (!h0) {
      // daytime: tonight's sky in one line
      const dark = n ? n.hourly.filter((h) => h.dark && h.cloud_met != null) : [];
      if (!n) return ['', '–', 'no night to forecast'];
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

  function basicShip(t) {
    const s = shipNow();
    if (s.phase === 'over') return ['Home', 'the cruise is over'];
    if (!s.sailing) {
      // calendar days in ship time, the same count as the morning notification
      const days = Math.round((new Date(shipDate(D.trip.start).toISOString().slice(0, 10)) - new Date(shipDate(Date.now()).toISOString().slice(0, 10))) / 864e5);
      const from = D.trip.stops[0];
      if (days <= 0) return ['Sailing today', `from ${esc(from.name)} at ${hm(D.trip.start)} ship time (${localHm(D.trip.start, from.lat)} local time there)`];
      return [`${days} day${days > 1 ? 's' : ''} to go`, t && t.practice ? 'until then "tonight" is Tromsø, for practice' : 'the cruise nights start tonight'];
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
    const rows = h.series.filter((e) => new Date(e.t).getTime() + 3600e3 > Date.now()).filter((_, i) => i % 2 === 0); // from the current hour
    if (!rows.length) return '';
    // the places of the rows shown: Tromsø while practising, then the ship's planned position hour by hour
    const places = [...new Set(rows.map((e) => e.place))];
    const practice = places.every((p) => /^Tromsø/.test(p)) && (h.practice ?? !h.sailing);
    const where = practice ? 'Tromsø, the practice spot until the cruise starts'
      : places.some((p) => /practice/.test(p)) ? `hour by hour: ${esc(places.join(' → '))}` : `where the ship will be each hour: ${esc(places.join(' → '))}`;
    return `<div class="b-card tapgo" data-go="weather" role="button" tabindex="0"><div class="b-k">Weather here · next 24 hours</div>
      <div class="bplace-s" style="margin-top:4px">${where}</div>
      <div class="wx-sum">${wxSummaryLine(h.summary)}</div>${adviceChips(h.advice)}${wxTable(rows, 65)}
      <p class="hint" style="margin:6px 0 0">Every 2nd hour shown · MET Norway · updated with each forecast run.</p></div>`;
  }

  // Last night, put together on the page from what is already loaded (camera AI log, Hp30, magnetometer,
  // the evening's forecast, MET's cloud analysis when it has arrived), so it is there as soon as the night ends.
  function basicPrevNight(t) {
    if (!t) return null;
    const d0 = new Date(t.date + 'T12:00:00Z');
    d0.setUTCDate(d0.getUTCDate() - 1);
    return nightResult(d0.toISOString().slice(0, 10));
  }

  // What happened on a finished night: before the cruise the practice night in Tromsø, else the cruise night at
  // the ship's position. One verdict for the basic "Last night" card and the advanced PAST cards.
  function nightResult(date) {
    const cruiseN = D.nights.find((n) => n.date === date);
    if (!cruiseN && date > D.nights[0].date) return null; // after the cruise nights: nothing to tell
    const [lat, lon, place] = cruiseN ? [cruiseN.lat, cruiseN.lon, shortPlace(cruiseN.place)] : [69.65, 18.96, 'Tromsø'];
    const R = Math.PI / 180;
    const km = (la, lo) => 6371 * Math.acos(Math.min(1, Math.sin(lat * R) * Math.sin(la * R) + Math.cos(lat * R) * Math.cos(la * R) * Math.cos((lon - lo) * R)));
    const sky = (SKY && SKY.nights && SKY.nights[date]) || {};
    const cams = CAMS.map(([id, name, la, lo]) => ({ id, name: name.replace(' camera', ''), km: km(la, lo), hrs: sky[id] }))
      .filter((c) => c.hrs && c.km <= 300).sort((a, b) => a.km - b.km);
    const here = cams.find((c) => c.km <= 60) || null;
    const words = (c) => Object.keys(c.hrs).sort(hourOrder).map((h) => [h, camWord(c.hrs[h])]);
    const auroraH = (c) => words(c).filter(([, w]) => w.includes('aurora')).map(([h]) => h);
    const hereA = here ? auroraH(here) : [];
    const hereClear = here ? words(here).filter(([, w]) => w === 'clear' || w.includes('aurora')).map(([h]) => h) : [];
    const hereCloudy = here ? words(here).filter(([, w]) => w === 'cloudy').map(([h]) => h) : [];
    const nearby = cams.filter((c) => c !== here && auroraH(c).length);
    // how often the camera log was checked that night (several times an hour since 2 Oct 2026, once an hour before;
    // the alert workflow is due every 10 minutes, GitHub starts it every 15-30)
    const every = here && Object.values(here.hrs).some((v) => v.n) ? 'several times an hour' : 'once an hour';
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
    // MET's analysis of the clouds afterwards
    const obs = cruiseN ? LOG && LOG.nights && LOG.nights[date] && LOG.nights[date].observed
      : VER && VER.nights && VER.nights[`${date}|Tromsø`] && VER.nights[`${date}|Tromsø`].observed;
    const metClear = obs ? obs.clear_dark : null;
    const metDark = obs && obs.hours ? obs.hours.filter((r) => r[1] <= -12 && r[2] != null) : [];
    const metClearH = metDark.filter((r) => r[2] <= CLEAR_LINE).map((r) => r[0].slice(0, 2));
    const metCloudyH = metDark.filter((r) => r[2] > CLEAR_LINE).map((r) => r[0].slice(0, 2));
    // activity that night against what this place needed (not an absolute quiet/active: Hp30 1.7 is plenty in Tromsø)
    const needHere = obs && obs.kp_needed != null ? obs.kp_needed : kpNeedAt(lat, lon);
    const enough = top ? top[1] >= needHere : magMin != null && magMin <= -50;
    const act = [top ? `${top[0]} max ${top[1].toFixed(1)}: ${top[1] >= needHere ? 'enough' : 'too weak'} here (${needHere.toFixed(1)} needed)` : '',
      magMin != null && magMin <= -50 ? `magnetometer ${magMin} nT` : ''].filter(Boolean).join(', ');
    // at sea there is no place name to put in a sentence: talk about the ship instead; in port, the port's name
    const atSea = /^At sea/.test(place) || !!(cruiseN && cruiseN.state === 'sea');
    const port = place.replace(/ →.*$/, '');
    const skyAt = atSea ? 'the sky over the ship' : port;
    // "clear" like everywhere on the page: at least 2 consecutive clear hours (a single clear hour is not a gap)
    const gap = (hh) => hh.some((h, i) => i > 0 && (+hh[i - 1].slice(0, 2) + 1) % 24 === +h.slice(0, 2));
    const clearHere = here ? gap(hereClear) : metClear ? gap(metClear) : null;
    // tiles
    const aur = hereA.length ? { cls: 'ok', word: '✓ Overhead', sub: `${here.name} camera: aurora ${span(hereA)}${act ? ' · ' + act : ''}` }
      : nearby.length ? { cls: 'mid', word: 'Seen nearby', sub: `${act ? act + ' · ' : ''}cameras: ${nearby.map((c) => `${c.name} ${span(auroraH(c))}`).join(', ')}` }
      : cams.length ? { cls: 'bad', word: 'None seen', sub: act || "no aurora in the cameras' checks" }
      : { cls: act ? (enough ? 'ok' : 'bad') : 'mid', word: act ? (enough ? '✓ Strong enough' : '✕ Too weak') : 'No data', sub: act || 'no camera nearby' };
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
    const line = hereA.length ? `Aurora was out over ${port} and the camera saw it: hope you did too!`
      : nearby.length && here && hereClear.length ? `Aurora was out over ${names}, but the ${here.name} camera's checks (${every}) found none, not even in its clear hour${hereClear.length > 1 ? 's' : ''} (${span(hereClear)}).`
      : nearby.length && clearHere === false ? `Aurora was out over ${names}, but ${skyAt} was cloudy.`
      : nearby.length && clearHere ? `Aurora was out nearby (${names}) and the sky here had clear hours: low in the north it may have been visible.`
      : here ? (clearHere ? `Clear sky, but no aurora in the camera's checks (${every}).` : `Cloudy, and no aurora in the camera's checks (${every}).`)
      : clearHere == null ? 'No camera here; the cloud analysis is not in yet.'
      : !clearHere ? `${metClear && metClear.length ? `No 2-hour clear gap, only single clear hours (${span(metClear.map((h) => h.slice(0, 2)))})` : 'No clear dark hours'}${vs ? ` (${vs})` : ''}: nothing to see.`
      : strong ? `No camera here to confirm it, but it was ${clearTxt} and activity was strong enough (${vs}): aurora was possible.`
      : `It was ${clearTxt}, but activity was too weak for this latitude${vs ? ` (${vs})` : ''}.`;
    // the evening's forecast and whether it was right about the clouds
    const runs = (TLOG && TLOG[date]) || [];
    const ev = runs.filter((r) => new Date(r.t) < new Date(date + 'T19:00:00Z')).pop() || runs[0];
    let fc = '';
    if (ev) {
      const said = ev.verdict === 'far' ? `${pct(ev.score)} chance` : `${ev.verdict}${ev.window ? ' ' + ev.window : ''}${ev.cloud ? ` (${cloudRange(ev.cloud[0], ev.cloud[1])} cloud)` : ''}`;
      // judged only when the evening answer was about the clouds: GO / MAYBE = a clear gap expected,
      // NO without a single clear hour forecast = cloudy (a NO for weak activity says nothing about the clouds)
      const aboutClouds = ev.verdict === 'GO' || ev.verdict === 'MAYBE' || (ev.verdict === 'NO' && ev.cloud && ev.cloud[0] > CLEAR_LINE);
      const right = clearHere == null || !aboutClouds ? '' : ((ev.verdict === 'NO') === !clearHere ? ' · <span class="ok">✓ right</span>' : ' · ✕ wrong about the clouds');
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
    const camTxt = (c, v) => (v ? `${esc(c.name)} camera: <b>${camWord(v)}</b> (AI: aurora ${v.aurora}%, clear ${v.clear}%, cloud ${v.cloudy}%${v.n > 1 ? `; the most auroral of ${v.n} pictures` : ''})` : `${esc(c.name)} camera: no picture`);
    // the camera's keogram of that night (the whole night in one picture) to check by eye: the place's own camera,
    // else the nearest one; "latest" until the next evening, then the archive (processed about a day later)
    const kc = here || cams[0];
    const keo = kc ? { name: kc.name, url: keogramUrl(kc.id, date) } : null;
    const others = cams.filter((c) => c !== here);
    const why = (i) => {
      const h = hourInfo[i];
      const near = others.filter((c) => c.hrs[h.hh]).map((c) => `${esc(c.name)} ${camWord(c.hrs[h.hh])}`).join(', ');
      const parts = [here ? camTxt(here, here.hrs[h.hh]) : '', h.cloud != null ? `MET analysis ${atSea ? "at the ship's position" : 'for ' + esc(port)}: cloud ${Math.round(h.cloud)}%` : '',
        near ? `cameras nearby: ${near}` : '',
        measChip(h.hp, h.kp, h.need), h.mag != null ? `magnetometer ${h.mag} nT` : ''].filter(Boolean);
      return `<b>${h.hh}:00</b> · ${parts.join(' · ')}`;
    };
    // icon: MET's analysis for this place; without it, what the camera here saw
    const icon = (i) => {
      const h = hourInfo[i];
      const v = here && here.hrs[h.hh];
      const cl = h.cloud != null ? Math.round(h.cloud) : v ? (camWord(v) === 'cloudy' ? 90 : camWord(v) === 'clear' || camWord(v).includes('aurora') ? 10 : null) : null;
      return `<svg class="bico" viewBox="0 0 16 16" aria-hidden="true">${cl != null ? skyGlyph(cl) : UNKNOWN_GLYPH}</svg>`;
    };
    // bar colour: the camera here; without a camera, MET's clouds (twilight = too bright)
    const bar = (hh) => {
      if (here) return here.hrs[hh] ? cls[camWord(here.hrs[hh])] : 'na';
      if (metAt[hh] == null) return 'na';
      return sunAt[hh] > -12 ? 'm' : metAt[hh] <= CLEAR_LINE ? 'cl' : 'c';
    };
    const hasStrip = !!here || Object.keys(metAt).length > 0;
    const strips = hasStrip ? `<div class="rowlab">${esc(here ? `${here.name} camera, hour by hour` : `${atSea ? "At the ship's position" : port}: clouds afterwards (MET analysis), hour by hour`)}</div>
      <div class="pstrip" data-row="0">${HOURS.map((h, i) => `<div data-i="${i}" role="button" tabindex="0">${icon(i)}<i class="${bar(h)}"></i>${h}</div>`).join('')}</div>
      <div class="bwhy" id="b-lastwhy"><span class="btap">👆 Tap an hour to see what happened</span></div>
      <div class="blegend">${here ? '<span><b class="a"></b>aurora</span>' : ''}<span><b class="cl"></b>clear${here ? ', no aurora' : ' (≤40%)'}</span><span><b class="c"></b>cloudy</span><span><b class="m"></b>${here ? 'bright (moon / twilight)' : 'twilight (too bright)'}</span><span>? = clouds not known (yet)</span></div>` : '';
    const head = `${big[1]}${big[0] === 'n' ? ' here' : ': ' + big[2]}`;
    const needM = need ?? kpNeedAt(lat, lon);
    const measured = top ? `${top[0]} max ${top[1].toFixed(1)} → ${top[1] >= needM ? 'enough' : 'below'} (${needM.toFixed(1)} needed here)` : '';
    return { date, place, practice: !cruiseN, skyHead: atSea ? 'Sky at the ship' : `Sky in ${port}`, big, head, aur, sky: skyT, line, fc, alerts, strips, keo,
      here, measured, why: (i) => why(i), short: `${head} · ${line}` };
  }

  function prevNightCard(P) {
    return `<div class="b-card" id="b-last"><div class="b-k">Last night · ${dayLabel(P.date)} <span class="btag">MORNING</span> <span class="bgo" data-go="last" role="button" tabindex="0">Details ›</span></div>
      <div class="bplace">📍 ${esc(P.place)}</div>
      <div class="bplace-s">${P.practice ? 'practice spot until the cruise starts' : 'where the ship was that night, from the published itinerary'}</div>
      <div class="b-big"><span class="b-sym ${P.big[0]}">${{ g: '✓', y: '?', n: '✕', u: '…' }[P.big[0]]}</span><span class="b-verdict">${esc(P.big[1])} <small>${esc(P.big[2])}</small></span></div>
      <div class="bfx">${[['Aurora', P.aur], [P.skyHead, P.sky]].map(([k, f]) =>
        `<div class="bf ${f.cls}"><div class="h">${esc(k)}</div><div class="w">${esc(f.word)}</div><div class="s">${esc(f.sub)}</div></div>`).join('')}</div>
      <div class="bline">${esc(P.line)}</div>
      ${P.fc ? `<div class="b-sub">${P.fc}${P.alerts ? ` · alerts: ${esc(P.alerts)}` : ''}</div>` : ''}
      ${P.strips}
      ${P.keo ? `<div class="b-sub" style="margin-top:6px"><a href="${esc(P.keo.url)}" target="_blank" rel="noopener">${esc(P.keo.name)} camera: the whole night in one picture (keogram) ↗</a></div>` : ''}
    </div>`;
  }

  // ------------------------------------------------------------ basic → the advanced part that explains it
  // (user's list, 2 Oct 2026). The target is looked up again at every scroll step: the model check panel renders
  // when it opens, which replaces its contents.
  const scrollToFind = (find) => scrollToY(() => {
    const e = find();
    return e ? Math.max(0, e.getBoundingClientRect().top + window.scrollY - headerOffset()) : window.scrollY;
  });
  // Tonight's night: the cruise night's detail on board, the model check's Tromsø night before the cruise.
  // part: 'chart' (Kp forecast vs need), 'hours' (Hour by hour), 'inland' (the inland table)
  function explainTonight(t, part) {
    let root;
    if (t.practice) {
      const mc = D.model_check;
      const days = (mc && (mc.days || [mc.date])) || [];
      checkDay = Math.max(0, days.indexOf(t.date));
      checkSpot = Math.max(0, checkNights().findIndex((n) => n.spot === 'Tromsø'));
      const cp = $('#check-panel');
      if (cp.open) safe(renderCheck); else cp.open = true; // its toggle listener renders it
      root = () => $('#check-detail');
    } else {
      selected = t.date;
      renderCards();
      renderDetail();
      root = () => $('#night-detail');
    }
    const find = () => {
      const r = root();
      if (!r) return null;
      const h3 = [...r.querySelectorAll('h3')].find((x) => /^Hour by hour/.test(x.textContent));
      return (part === 'chart' ? r.querySelector('.chart') : part === 'inland' ? r.querySelector('.inl') : h3) || r;
    };
    setTimeout(() => scrollToFind(find), 100);
  }
  // Last night: the past cruise night's detail on board, the "Last night up north" panel before the cruise
  function explainLast(P) {
    if (P && D.nights.some((n) => n.date === P.date)) {
      selected = P.date;
      renderCards();
      renderDetail();
      scrollToFind(() => $('#night-detail'));
      return;
    }
    const ln = $('#last-night');
    if (ln) ln.open = true;
    scrollToFind(() => $('#last-night'));
  }

  function renderBasic() {
    const el = $('#basic');
    if (!el || !D) return;
    const t = basicTonight();
    const s = shipNow();
    const nightsOver = t && t.date > D.nights[D.nights.length - 1].date;
    let tonight = `<div class="b-card"><div class="b-k">Tonight</div><div class="b-sub" style="margin-top:6px">${
      nightsOver || Date.now() > new Date(D.trip.end) ? 'The cruise nights are over. All of them are under Advanced.' : 'No forecast for tonight yet.'}</div></div>`;
    if (t && t.n) {
      const v = basicVerdict(t.n);
      tonight = `<div class="b-card">
        <div class="b-k">Tonight · ${dayLabel(t.n.date)}</div>
        <div class="bplace">📍 ${esc(t.practice ? 'Tromsø' : shortPlace(t.n.place))}</div>
        <div class="bplace-s">${t.practice ? 'practice spot until the cruise starts' : "where the ship is tonight, from the published itinerary (not live GPS)"}</div>
        ${stormBasic(t.n)}
        <div class="b-big"><span class="b-dot ${v.cls}"></span><span class="b-verdict">${v.big} <small>${esc(v.small)}</small></span></div>
        <div class="bfx">${[['Aurora', v.aur], ['Sky', v.sky]].map(([k, f]) =>
          `<div class="bf ${f.cls} tapgo" data-go="${k === 'Aurora' ? 'aurora' : 'sky'}" role="button" tabindex="0"><div class="h">${k}</div><div class="w">${esc(f.word)}</div><div class="s">${esc(f.sub)}</div></div>`).join('')}</div>
        ${inlandBasic(t.n)}
        <div class="bline">${esc(v.line)}</div>
        ${basicChange(t.n.date, v) ? `<div class="bchange">↻ ${esc(basicChange(t.n.date, v))}</div>` : ''}
        <div class="b-sub">${esc(darkText(t.n))}</div>
        ${basicStrip(t.n)}</div>`;
    }
    const [acls, aword, atxt] = basicAuroraNow();
    const [scls, sword, stxt] = basicSky(t && t.n);
    const [shipword, shiptxt] = basicShip(t);
    const tile = (k, v, cls, txt, go) => `<div class="nt${go ? ' tapgo' : ''}"${go ? ` data-go="${go}" role="button" tabindex="0"` : ''}><div class="b-k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${txt}</div></div>`;
    const upcoming = D.nights.filter((n) => !isPast(n) && n.date !== (t && t.date));
    // Last night: a full card above tonight in the morning (until noon), one line further down later in the day
    const P = basicPrevNight(t);
    const morning = shipDate(Date.now()).getUTCHours() < 12 && !!t && t.date === shipDate(Date.now()).toISOString().slice(0, 10);
    const hourly = t && t.n && metCovers(t.n) ? `<details class="b-card bhourly" id="b-hourly"><summary>📊 Detailed hourly · ${esc(t.practice ? 'Tromsø' : shortPlace(t.n.place))}, tonight</summary>
        <div class="legend">
          <span><i style="background:#3987e5"></i>Cloud cover, MET Norway (left axis) · below the white 40% line = clear enough</span>
          <span><i class="line" style="background:#e8743b"></i>Kp forecast (right axis)</span>
          <span><i class="line" style="background:repeating-linear-gradient(90deg,#e8743b 0 6px,transparent 6px 10px)"></i>Kp needed here · solid above dashed = strong enough</span>
        </div>
        <div class="chart" id="b-chart"></div>
        ${hoursTable(t.n)}</details>` : '';
    el.innerHTML = `${P && morning ? prevNightCard(P) : ''}${tonight}${hourly}
      ${s.phase === 'over' ? '' : `<div class="b-card"><div class="b-k">Right now · ${hm(Date.now())}</div>
        <div class="now3">${tile('Aurora now', aword, 'a-' + acls, atxt, 'now')}${tile('Sky here', sword, scls, stxt, 'skynow')}${tile(s.sailing ? 'Ship' : 'Cruise', shipword, '', shiptxt, 'ship')}</div></div>`}
      ${!upcoming.length ? '' : `<div class="b-card"><div class="b-k">${s.sailing ? 'Next nights' : 'Cruise nights'} · <span class="btap">tap one for the details</span></div>
        <div class="bnights">${upcoming.map((n) => `<button class="bnc" data-date="${n.date}"><div class="d">${dayLabel(n.date).slice(0, 6)}</div>
          <div class="p">${esc(shortPlace(n.place)).replace(/^At sea · /, 'at sea · ')}</div><div class="v">${pct(n.score)}</div>
          <div class="r" style="color:${RATING_HEX[n.rating]}">${n.rating}</div><div class="bar" style="background:${RATING_HEX[n.rating]}"></div></button>`).join('')}</div></div>`}
      ${P && !morning ? `<div class="b-card tapgo" data-go="last" role="button" tabindex="0"><div class="b-k">Last night · ${dayLabel(P.date)} · ${esc(P.place)}</div><div class="blast">${esc(P.short)}</div>${P.fc ? `<div class="b-sub" style="margin-top:4px">${P.fc}</div>` : ''}</div>` : ''}
      ${basicWeather()}
      <div class="balerts">🔔 ${s.phase === 'over' ? 'Alerts have stopped: the cruise is over.'
        : Date.now() >= new Date(D.trip.start).getTime() - 6 * 3600e3 ? "You'll get a notification when it's time to go out." : 'Test alerts are on until the day of departure.'}</div>
      <details class="bhow"><summary>How is this decided?</summary>
        <p>Tiles and cards marked <b>›</b> open the part of the advanced view that explains them (Tonight's Aurora tile: the Kp forecast against the need; Sky: hour by hour; Aurora now: the live values; Sky here: the satellite picture; Last night: that night's details).</p>
        <p><b>Where</b>: before the cruise, "tonight" is Tromsø, for practice. On board it follows the ship's planned position hour by hour, from Princess' published itinerary: the port while docked, the route between ports at sea. It is not live GPS, so a change of course or schedule is not known here.</p>
        <p><b>Tonight, hour by hour</b> (MET Norway's local forecast, about 2.5 days ahead):
          <span class="k g">go</span> dark, cloud ≤40% and aurora chance ≥50% ·
          <span class="k y">maybe</span> cloud ≤70% and aurora chance ≥25% ·
          <span class="k n">no</span> otherwise ·
          <span class="k t">twilight</span> after sunset, before full darkness: too bright for faint aurora.
          The two tiles under the answer split it in two: <b>Aurora</b> (is the activity strong enough here: active, borderline, too weak) and <b>Sky</b> (clear gap, partly cloudy, cloudy).
          The small icon above each hour shows the clouds only (moon = clear, moon with cloud = broken, cloud = overcast); the colour combines clouds and aurora activity.
          Tap an hour in the strip to see its numbers. The big answer is the green stretch (yellow if there is none) with the best aurora hours: on clear nights aurora is seen most often around midnight (about 85% of clear nights at 23–00 h, 60% at 20 h; Kiruna all-sky camera statistics, the small green bars under the strip). Aurora chance = how likely the forecast activity (Kp) reaches the level needed at that latitude.
          Nights further ahead show the overall chance instead, until MET's forecast reaches them.</p>
        <p><b>Aurora now</b> comes from the nearby magnetometers when there are any (Tromsø and Alta area). It never says "quiet": a calm field only means no substorm right now, and quiet arcs are common up north.
          <b>Strong</b> = 200+ nT: a big display overhead ·
          <b>Active</b> = a substorm in the last half hour (a nearby station 50+ nT below its quiet level, or a jump of 50+ nT within 10 minutes, up or down): aurora is moving now ·
          <b>Charging ↑</b> = in the evening the field has slowly risen 40+ nT above its quiet level: energy is building up, a substorm often follows later in the night (in last season's data 86% of such evenings, usually 01–03 h) ·
          <b>Possible</b> = a calm field, but the measured activity (Hp30, last hour) is enough for this place ·
          <b>Low</b> = a calm field and less activity than this place needs.
          Where there is no magnetometer (further south): <b>Active</b> when Hp30 is 1.5 above the level needed here or the NOAA model shows 20%+ overhead, <b>Possible</b> when it reaches the level, <b>Low</b> below it.
          <b>Daylight</b> = still too bright to see aurora (until about 45 minutes after sunset).</p>
        <p><b>NOAA storm watch</b>: a yellow line when NOAA's 3-day forecast expects storm-level activity (G1 or more, Kp 4.7+) in tonight's dark hours, with its cause and what this place needs. G1 is the lowest of NOAA's five storm levels; up north even quieter activity is enough, so a storm matters most further south. Tap it for the details. </p>
        <p><b>☄️ CME arriving</b>: the front of a solar eruption has reached the satellite that measures the solar wind, 1.5 million km from us; it gets here at the time shown. <i>Weak</i>: little extra aurora. <i>Strong</i>: a storm may follow, above all if Bz turns south.</p>
        <p><b>Inland</b> (Tromsø 15 Oct, Alta 16–17 Oct, and Tromsø for practice): MET's clouds at the usual chase-tour areas behind the coastal mountains, where it is often clearer (from Tromsø: Nordkjosbotn, Skibotn, Kilpisjärvi; from Alta: Gargia, Masi, Kautokeino). "Clearer inland" = one of them has a clear stretch (2+ hours ≤40% cloud) still to come and here has none, or one at least 2 hours shorter. Tap the line for the hours.</p>
        <p><b>Sky here</b>: MET's cloud forecast for this hour: clear ≤40%, partly cloudy ≤70%, cloudy above. "Clearing" or "clouding over" = a change within the next 4 hours. In the daytime it sums up tonight's dark hours. "New clouds come from the north-west" = the wind at about 3 km height, which moves the clouds: look that way on the satellite picture (Advanced › Live) to see what is coming.</p>
        <p><b>Nights</b>: overall chance = aurora × clear sky × darkness × moon and lights. GOOD 40%+, FAIR 25%+, LOW 10%+, POOR below (same colours as in the advanced view).</p>
      </details>
      <a href="#" class="badv" id="b-adv">Advanced view: all numbers, charts and explanations →</a>`;
    if (t && t.n) {
      const hrs = t.n.hourly.filter((h) => h.sun < -3);
      const cells = el.querySelectorAll('.bstrip > div');
      cells.forEach((c) => c.addEventListener('click', () => tapSelect(cells, c, () => basicWhy(hrs[+c.dataset.i], t.n), $('#b-why'), '👆 Tap an hour to see why')));
    }
    el.querySelectorAll('.bnc').forEach((b) => b.addEventListener('click', () => setMode('advanced', () => {
      selected = b.dataset.date;
      renderCards();
      renderDetail();
      scrollToY(yOf($('#night-detail')));
    })));
    $('#b-adv').addEventListener('click', (ev) => { ev.preventDefault(); setMode('advanced'); });
    const bs = $('#b-storm');
    if (bs) bs.addEventListener('click', () => setMode('advanced', () => scrollToY(yOf($('#storm')))));
    const GO = {
      aurora: () => explainTonight(t, 'chart'), sky: () => explainTonight(t, 'hours'), inland: () => explainTonight(t, 'inland'),
      now: () => scrollToFind(() => $('#live')), skynow: () => scrollToFind(() => $('#sat')),
      ship: () => scrollToFind(() => $('#itinerary')), weather: () => scrollToFind(() => $('#weather')), last: () => explainLast(P),
    };
    el.querySelectorAll('[data-go]').forEach((x) => x.addEventListener('click', (ev) => {
      // the hour strips inside a card keep their own taps
      if (ev.target.closest('.bstrip, .pstrip, .bwhy') && x.dataset.go !== 'last') return;
      ev.preventDefault();
      ev.stopPropagation();
      const go = GO[x.dataset.go];
      if (go && (x.dataset.go !== 'aurora' && x.dataset.go !== 'sky' && x.dataset.go !== 'inland' || (t && t.n))) setMode('advanced', go);
    }));
    const bh = $('#b-hourly');
    if (bh) bh.addEventListener('toggle', () => { if (bh.open) drawHourly(t.n, $('#b-chart')); });
    if (P && morning) {
      const cells = el.querySelectorAll('#b-last .pstrip > div');
      cells.forEach((c) => c.addEventListener('click', () => tapSelect(cells, c, () => P.why(+c.dataset.i), $('#b-lastwhy'), '👆 Tap an hour to see what happened')));
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
      SHOCK = await getJSON('data/shock.json').catch(() => null);
      if (D.trip && D.trip.watch_nights) KEY_NIGHTS = D.trip.watch_nights;
      [LOG, LAST, TLOG] = await Promise.all([getJSON('data/cruise_log.json').catch(() => null), getJSON('data/last_night.json').catch(() => null),
        getJSON('data/tonight_log.json').catch(() => null)]);
      HP30 = newerHp30((D.space_weather && D.space_weather.hp30) || [], hpFile && hpFile.series);
    } catch (e) {
      $('#fresh').innerHTML = '<span class="dot bad"></span>data unavailable';
      $('#hero').innerHTML = `<div class="empty">Could not load the forecast data (${esc(e.message)}). Check the connection and reload.</div>`;
      return;
    }
    // Deep link from notifications: ?night=YYYY-MM-DD opens that night's detail, #live a section (used once, see LINK).
    const wanted = LINK.night;
    const linked = D.nights.some((n) => n.date === wanted) ? wanted : null;
    // only the sections of the menu (#live, #mag, ...) count as link targets
    const hashEl = [...document.querySelectorAll('#tabs a')].some((a) => a.getAttribute('href') === LINK.hash) ? document.querySelector(LINK.hash) : null;
    selected = linked || tonightDate() || D.nights.reduce((b, x) => (x.score > b.score ? x : b), D.nights[0]).date;
    [renderFresh, renderPhase, renderHero, renderLastNight, renderCards, renderDetail, renderTrend, renderKp27, renderKp3, renderStorm, renderSwpcText, renderLive, renderSat, renderCams, renderMag, renderMap, markItineraryToday, renderItinNow, renderWeather, navSpy].forEach(safe);
    startLiveRefresh();
    document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    // A notification about another night than tonight opens that night's detail in the advanced view (this visit only,
    // the remembered choice stays); a link to tonight stays on the basic view's Tonight card.
    if (linked && MODE === 'basic') { const t = basicTonight(); if (!(t && t.date === linked)) MODE = 'advanced'; }
    if (hashEl && MODE === 'basic') MODE = 'advanced'; // e.g. a test alert's link to Live
    applyMode();
    // The check panel is collapsed: build it on first open so its chart can measure its width.
    $('#check-panel').addEventListener('toggle', () => { if ($('#check-panel').open) safe(renderCheck); });
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null'); } catch { /* ignore */ }
    if (linked && MODE === 'advanced') settle(yOf($('#night-detail')));
    else if (hashEl && MODE === 'advanced') settle(yOf(hashEl));
    else if (saved && saved.mode === MODE && !LINK.night && !LINK.hash) settle(() => saved.y); // a reload: stay put
    let scrollT = null;
    window.addEventListener('scroll', () => { clearTimeout(scrollT); scrollT = setTimeout(saveScroll, 250); }, { passive: true });
    window.addEventListener('pagehide', saveScroll);

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
