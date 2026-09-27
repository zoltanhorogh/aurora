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
    const metWhy = c.p_met != null ? `MET Norway (2.5 km): ${esc(c.met_note)}, weight ${pct(c.w_met)} · ` : '';
    const clearWhy = metWhy + (c.p_ens != null
      ? `Weather models: ${pct(c.p_ens)} of ${c.members} runs (${c.models.join(' + ')}) show a clear gap · October climate: ${pct(c.p_clim)} · model weight ${pct(c.weight)}`
      : `No weather model reaches this night yet. In past Octobers ${pct(c.p_clim)} of nights here had a clear gap`);
    const need = kpNeedText(n.kp_req);
    const rows = [
      ['Activity', n.factors.activity, `${need[0].toUpperCase() + need.slice(1)} · forecast Kp ≈${a.kp != null ? a.kp.toFixed(1) : '–'} (${esc(a.kp_src || '–')})`],
      ['Clear sky', n.factors.clear, clearWhy],
      ['Darkness', n.factors.darkness, `Dark ${n.dark.start}–${n.dark.end} ship time (${n.dark.hours} h)`],
      ['Moon & lights', n.factors.moon_lights, `Moon ${Math.round(n.moon.illum * 100)}% lit, up ${pct(n.moon.up_frac_dark)} of the dark hours${n.state === 'port' ? ' · in port (town lights)' : ' · at sea (darkest skies)'}`],
    ];
    return `<div class="factors">${rows.map(([k, v, why]) => `
      <div class="factor"><div class="name">${k}</div><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div><div class="val">${pct(v)}</div><div class="why">${why}</div></div>`).join('')}
    </div>`;
  }

  function formula(n) {
    const f = n.factors;
    return `<div class="formula">Chance = activity ${pct(f.activity)} × clear sky ${pct(f.clear)} × darkness ${pct(f.darkness)} × moon &amp; lights ${pct(f.moon_lights)} = <b style="color:#fff">${pct(n.score)}</b>
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
        <div class="mini"><span>Act ${pct(n.factors.activity)}</span><span>Clear ${pct(n.factors.clear)}</span></div>
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
    svg.addEventListener('pointerleave', hide);
  }
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
  // Same conservative spirit as the alerts. Hourly verdicts only within VERDICT_LEAD days: further out,
  // hour-level cloud forecasts carry no real skill. Uses MET Norway cloud when available (lower = better),
  // otherwise the hourly clear-sky chance (models + October climate).
  const VERDICT_LEAD = 3;
  function hourStatus(h, n) {
    if (!h.dark) return ['twilight', 'day', ''];
    if (n.lead_days > VERDICT_LEAD) return ['–', 'far', ''];
    if (h.p_act < 0.25) return ['NO', 'no', 'aurora too weak'];
    const met = h.cloud_met;
    const goSky = met != null ? met <= 30 : h.p_clear_h >= 0.6;
    const trySky = met != null ? met <= 70 : h.p_clear_h >= 0.3;
    if (h.p_act >= 0.5 && goSky) return ['GO', 'go', ''];
    if (trySky) return ['TRY', 'try', ''];
    return ['NO', 'no', 'too cloudy'];
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
    const st = n.hourly.map((h) => hourStatus(h, n)[0]);
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

  function hoursTable(n) {
    const hasMet = n.hourly.some((h) => h.cloud_met != null);
    const far = n.lead_days > VERDICT_LEAD;
    const rows = n.hourly.filter((h) => h.sun < -3);
    const events = (n.events || []).filter((e) => e.kind === 'depart' || e.kind === 'arrive');
    const win = far ? null : bestWindow(n);
    let html = `<div class="hr head"><span>Time</span><span>Verdict</span><span>Clear sky chance</span><span class="kp">Kp fc ≥ need</span></div>`;
    const evRow = (e) => `<div class="ev">${evIcon(e.kind)}${esc(e.label)} ${e.local}</div>`;
    rows.forEach((h) => {
      while (events.length && events[0].t <= h.t) html += evRow(events.shift());
      const [lab, cls, why] = hourStatus(h, n);
      const clear = Math.round((h.p_clear_h ?? 0) * 100);
      const right = lab === 'NO' ? `<span class="why">${why}</span>`
        : h.kp >= h.kp_req ? `${h.kp.toFixed(1)} ≥ ${h.kp_req.toFixed(1)} <span class="ok">✓</span>`
        : `<span class="why">${h.kp.toFixed(1)} &lt; ${h.kp_req.toFixed(1)}</span>`;
      html += `<div class="hr ${cls}">
        <span class="tm">${h.local}</span><span class="st ${cls}">${lab}</span>
        <span class="cb"><span class="bar2"><i style="width:${clear}%"></i></span><span class="cv">${clear}%</span>${h.cloud_met != null ? `<span class="met">MET ${Math.round(h.cloud_met)}%</span>` : ''}</span>
        <span class="kp">${right}</span></div>`;
    });
    html += events.map(evRow).join('');
    return `
      <h3 style="margin-top:16px">Hour by hour</h3>
      ${sunStrip(n)}
      ${far ? '<div class="win none">Too early for hourly verdicts. They start about 3 days before the night; until then use the night\'s overall chance above.</div>'
        : win ? `<div class="win ${win.label === 'GO' ? 'go' : 'try'}">★ Best window ${win.text} · ${win.label}</div>`
        : '<div class="win none">No good window tonight.</div>'}
      <div class="hours2">${html}</div>
      <div class="legend" style="margin-top:8px"><span><i style="background:#199e70"></i>Clear sky chance (models + October climate; longer = better)</span><span><span class="met">MET 20%</span> MET Norway cloud cover (lower = better)</span><span>Kp: forecast ≥ needed ✓</span></div>
      <div class="hint"><span class="st go">GO</span> dark, activity chance ≥50% and MET cloud ≤30% (without MET: clear sky chance ≥60%) ·
        <span class="st try">TRY</span> activity chance ≥25% and MET cloud ≤70% (without MET: clear sky chance ≥30%) · <span class="st no">NO</span> otherwise.
        ${hasMet ? '' : 'MET Norway (2.5 km) reaches a night about 2.5 days before it.'} Exact numbers: "Show all data" below.</div>`;
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
    const hasCloud = hours.some((h) => h.cloud_mean != null);
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
            <span><i style="background:#3987e5"></i>Cloud cover (model average; thin line = likely range)</span>
            ${hasMet ? '<span><i class="dotm" style="background:#fff"></i>Cloud cover, MET Norway (2.5 km)</span>' : ''}
            <span><i class="line" style="background:#d95926"></i>Chance activity is strong enough here</span>
            <span><i class="band"></i>Dark hours</span>
          </div>
          <div class="chart" id="${chartId}"></div>
          ${hasCloud ? '' : '<div class="hint">No weather model reaches this night yet, so there are no cloud bars. The clear-sky factor uses the October climate instead.</div>'}
          <div class="hint">Times are ship time (UTC+2). <b>Kp forecast</b> = expected geomagnetic activity (0–9). <b>Kp needed</b> = the level at which aurora is clearly visible where the ship is at that hour (higher the further south). <b>Activity chance</b> = probability that the real Kp reaches the needed level, allowing for forecast error. At midnight: ${kpNeedText(n.kp_req)}.</div>
        </div>
      </div>
      ${hoursTable(n)}
      ${formula(n)}
      <details class="table"><summary>Show all data (table)</summary><div class="tbl-wrap"><table>
        <tr><th>Time</th><th>Where</th><th>Sun</th><th>Clear chance</th><th>Cloud models</th><th>Cloud MET</th><th>Kp forecast</th><th>Kp needed</th><th>Activity</th><th>Moon</th></tr>
        ${hours.map((h) => `<tr><td>${h.local}</td><td>${esc(shortPlace(h.place)).slice(0, 26)}</td><td>${h.sun}°</td><td>${pct(h.p_clear_h)}</td><td>${h.cloud_mean ?? '–'}${h.cloud_mean != null ? '%' : ''}</td><td>${h.cloud_met ?? '–'}${h.cloud_met != null ? '%' : ''}</td><td>${h.kp.toFixed(1)}</td><td>${h.kp_req.toFixed(1)}</td><td>${pct(h.p_act)}</td><td>${h.moon_alt > 0 ? Math.round(h.moon_illum * 100) + '%' : 'down'}</td></tr>`).join('')}
      </table></div></details>`;
  }

  function drawHourly(n, cont) {
    if (!cont || !n) return;
    const hours = n.hourly;
    const W = widthOf(cont), H = 250, ml = 38, mr = 8, mt = 10, mb = 46;
    const pw = W - ml - mr, ph = H - mt - mb;
    const bw = pw / hours.length;
    const y = (v) => mt + ph - (v / 100) * ph;
    let g = '';
    hours.forEach((h, i) => { g += `<rect x="${ml + i * bw}" y="${mt}" width="${bw + 0.5}" height="${ph}" fill="${h.dark ? '#0e0f11' : '#23252b'}"/>`; });
    g += gridY(y, ml, W - mr, [0, 25, 50, 75, 100], (v) => v + '%');
    g += '<g class="hl"></g>';
    hours.forEach((h, i) => {
      if (h.cloud_mean == null) return;
      const cx = ml + i * bw + bw / 2, w = Math.max(5, bw * 0.46);
      g += `<path d="${roundTopBar(cx - w / 2, y(h.cloud_mean), w, y(0) - y(h.cloud_mean))}" fill="#3987e5"/>`;
      if (h.cloud_p10 != null) g += `<line x1="${cx}" x2="${cx}" y1="${y(h.cloud_p90)}" y2="${y(h.cloud_p10)}" stroke="#9ec5f4" stroke-width="2" stroke-linecap="round" opacity="0.8"/>`;
    });
    hours.forEach((h, i) => {
      if (h.cloud_met != null) g += `<circle cx="${ml + i * bw + bw / 2}" cy="${y(h.cloud_met)}" r="3.5" fill="#fff" stroke="#16171a" stroke-width="2"/>`;
    });
    const pts = hours.map((h, i) => [ml + i * bw + bw / 2, y(h.p_act * 100)]);
    g += `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#d95926" stroke-width="2" stroke-linejoin="round"/>`;
    pts.forEach(([px, py], i) => { if (hours[i].dark) g += `<circle cx="${px}" cy="${py}" r="4" fill="#d95926" stroke="#16171a" stroke-width="2"/>`; });
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
        <div class="row"><span>Cloud (models)</span><span>${h.cloud_mean != null ? `${h.cloud_mean}% (${h.cloud_p10}–${h.cloud_p90})` : 'no forecast yet'}</span></div>
        ${h.cloud_met != null ? `<div class="row"><span>Cloud (MET Norway)</span><span>${h.cloud_met}%</span></div>` : ''}
        <div class="row"><span>Clear sky chance</span><span>${pct(h.p_clear_h)}</span></div>
        <div class="row"><span>Verdict</span><span>${hourStatus(h, n)[0]} ${hourStatus(h, n)[2]}</span></div>
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
        <div class="row"><span>Observed</span><span>${obs[d] != null && d <= today ? obs[d].toFixed(1) : '–'}</span></div>
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
  function renderLive() {
    const s = shipNow();
    const t = (k, v, sub, id) => `<div class="tile" ${id ? `id="${id}"` : ''}><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
    const R = Math.PI / 180;
    const mlat = Math.asin(Math.sin(s.lat * R) * Math.sin(80.8 * R) + Math.cos(s.lat * R) * Math.cos(80.8 * R) * Math.cos((s.lon + 72.6) * R)) / R;
    const need = Math.max(0, Math.min(9, (67.5 - mlat) / 1.8 + 0.5));
    $('#live-tiles').innerHTML =
      t('Ship', `<span style="font-size:17px">${esc(shortPlace(s.place))}</span>`, s.sailing ? `${s.lat.toFixed(1)}°N ${s.lon.toFixed(1)}°E (from itinerary)` : 'Not sailing yet: shows the planned start') +
      t('Kp now', '…', '', 'lt-kp') + t('Bz', '…', '', 'lt-bz') + t('Solar wind', '…', '', 'lt-sw') +
      t('Aurora overhead', s.sailing ? '…' : '–', s.sailing ? 'NOAA OVATION at the ship' : '<button class="btn" id="ov-btn" style="padding:3px 10px;font-size:12px">check Tromsø</button>', 'lt-ov');
    const set = (id, v, sub) => { const e = document.getElementById(id); if (e) { e.querySelector('.v').innerHTML = v; e.querySelector('.s').innerHTML = sub; } };

    getJSON(`${SWPC}/json/planetary_k_index_1m.json`).then((a) => {
      const k = a[a.length - 1].estimated_kp;
      set('lt-kp', k.toFixed(1), `needed here ≈${need.toFixed(0)} ${k >= need ? '✓ enough' : '✕ not enough'}`);
    }).catch(() => set('lt-kp', '–', 'offline'));
    getJSON(`${SWPC}/products/summary/solar-wind-mag-field.json`).then((a) => {
      const bz = a[0].bz_gsm;
      set('lt-bz', `${bz > 0 ? '+' : ''}${bz}<small> nT</small>`, bz <= -5 ? '✓ strongly south: door open' : bz < 0 ? 'slightly south' : '✕ north: door mostly closed');
    }).catch(() => set('lt-bz', '–', 'offline'));
    getJSON(`${SWPC}/products/summary/solar-wind-speed.json`).then((a) => {
      const v = a[0].proton_speed;
      set('lt-sw', `${v}<small> km/s</small>`, v >= 500 ? '✓ fast' : v >= 400 ? 'moderate' : 'slow');
    }).catch(() => set('lt-sw', '–', 'offline'));

    const loadOvation = async (lat, lon, label) => {
      set('lt-ov', '…', 'loading NOAA model (≈1 MB)');
      try {
        const o = await getJSON(`${SWPC}/json/ovation_aurora_latest.json`);
        const lon360 = ((lon % 360) + 360) % 360;
        let local = 0, north = 0;
        for (const [glon, glat, p] of o.coordinates) {
          const dl = Math.min(Math.abs(glon - lon360), 360 - Math.abs(glon - lon360));
          if (dl <= 1 && Math.abs(glat - lat) <= 1) local = Math.max(local, p);
          if (dl <= 10 && glat >= lat && glat <= lat + 8) north = Math.max(north, p);
        }
        set('lt-ov', `${local}<small> %</small>`, `${label} · ${north}% in view to the north`);
      } catch { set('lt-ov', '–', 'offline'); }
    };
    if (s.sailing) loadOvation(s.lat, s.lon, 'at the ship');
    else { const b = document.getElementById('ov-btn'); if (b) b.addEventListener('click', () => loadOvation(69.65, 18.96, 'Tromsø')); }

    $('#bz-panel').innerHTML = `<h3>Solar wind Bz, last 24 h</h3>
      <p class="hint">Negative (south) Bz lets solar-wind energy in; 20+ minutes below −5 nT often triggers aurora within the hour.</p>
      <button class="btn" id="bz-btn">Load chart (≈1.5 MB)</button><div class="chart" id="bz-chart"></div>`;
    $('#bz-btn').addEventListener('click', loadBz);

    $('#ovation-panel').innerHTML = `<h3>NOAA aurora forecast map (30–90 min)</h3>
      <img src="${SWPC}/images/animations/ovation/north/latest.jpg?t=${Date.now()}" alt="NOAA OVATION northern hemisphere aurora forecast" loading="lazy">
      <p class="hint">Green → red = rising probability. Norway sits at about "7 o'clock" on the map. Updates every few minutes.</p>`;
  }

  async function loadBz() {
    const btn = $('#bz-btn');
    btn.disabled = true; btn.textContent = 'Loading…';
    try {
      const raw = await getJSON(`${SWPC}/json/rtsw/rtsw_mag_1m.json`);
      const rows = raw.filter((r) => r.active && r.bz_gsm != null).map((r) => [new Date(r.time_tag + 'Z').getTime(), r.bz_gsm]).sort((a, b) => a[0] - b[0]);
      const bins = new Map();
      for (const [t, v] of rows) { const k = Math.floor(t / 600e3) * 600e3; const b = bins.get(k) || [0, 0]; b[0] += v; b[1]++; bins.set(k, b); }
      bzPts = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([t, [s, n]]) => [t, s / n]);
      btn.remove();
      drawBz();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Retry (offline?)';
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

  // ------------------------------------------------------------ model check (tonight in Tromsø and Alta)
  let checkSpot = 0;
  const checkNight = () => (D.model_check ? D.model_check.nights[checkSpot] : null);

  function renderCheck() {
    const mc = D.model_check;
    const body = $('#check-body');
    if (!mc || !mc.nights.length) { body.innerHTML = '<div class="empty">Model check data will appear after the next update.</div>'; return; }
    const nowRow = (n) => n.hourly.reduce((b, h) => (Math.abs(new Date(h.t) - Date.now()) < Math.abs(new Date(b.t) - Date.now()) ? h : b));
    body.innerHTML = `
      <p class="hint" style="margin-top:0">${esc(mc.note)} Compare with Norway Lights or yr.no, or just look outside.</p>
      <div class="tbl-wrap"><table>
        <tr><th>Tonight (${dayLabel(mc.date)})</th><th>Chance</th><th>Best window</th><th>MET cloud now*</th></tr>
        ${mc.nights.map((n, i) => {
          const w = n.lead_days > VERDICT_LEAD ? null : bestWindow(n);
          const r = nowRow(n);
          return `<tr class="pick ${i === checkSpot ? 'sel' : ''}" data-i="${i}"><td>${esc(n.spot)}</td><td>${pct(n.score)} ${chip(n.rating)}</td><td>${w ? `${w.text} ${w.label}` : 'none'}</td><td>${r.cloud_met != null ? Math.round(r.cloud_met) + '%' : '–'}</td></tr>`;
        }).join('')}
      </table></div>
      <p class="hint">Tap a row to switch. *At the last update (${ago(D.generated)}); live Kp is in the Live section. Sources last run: ${Object.entries(D.sources).map(([k, v]) => `${esc(k)} ${v.ok ? '✓' : '✕'}`).join(' · ')}</p>
      <div id="check-detail" style="border-top:1px solid var(--border);padding-top:12px"></div>`;
    body.querySelectorAll('tr.pick').forEach((tr) => tr.addEventListener('click', () => { checkSpot = +tr.dataset.i; renderCheck(); }));
    $('#check-detail').innerHTML = detailHTML(checkNight(), 'check-chart');
    drawHourly(checkNight(), $('#check-chart'));
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
      [D, HIST] = await Promise.all([getJSON('data/latest.json'), getJSON('data/history.json').catch(() => null)]);
    } catch (e) {
      $('#fresh').innerHTML = '<span class="dot bad"></span>data unavailable';
      $('#hero').innerHTML = `<div class="empty">Could not load the forecast data (${esc(e.message)}). Check the connection and reload.</div>`;
      return;
    }
    // Deep link from notifications: ?night=YYYY-MM-DD opens that night's detail.
    const wanted = new URLSearchParams(location.search).get('night');
    const linked = D.nights.some((n) => n.date === wanted) ? wanted : null;
    selected = linked || tonightDate() || D.nights.reduce((b, x) => (x.score > b.score ? x : b), D.nights[0]).date;
    [renderFresh, renderPhase, renderHero, renderCards, renderDetail, renderTrend, renderKp27, renderKp3, renderSwpcText, renderLive, renderMap, navSpy].forEach(safe);
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
