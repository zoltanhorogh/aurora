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
    const toArctic = (new Date('2026-10-13T18:00:00Z') - now) / 864e5;
    const steps = [
      ['Trend', '27-day outlook + climate'],
      ['Early weather', 'ensemble clouds gain weight'],
      ['Sharpening', 'cloud forecasts become useful'],
      ['Final days', 'NOAA 3-day Kp, CME models'],
      ['On board', 'live nowcast + alerts'],
    ];
    const idx = now > end ? 5 : now >= start ? 4 : toArctic > 16 ? 0 : toArctic > 7 ? 1 : toArctic > 3 ? 2 : 3;
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
      <div class="steps">${steps.map((s, i) => `<div class="step ${i < idx ? 'done' : i === idx ? 'now' : ''}"><b>${s[0]}</b><span>${s[1]}</span></div>`).join('')}</div>
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
  function renderCards() {
    const t = tonightDate();
    $('#night-cards').innerHTML = D.nights.map((n) => `
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
      $('#night-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  // Sky cell: icon + word + % on the first line, a 0–100% bar with the 40% line and the distance to it below.
  function sky(cloud, range) {
    if (cloud == null) return '<span class="sky none">no forecast yet</span>';
    const c = Math.round(cloud);
    const [word, cls, icon] = c <= CLEAR_LINE ? ['Clear', 'clear', `<path d="${MOON_SVG}" fill="#dfe6ff"/>`]
      : c <= 70 ? ['Broken', 'broken', `<path d="${MOON_SVG}" fill="#dfe6ff" transform="translate(3 -1) scale(.75)"/><path d="${CLOUD_SVG}" fill="#b4bac4"/>`]
      : ['Overcast', 'overcast', `<path d="${CLOUD_SVG}" fill="#8f96a3"/>`];
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

  function bestWindow(n) {
    const st = n.hourly.map((h) => hourStatus(h)[0]);
    for (const want of ['GO', 'TRY']) {
      let best = null, i = 0;
      while (i < st.length) {
        if (st[i] !== want) { i++; continue; }
        let j = i;
        while (j + 1 < st.length && st[j + 1] === want) j++;
        if (!best || j - i > best[1] - best[0]) best = [i, j];
        i = j + 1;
      }
      if (best) {
        const end = new Date(new Date(n.hourly[best[1]].t).getTime() + 3600e3);
        return { label: want, text: `${n.hourly[best[0]].local}–${hm(end)}` };
      }
    }
    return null;
  }

  // Far nights: no hourly verdicts, just the two numbers that actually mean something that far out.
  function farSummary(n) {
    const c = n.clear;
    return `
      <div class="win none">Verdicts (GO / TRY / NO) appear when MET Norway's local model reaches this night, about 2.5 days before it. Until then the table below shows what the global models say, for orientation only.</div>
      <div class="farbox">
        <div class="fb"><div class="k">Typical October night here</div><div class="v">${c.clim_mean_cloud != null ? Math.round(c.clim_mean_cloud) + '% cloud' : '–'}</div><div class="s">average in the dark hours (clear line: 40%) · a 2+ hour gap under 40% in ${pct(c.p_clim)} of nights (2011–2025)</div></div>
        <div class="fb"><div class="k">Global weather models so far</div><div class="v">${c.p_ens != null ? pct(c.p_ens) + ' of runs' : 'not yet'}</div><div class="s">${c.p_ens != null ? `show a 2+ hour gap under 40% (${c.members} runs, ${c.models.join(' + ')}) · low skill this far out` : 'no model reaches this night yet'}</div></div>
      </div>`;
  }

  function hoursTable(n) {
    const hasMet = n.hourly.some((h) => h.cloud_met != null);
    const rows = n.hourly.filter((h) => h.sun < -3);
    const events = (n.events || []).filter((e) => e.kind === 'depart' || e.kind === 'arrive');
    const win = hasMet ? bestWindow(n) : null;
    let html = `<div class="hr head"><span>Time</span><span>Verdict</span><span>Sky · ${hasMet ? 'MET' : 'models'}</span><span class="kp">Kp fc ≥ need</span></div>`;
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
    const body = `
      ${hasMet ? (win ? `<div class="win ${win.label === 'GO' ? 'go' : 'try'}">★ Best window ${win.text} · ${win.label}</div>` : '<div class="win none">No good window tonight.</div>') : farSummary(n)}
      <div class="hours2">${html}</div>
      <div class="srcline">Cloud source for this night: ${hasMet
        ? '<b>MET Norway (2.5 km local model) only</b>. The global models are not used once MET covers the night.'
        : '<b>global models + October climate</b> (hourly rows: model average, likely range in brackets). MET Norway takes over about 2.5 days before.'}</div>
      <div class="hint">Sky: Clear ≤40% cloud · Broken 40–70% · Overcast &gt;70%. The white mark on each bar is the 40% line.
        <span class="st go">GO</span> dark, activity chance ≥50% and cloud ≤40% ·
        <span class="st try">TRY</span> activity chance ≥25% and cloud ≤70% · <span class="st no">NO</span> otherwise. Exact numbers: "Show all data" below.</div>`;
    return `<h3 style="margin-top:16px">Hour by hour</h3>${sunStrip(n)}${body}`;
  }

  function renderDetail() {
    const n = D.nights.find((x) => x.date === selected);
    if (!n) return;
    $('#night-detail').innerHTML = detailHTML(n, 'hourly-chart');
    drawHourly(n, $('#hourly-chart'));
  }

  // Full night view; also reused 1:1 by the model check panel.
  function detailHTML(n, chartId) {
    const hours = n.hourly;
    const hasMet = hours.some((h) => h.cloud_met != null);
    return `
      <div style="display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-bottom:10px">
        <h3 style="margin:0">${dayLabel(n.date)} · ${esc(shortPlace(n.place))}</h3>${chip(n.rating)}
        <span style="font-size:20px;font-weight:700">${pct(n.score)}</span>${confSig(n.confidence, true)}
      </div>
      <div class="grid2">
        <div>${factorRows(n)}<ul class="notes" style="margin-top:10px">${n.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div>
          <div class="legend">
            <span><i style="background:#3987e5${hasMet ? '' : ';opacity:.35'}"></i>Cloud cover, ${hasMet ? 'MET Norway' : 'global models (low skill)'} (left axis) · below the white 40% line = clear enough</span>
            <span><i class="line" style="background:#e8743b"></i>Kp forecast (right axis)</span>
            <span><i class="line" style="background:repeating-linear-gradient(90deg,#e8743b 0 6px,transparent 6px 10px)"></i>Kp needed here · solid above dashed = strong enough</span>
            <span><i class="band"></i>Dark hours</span>
          </div>
          <div class="chart" id="${chartId}"></div>
          ${hasMet ? '' : '<div class="hint">Faded bars = global models, for orientation only. MET Norway\'s local model replaces them about 2.5 days before the night.</div>'}
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
    // Cloud bars: MET Norway where available (solid), otherwise the global-model average (faded) — same as the table
    hours.forEach((h, i) => {
      const met = h.cloud_met != null;
      const v = met ? h.cloud_met : h.cloud_mean;
      if (v == null) return;
      const cx = ml + i * bw + bw / 2, w = Math.max(5, bw * 0.46);
      g += `<path d="${roundTopBar(cx - w / 2, y(v), w, y(0) - y(v))}" fill="#3987e5" opacity="${met ? 1 : 0.35}"/>`;
    });
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
      <div class="legend"><span><i style="background:#3987e5"></i>Observed / estimated</span><span><i style="background:rgba(57,135,229,.3);border:1.5px solid #3987e5"></i>Forecast</span></div>
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
    cont.innerHTML = svgTag(W, H, '3-hourly Kp', g);
    const hl = cont.querySelector('.hl');
    const bands = rows.map((_, i) => [ml + i * bw, ml + (i + 1) * bw]);
    bindHover(cont, W, bands, (i) => {
      const r = rows[i];
      return `<b>${dayLabel(r.t.slice(0, 10))} ${r.t.slice(11, 16)}–${pad((+r.t.slice(11, 13) + 3) % 24)}:00 UTC</b><div class="row"><span>Kp (${esc(r.kind)})</span><span>${r.kp.toFixed(2)}</span></div>`;
    }, (i) => hlBand(hl, bands, i, mt, ph));
  }

  function renderSwpcText() {
    const sw = D.space_weather;
    const w = sw.weekly || {};
    const cmes = sw.cmes || [];
    $('#swpc-text').innerHTML = `
      <h3>What the forecasters say</h3>
      <p><b>NOAA weekly forecast</b> (${esc(w.period || '')}, issued ${esc(w.issued || '–')}):<br>${esc(w.geomagnetic || 'not available')}</p>
      <p class="hint">Jargon: "CH HSS" = fast solar wind from a coronal hole, the typical source of moderate aurora activity at this stage of the solar cycle. "Unsettled/active" ≈ Kp 3–4, "G1" = Kp 5.</p>
      <p><b>Solar eruptions (CMEs) heading to Earth:</b> ${cmes.length ? '' : 'none in NASA\'s model runs from the last 7 days.'}</p>
      ${cmes.length ? `<ul>${cmes.map((c) => `<li>Arrival ≈ ${esc(dayLabel(c.arrival.slice(0, 10)))} ${hm(c.arrival)} ship time${c.glancing ? ' (glancing blow)' : ''} · expected Kp ${c.kp_min ?? '?'}–${c.kp_max ?? '?'} ${c.link ? `· <a href="${esc(c.link)}" target="_blank" rel="noopener">details</a>` : ''}</li>`).join('')}</ul>` : ''}`;
  }

  // ------------------------------------------------------------ live
  const setTile = (id, v, sub) => { const e = document.getElementById(id); if (e) { e.querySelector('.v').innerHTML = v; e.querySelector('.s').innerHTML = sub; } };

  // Kp level needed for aurora overhead at the ship (same rule as the pipeline).
  function liveNeed() {
    const s = shipNow();
    const R = Math.PI / 180;
    const mlat = Math.asin(Math.sin(s.lat * R) * Math.sin(80.8 * R) + Math.cos(s.lat * R) * Math.cos(80.8 * R) * Math.cos((s.lon + 72.6) * R)) / R;
    return Math.max(0, Math.min(9, (67.5 - mlat) / 1.8 + 0.5));
  }

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
  }

  function refreshOvation() {
    const s = shipNow();
    getOvation().then((o) => {
      const [lat, lon, label] = s.sailing ? [s.lat, s.lon, 'at the ship'] : [69.65, 18.96, 'Tromsø (not sailing yet)'];
      const { local, north } = ovationAt(o, lat, lon);
      setTile('lt-ov', `${local}<small> %</small>`, `${label} · ${north}% in view to the north`);
    }).catch(() => setTile('lt-ov', '–', 'offline'));
    drawOvationMap();
    renderRouteOvation();
  }

  // Bigger downloads: OVATION model and map, Bz chart, camera pictures and AI, magnetogram.
  function refreshHeavy() {
    OVATION = null;
    refreshOvation();
    loadBz();
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

  // ------------------------------------------------------------ all-sky cameras (ground truth, live)
  const AI_BASE = 'https://tromsoe-ai.cei.uec.ac.jp/~nanjo/public/aurora_alert/';
  const AI_AURORA = ['Arc', 'Discrete', 'Diffuse', 'Aurora but cloudy', 'Aurora but bright'];
  // What the camera AI sees, in plain words. `a` = its percentages.
  function aiVerdict(a) {
    const aurora = AI_AURORA.reduce((s, k) => s + (a[k] || 0), 0);
    const type = AI_AURORA.reduce((b, k) => ((a[k] || 0) > (a[b] || 0) ? k : b), AI_AURORA[0]);
    if (aurora >= 50) return ['good', `Aurora now (${type.toLowerCase()})`, aurora];
    if ((a['Dusk/Dawn'] || 0) >= 50) return ['day', 'Daylight / twilight', aurora];
    if ((a.Cloudy || 0) >= 50) return ['cloud', 'Cloudy', aurora];
    if ((a.Clear || 0) >= 50) return ['clear', 'Clear sky, no aurora', aurora];
    return ['mixed', 'Mixed / uncertain', aurora];
  }

  const AI_SITES = [['tromso', 'Tromsø', 'Data.json'], ['skibotn', 'Skibotn (between Tromsø and Alta)', 'Data_skibotn.json'], ['kiruna', 'Kiruna (Sweden)', 'Data_kiruna.json']];
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
    for (const [id, , file] of AI_SITES) {
      getJSON(AI_BASE + file).then((js) => {
        const [cls, text, aurora] = aiVerdict(js.Aurora || {});
        const when = new Date(js.Time.replace(' ', 'T') + 'Z');
        const box = document.getElementById(`ai-${id}`);
        if (!box) return;
        box.className = `aichip ${cls}`;
        box.querySelector('.v').textContent = `AI: ${text}`;
        const paused = Date.now() - when > 45 * 60000;
        box.querySelector('.s').textContent = `aurora ${Math.round(aurora)}% · clear ${Math.round(js.Aurora.Clear || 0)}% · cloudy ${Math.round(js.Aurora.Cloudy || 0)}% · picture from ${hm(when)} ship time${paused ? ' (cameras pause in daylight; this is the last dark-sky picture)' : ''}`;
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
      <p class="hint">Direct links, if the picture above does not load: <a href="https://flux.phys.uit.no/Last24/Last24_tro2a.gif" target="_blank" rel="noopener">Tromsø magnetogram</a> · <a href="https://flux.phys.uit.no/Last24/Last24_sor1a.gif" target="_blank" rel="noopener">Sørøya magnetogram</a> · <a href="https://flux.phys.uit.no/stackplot/" target="_blank" rel="noopener">all stations on one chart</a> · <a href="https://flux.phys.uit.no/Last24/" target="_blank" rel="noopener">TGO realtime page</a></p>`;
    el.querySelectorAll('.daytabs button').forEach((b) => b.addEventListener('click', () => { magSite = b.dataset.m; renderMag(); }));
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
      const site = r.spot === 'Tromsø' ? 'tromso' : 'skibotn';
      const hrs = SKY && SKY.nights && SKY.nights[r.date] && SKY.nights[r.date][site];
      if (!hrs) return '<span class="why">–</span>';
      const list = Object.entries(hrs).sort(([a], [b]) => ((+a + 12) % 24) - ((+b + 12) % 24));
      const aur = list.filter(([, v]) => v.aurora >= 50).map(([h]) => `${h}:00`);
      const clear = list.filter(([, v]) => v.clear >= 50).length;
      const label = site === 'skibotn' ? '<span class="why"> (Skibotn cam)</span>' : '';
      if (aur.length) return `<span class="ok">✓ aurora</span> ${aur[0]}${aur.length > 1 ? `–${aur[aur.length - 1]}` : ''} <span class="why">(${aur.length} h)</span>${label}`;
      if (clear) return `clear, no aurora <span class="why">(${clear} h)</span>${label}`;
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
        <tr><th>${dayLabel(days[checkDay])}</th><th>Chance</th><th>Best window</th><th>${checkDay === 0 ? 'MET cloud now*' : 'Cloud source'}</th></tr>
        ${checkNights().map((n, i) => {
          const w = bestWindow(n);
          const last = checkDay === 0 ? (nowRow(n).cloud_met != null ? Math.round(nowRow(n).cloud_met) + '%' : '–') : esc(n.clear.source);
          return `<tr class="pick ${i === checkSpot ? 'sel' : ''}" data-i="${i}"><td>${esc(n.spot)}</td><td>${pct(n.score)} ${chip(n.rating)}</td><td>${w ? `${w.text} ${w.label}` : 'none'}</td><td>${last}</td></tr>`;
        }).join('')}
      </table></div>
      <p class="hint">Tap a row to switch spot. ${checkDay === 0 ? `*At the last update (${ago(D.generated)}); live Kp is in the Live section. ` : ''}Sources last run: ${Object.entries(D.sources).map(([k, v]) => `${esc(k)} ${v.ok ? '✓' : '✕'}`).join(' · ')}</p>
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
    const now = p.now_series && p.now_series.length ? `<details class="wx-now"><summary><b>Right now at ${esc(p.name.replace(/ \((departure|arrival)\)/, ''))}:</b> next 48 hours · ${wxSummaryLine(p.now_summary)}</summary>
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
  function navSpy() {
    const links = [...document.querySelectorAll('#tabs a')];
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    document.querySelectorAll('main section').forEach((s) => obs.observe(s));
  }

  // ------------------------------------------------------------ boot
  const safe = (fn) => { try { fn(); } catch (e) { console.error(e); } };

  async function boot() {
    try {
      let hpFile;
      [D, HIST, VER, hpFile, WX, SKY, MAG] = await Promise.all([getJSON('data/latest.json'), getJSON('data/history.json').catch(() => null),
        getJSON('data/verification.json').catch(() => null), getJSON('data/hp30.json').catch(() => null),
        getJSON('data/weather.json').catch(() => null), getJSON('data/sky_obs.json').catch(() => null), getJSON('data/mag.json').catch(() => null)]);
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
    [renderFresh, renderPhase, renderHero, renderCards, renderDetail, renderTrend, renderKp27, renderKp3, renderSwpcText, renderLive, renderCams, renderMag, renderMap, markItineraryToday, renderItinNow, renderWeather, navSpy].forEach(safe);
    startLiveRefresh();
    // The check panel is collapsed: build it on first open so its chart can measure its width.
    $('#check-panel').addEventListener('toggle', () => { if ($('#check-panel').open) safe(renderCheck); });
    if (linked) {
      // instant jump (the CSS smooth scrolling would animate and can be interrupted); repeat once late content has loaded
      const jump = () => window.scrollTo({ top: $('#night-detail').getBoundingClientRect().top + window.scrollY - 70, behavior: 'instant' });
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
          () => HIST && drawTrend(HIST.runs), drawKp27, drawKp3, drawBz].forEach(safe);
      }, 200);
    });
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
})();
