// Haupt-App: Laden, Routing, Suche, Erfolgs-Run-Through, Leichte-AP-Finder.
(() => {
  const S = {
    lang: Store.get('gameLang', 'en'),
    wikiLang: Store.get('wikiLang2', 'en'),
    key: Store.get('apiKey', ''),
    ach: new Map(),
    catOf: new Map(), // achId -> category
    groupOf: new Map(), // catId -> group
    groups: [],
    progress: new Map(),
    account: null,
    progressTs: null,
    query: '',
    viewToken: 0,
    easyRows: null,
    easy: Store.get('easyFilters', {
      sort: 'ease', hideLocked: true, hidePvp: false, hideRepeatable: false,
      onlyStarted: false, minProgress: 0, excludedGroups: [],
    }),
    wikiCache: new Map(),
    wikiReq: new Map(), // achId -> Anforderungstext aus dem Wiki (wenn die API keine liefert)
    wikiUnlock: new Map(), // achId -> { html } Freischalt-Hinweis aus dem Wiki
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '');
  const pct = (f) => `${Math.round(f * 100)}%`;

  function coins(c) {
    const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), k = c % 100;
    return [g && `${g}g`, s && `${s}s`, k && `${k}c`].filter(Boolean).join(' ') || '0c';
  }

  // ---------- Status / Laden ----------
  function status(text, frac) {
    const el = $('#status');
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    $('#status-text').textContent = text;
    $('#status-bar').style.width = frac != null ? pct(frac) : '100%';
  }

  function indexStatic(data) {
    S.ach = new Map(data.achievements.map((a) => [a.id, a]));
    S.catOf.clear();
    S.groupOf.clear();
    const cats = new Map(data.categories.map((c) => [c.id, c]));
    for (const c of data.categories) {
      for (const entry of c.achievements || []) {
        const id = typeof entry === 'object' ? entry.id : entry;
        if (!S.catOf.has(id)) S.catOf.set(id, c);
      }
    }
    S.groups = [...data.groups].sort((a, b) => a.order - b.order);
    for (const g of S.groups) for (const cid of g.categories || []) if (cats.has(cid)) S.groupOf.set(cid, g);
    S.byName = new Map();
    for (const a of data.achievements) {
      const k = norm(a.name);
      if (!S.byName.has(k) || (S.catOf.has(a.id) && !S.catOf.has(S.byName.get(k).id))) S.byName.set(k, a);
    }
    S.easyRows = null;
  }

  async function loadStatic(force = false) {
    const data = await GW2.loadStatic(S.lang, { force, onProgress: status });
    indexStatic(data);
    status(null);
  }

  async function loadProgress() {
    S.progress.clear();
    S.account = null;
    S.easyRows = null;
    if (!S.key) { renderAccount(); return; }
    status('Loading account progress…');
    try {
      const [acc, prog, token] = await Promise.all([GW2.account(S.key), GW2.accountAchievements(S.key), GW2.tokenInfo(S.key).catch(() => null)]);
      S.account = acc;
      S.perms = token?.permissions || [];
      S.progress = new Map(prog.map((p) => [p.id, p]));
      S.progressTs = new Date();
      recordDaily();
      S.invPromise = loadInventory().catch((e) => console.warn('Inventar', e));
    } catch (e) {
      toast(`API key error: ${e.message}`);
    }
    status(null);
    renderAccount();
  }

  function totalAP() {
    let ap = 0, doneCount = 0;
    for (const [id, p] of S.progress) {
      const a = S.ach.get(id);
      if (!a) continue;
      ap += Progress.info(a, p).earned;
      if (p.done) doneCount++;
    }
    return { ap, doneCount, total: ap + (S.account?.daily_ap || 0) + (S.account?.monthly_ap || 0) };
  }

  const utcDay = (d = new Date()) => d.toISOString().slice(0, 10); // Tagesreset in GW2 = 00:00 UTC

  // Täglicher AP-Stand (für Verlauf & Prognose) und Fortschritts-Schnappschuss (für „heute geschafft“)
  function recordDaily() {
    const today = utcDay();
    const hist = Store.get('apHistory', {});
    hist[today] = totalAP().total;
    const days = Object.keys(hist).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 400))) delete hist[d];
    Store.set('apHistory', hist);
    let snap = Store.get('progSnap', null);
    if (!snap || snap.date !== today) {
      snap = { date: today, cur: {} };
      for (const [id, p] of S.progress) if (p.current) snap.cur[id] = p.current;
      Store.set('progSnap', snap);
    }
    S.snap = snap;
  }

  // Items im Account (Bank, Materiallager, geteilte Plätze, Charaktere) – nur mit passenden Key-Rechten
  async function loadInventory() {
    S.inv = null;
    const perms = S.perms || [];
    if (!S.key || !perms.includes('inventories')) return;
    const inv = new Map();
    const add = (id, n, where) => {
      if (!id || !n) return;
      const e = inv.get(id) || { count: 0, where: new Set() };
      e.count += n; e.where.add(where); inv.set(id, e);
    };
    const [bank, mats, shared, chars] = await Promise.all([
      GW2.bank(S.key).catch(() => []), GW2.materials(S.key).catch(() => []), GW2.sharedInventory(S.key).catch(() => []),
      perms.includes('characters') ? GW2.characters(S.key).catch(() => []) : [],
    ]);
    bank.forEach((x) => x && add(x.id, x.count, 'Bank'));
    mats.forEach((x) => x && add(x.id, x.count, 'Material storage'));
    shared.forEach((x) => x && add(x.id, x.count, 'Shared slots'));
    for (const c of chars) for (const bag of c.bags || []) for (const x of bag?.inventory || []) if (x) add(x.id, x.count, c.name);
    S.inv = inv;
  }

  function renderAccount() {
    const el = $('#account');
    if (!S.account) {
      el.innerHTML = S.key ? '<span class="muted">Account not loaded</span>' : '<a href="#/settings">Add API key</a>';
      return;
    }
    const { ap, doneCount, total } = totalAP();
    el.innerHTML = `<strong>${esc(S.account.name)}</strong>
      <span class="pill" title="Achievement AP ${ap} + daily AP ${S.account.daily_ap || 0} + monthly AP ${S.account.monthly_ap || 0}">≈ ${total.toLocaleString('en-US')} AP</span>
      <span class="pill">${doneCount} completed</span>
      <button class="link" id="reload-progress" title="Reload progress from the API">↻</button>`;
    $('#reload-progress').onclick = async () => { await loadProgress(); route(); };
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 6000);
  }

  // ---------- Hilfen für Darstellung ----------
  function achIcon(a) {
    const cat = S.catOf.get(a.id);
    const src = a.icon || cat?.icon;
    return src ? `<img class="icon" src="${esc(src)}" alt="" loading="lazy">` : '<span class="icon ph"></span>';
  }

  function stateBadge(a) {
    const p = S.progress.get(a.id);
    const inf = Progress.info(a, p);
    if (!S.account) return `<span class="pill">${inf.perCycle} AP</span>`;
    if (inf.finished) return '<span class="pill ok">✔ done</span>';
    if (inf.remainingAP === 0 && inf.repeatable) return '<span class="pill ok">✔ AP cap</span>';
    const prog = inf.maxCount ? ` · ${inf.current}/${inf.maxCount}` : '';
    return `<span class="pill ${inf.current ? 'warn' : ''}">${inf.earned}/${isFinite(inf.possible) ? inf.possible : '∞'} AP${prog}</span>`;
  }

  function catPath(a) {
    const cat = S.catOf.get(a.id);
    const grp = cat && S.groupOf.get(cat.id);
    return [grp?.name, cat?.name].filter(Boolean).map(esc).join(' › ') || '<span class="muted">uncategorized</span>';
  }

  function bar(frac) {
    return `<div class="bar"><div style="width:${pct(frac)}"></div></div>`;
  }

  // ---------- Merkliste ----------
  const watchList = () => Store.get('watch', []);
  const isWatched = (id) => watchList().includes(id);
  function toggleWatch(id) {
    const w = watchList();
    const i = w.indexOf(id);
    if (i >= 0) w.splice(i, 1); else w.unshift(id);
    Store.set('watch', w);
    return i < 0;
  }

  // Nächster sinnvoller Schritt als Kurztext
  function nextStepText(a, inf) {
    if (inf.finished) return 'Completed';
    const openText = (a.bits || []).map((b, i) => (!inf.bitsDone.has(i) && b.type === 'Text' && b.text ? b.text : null)).filter(Boolean);
    const left = inf.maxCount ? Math.max(0, inf.maxCount - inf.current) : 0;
    if (openText.length) return `Next: ${openText[0]}${left > 1 ? ` (+${left - 1} more)` : ''}`;
    if (left) return `${left.toLocaleString('en-US')} left – ${stripTags(a.requirement).replace(/\s+/g, ' ')}`;
    return stripTags(a.requirement).replace(/\s+/g, ' ');
  }

  function trackedHtml() {
    const ids = watchList().filter((id) => S.ach.has(id));
    if (!ids.length) return '<p class="muted">📌 Tip: open an achievement and tap <strong>☆ Track</strong> to pin it here.</p>';
    const rows = ids.map((id) => {
      const a = S.ach.get(id);
      const inf = Progress.info(a, S.progress.get(id));
      const timer = typeof Timers !== 'undefined' ? Timers.forAchievement(a, S.catOf.get(id)) : null;
      return `<li class="${inf.finished ? 'done' : ''}"><a class="row" href="#/a/${id}">${achIcon(a)}
        <div class="grow"><div class="title">${esc(a.name)}</div>
          <div class="sub">${esc(nextStepText(a, inf))}</div>
          ${timer ? `<div class="sub">⏰ ${esc(timer.label)}</div>` : ''}
          ${inf.maxCount > 1 ? bar(inf.frac) : ''}</div>
        ${stateBadge(a)}</a></li>`;
    });
    return `<h2>📌 Tracked</h2><ul class="list tracked">${rows.join('')}</ul>`;
  }

  // AP-Verlauf: heute, letzte 7 Tage, Schnitt pro Tag
  function apStats() {
    const hist = Store.get('apHistory', {});
    const days = Object.keys(hist).sort();
    if (!days.length) return null;
    const dayMs = 86400000;
    const last = days[days.length - 1];
    const cur = hist[last];
    // Stand an einem Tag X vor heute (letzter bekannter Wert davor)
    const valueDaysAgo = (n) => {
      const cutoff = Date.parse(last) - n * dayMs;
      const before = days.filter((d) => Date.parse(d) <= cutoff);
      return before.length ? hist[before[before.length - 1]] : null;
    };
    const yesterday = valueDaysAgo(1);
    const weekAgo = valueDaysAgo(7);
    const recent = days.filter((d) => (Date.parse(last) - Date.parse(d)) / dayMs <= 30);
    const span = (Date.parse(last) - Date.parse(recent[0])) / dayMs;
    const rate = span >= 1 ? (cur - hist[recent[0]]) / span : null;
    return { hist, days, cur, today: yesterday === null ? null : cur - yesterday, week: weekAgo === null ? null : cur - weekAgo, rate, span };
  }

  function progressCardHtml() {
    const st = S.account ? apStats() : null;
    if (!st) return '';
    const fmt = (n) => (n === null ? '–' : `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString('en-US')}`);
    return `<div class="card progress-card">
      <div class="big-num">${st.cur.toLocaleString('en-US')}<span> AP</span></div>
      <div class="stat-row">
        <div><strong>${fmt(st.today)}</strong><span>today</span></div>
        <div><strong>${fmt(st.week)}</strong><span>last 7 days</span></div>
        <div><strong>${st.rate === null ? '–' : `≈ ${Math.round(st.rate).toLocaleString('en-US')}`}</strong><span title="Average over the last ${Math.round(st.span)} day(s)">avg AP / day</span></div>
      </div>
      ${st.days.length >= 2 ? '<div class="spark" id="spark"></div>' : '<p class="muted">Your AP is saved once a day – the history chart appears from the second day on.</p>'}
    </div>`;
  }

  // Kleine Verlaufskurve (eine Reihe, keine Legende) mit Hover/Tap-Tooltip
  function drawSpark() {
    const el = $('#spark');
    const f = apStats();
    if (!el || !f || f.days.length < 2) return;
    const pts = f.days.slice(-60).map((d) => ({ d, v: f.hist[d] }));
    const W = 320, H = 70, P = 4;
    const t0 = Date.parse(pts[0].d), t1 = Date.parse(pts[pts.length - 1].d) || t0 + 1;
    const vs = pts.map((p) => p.v);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs) === lo ? lo + 1 : Math.max(...vs);
    const x = (d) => P + ((Date.parse(d) - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
    const y = (v) => H - P - ((v - lo) / Math.max(1, hi - lo)) * (H - 2 * P);
    const line = pts.map((p) => `${x(p.d).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="AP per day">
        <polygon points="${P},${H - P} ${line} ${W - P},${H - P}" class="spark-area"/>
        <polyline points="${line}" class="spark-line"/>
        <line class="spark-cross" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>
        <circle class="spark-dot" r="4" visibility="hidden"/>
      </svg><div class="spark-tip" hidden></div>`;
    const svg = el.querySelector('svg'), cross = el.querySelector('.spark-cross'), dot = el.querySelector('.spark-dot'), tip = el.querySelector('.spark-tip');
    const show = (evt) => {
      const r = svg.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * W;
      const p = pts.reduce((best, q) => (Math.abs(x(q.d) - px) < Math.abs(x(best.d) - px) ? q : best), pts[0]);
      cross.setAttribute('x1', x(p.d)); cross.setAttribute('x2', x(p.d)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(p.d)); dot.setAttribute('cy', y(p.v)); dot.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.textContent = `${new Date(p.d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}: ${p.v.toLocaleString('en-US')} AP`;
      tip.style.left = `${Math.min(r.width - 120, Math.max(0, (x(p.d) / W) * r.width - 60))}px`;
    };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
  }

  // ---------- Suche ----------
  function showSearch() {
    setNav('search');
    view.innerHTML = `
      <div class="searchbox">
        ${S.key ? '' : keyCardHtml()}
        <input id="q" type="search" placeholder="Search achievements… (name, description or ID, e.g. “Leap of Faith”)" autocomplete="off" value="${esc(S.query)}">
      </div>
      <div id="results"></div>`;
    const q = $('#q');
    const homeKey = $('#home-key');
    if (homeKey) {
      const save = async () => {
        if (await saveKey(homeKey.value, $('#home-key-info'))) setTimeout(showSearch, 1500);
      };
      $('#home-key-save').onclick = save;
      homeKey.onkeydown = (e) => { if (e.key === 'Enter') save(); };
      homeKey.focus();
    } else q.focus();
    let t;
    q.oninput = () => { clearTimeout(t); t = setTimeout(() => { S.query = q.value; renderResults(); }, 120); };
    renderResults();
  }

  function renderResults() {
    const el = $('#results');
    const q = norm(S.query);
    if (q.length < 2) {
      el.innerHTML = `${progressCardHtml()}${S.account ? trackedHtml() : ''}<p class="muted">${S.ach.size.toLocaleString('en-US')} achievements loaded. Type at least 2 characters.
        ${S.account ? '' : '<br>Tip: with an API key you see your progress and the <a href="#/easy">Easy AP finder</a>.'}</p>`;
      drawSpark();
      return;
    }
    const idQuery = /^\d+$/.test(q) ? +q : null;
    const scored = [];
    for (const a of S.ach.values()) {
      const n = norm(a.name);
      let score = -1;
      if (a.id === idQuery) score = 100;
      else if (n === q) score = 90;
      else if (n.startsWith(q)) score = 70;
      else if (n.includes(q)) score = 50;
      else if (norm(stripTags(a.description)).includes(q) || norm(stripTags(a.requirement)).includes(q)) score = 20;
      if (score < 0) continue;
      if (S.catOf.has(a.id)) score += 5; // Aktive Erfolge bevorzugen
      scored.push([score, a]);
    }
    scored.sort((x, y) => y[0] - x[0] || x[1].name.localeCompare(y[1].name));
    const top = scored.slice(0, 60);
    el.innerHTML = top.length ? `<ul class="list">${top.map(([, a]) => `
      <li><a class="row" href="#/a/${a.id}">
        ${achIcon(a)}
        <div class="grow"><div class="title">${esc(a.name)}</div><div class="sub">${catPath(a)}</div></div>
        ${stateBadge(a)}
      </a></li>`).join('')}</ul>
      ${scored.length > top.length ? `<p class="muted">… and ${scored.length - top.length} more. Refine your search.</p>` : ''}`
      : '<p class="muted">No results.</p>';
  }

  // ---------- Erfolg / Run-Through ----------
  function prereqChain(a, seen = new Set()) {
    const out = [];
    for (const pid of a.prerequisites || []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const pa = S.ach.get(pid);
      if (!pa) continue;
      out.push(...prereqChain(pa, seen), pa);
    }
    return out;
  }

  async function bitNames(a, lang) {
    const bits = a.bits || [];
    const byType = {};
    for (const b of bits) if (b.type !== 'Text' && b.id != null) (byType[b.type] ||= []).push(b.id);
    const resolved = {};
    await Promise.all(Object.entries(byType).map(async ([type, ids]) => {
      resolved[type] = await GW2.resolve(type, ids, lang).catch(() => ({}));
    }));
    return bits.map((b, i) => {
      if (b.type === 'Text') return { type: 'Text', label: b.text || `Step ${i + 1}` };
      const r = resolved[b.type]?.[b.id];
      return { type: b.type, id: b.id, label: r?.name || `${b.type} #${b.id}`, icon: r?.icon, rarity: r?.rarity };
    });
  }

  async function rewardsHtml(a) {
    const rw = a.rewards || [];
    if (!rw.length) return '';
    const items = await GW2.resolve('Item', rw.filter((r) => r.type === 'Item').map((r) => r.id), S.lang).catch(() => ({}));
    const titles = await GW2.resolve('Title', rw.filter((r) => r.type === 'Title').map((r) => r.id), S.lang).catch(() => ({}));
    const parts = rw.map((r) => {
      if (r.type === 'Coins') return `💰 ${coins(r.count)}`;
      if (r.type === 'Item') {
        const it = items[r.id];
        return `${it?.icon ? `<img class="mini" src="${esc(it.icon)}" alt="">` : '🎁'} ${r.count > 1 ? `${r.count}× ` : ''}${esc(it?.name || `Item #${r.id}`)}`;
      }
      if (r.type === 'Mastery') return `⭐ Mastery point (${esc(r.region)})`;
      if (r.type === 'Title') return `🏷️ Title “${esc(titles[r.id]?.name || r.id)}”`;
      return esc(r.type);
    });
    return `<div class="rewards"><strong>Rewards:</strong> ${parts.map((p) => `<span class="pill">${p}</span>`).join(' ')}</div>`;
  }

  async function showAchievement(id) {
    setNav(null);
    const token = ++S.viewToken;
    const a = S.ach.get(id);
    if (!a) { view.innerHTML = `<p class="muted">Achievement ${id} not found.</p>`; return; }
    const p = S.progress.get(id);
    const inf = Progress.info(a, p);
    const flags = (a.flags || []).filter((f) => !['CategoryDisplay', 'MoveToTop', 'IgnoreNearlyComplete', 'RepairOnLogin'].includes(f));
    const tierText = inf.tiers.map((t) => `${t.count} → ${t.points} AP`).join(' · ');
    const requirement = stripTags(a.requirement).replace(/\s+/g, ' ').trim();

    let status = '';
    if (S.account) {
      const count = inf.finished ? '✔ Completed' : inf.maxCount > 1 ? `${inf.current} / ${inf.maxCount}` : 'Not done';
      status = `<div class="focus-status">${bar(inf.frac)}
        <span>${count}</span>
        <span class="pill">${inf.earned}/${isFinite(inf.possible) ? inf.possible : '∞'} AP</span>
        ${inf.next ? `<span class="pill warn">+${inf.next.points} AP at ${inf.next.count}</span>` : ''}</div>`;
    } else {
      status = `<div class="focus-status"><span class="pill">${inf.perCycle} AP</span> <span class="muted">No API key – progress unknown</span></div>`;
    }

    view.innerHTML = `
      <p><a href="javascript:history.back()" class="link">← Back</a></p>
      <header class="focus-head">
        ${achIcon(a).replace('class="icon"', 'class="icon big"')}
        <div class="grow">
          <div class="sub">${catPath(a)}</div>
          <h1>${esc(a.name)}</h1>
          ${requirement ? `<p class="req">${esc(requirement)}</p>` : ''}
          <button class="small watch" id="watch-btn">${isWatched(a.id) ? '★ Tracked' : '☆ Track'}</button>
          ${status}
        </div>
      </header>
      <section id="todo" class="todo"><h2>What you still need to do</h2><p class="muted">Loading…</p></section>
      <section id="places"></section>
      <details id="done-box" class="box" hidden><summary></summary><div id="done-body"></div></details>
      <details id="guide-box" class="box"><summary>📖 Full wiki guide</summary><div id="guide"><p class="muted">Loading wiki page…</p></div></details>
      <details id="more-box" class="box"><summary>ℹ️ Details: description, rewards, tiers</summary>
        ${a.description ? `<p class="desc">${esc(stripTags(a.description))}</p>` : ''}
        ${a.locked_text ? `<p class="muted"><strong>Unlock:</strong> ${esc(stripTags(a.locked_text))}</p>` : ''}
        <p class="muted">Tiers: ${tierText || '—'} · ID ${a.id}</p>
        <div class="flags">${flags.map((f) => `<span class="pill">${esc(f)}</span>`).join(' ')}</div>
        <div id="rewards"></div>
        <p><a class="btn" id="wiki-link" target="_blank" rel="noopener" href="${Wiki.searchUrl(S.wikiLang, a.name)}">Open in wiki ↗</a></p>
      </details>`;

    rewardsHtml(a).then((h) => { if (token === S.viewToken) $('#rewards').innerHTML = h; });
    $('#watch-btn').onclick = (e) => { e.target.textContent = toggleWatch(a.id) ? '★ Tracked' : '☆ Track'; };

    const names = await bitNames(a, S.lang);
    if (token !== S.viewToken) return;
    renderTodo(a, inf, names, null, null);
    // Besitz (Account) und Preise der offenen Sammlungs-Items nachladen
    const openItems = (a.bits || []).map((b, i) => (b.type === 'Item' && !inf.bitsDone.has(i) && !inf.finished ? b.id : null)).filter(Boolean);
    Promise.all([S.invPromise, openItems.length ? loadPrices(openItems) : null])
      .then(() => { if (token === S.viewToken) rerenderTodo(); });

    try {
      const wiki = await loadWiki(a);
      if (token !== S.viewToken) return;
      $('#wiki-link').href = Wiki.pageUrl(S.wikiLang, wiki.title);
      let content = Wiki.sanitize(S.wikiLang, wiki.html);
      // Seite gehört nicht nur zu diesem Erfolg (z. B. Kategorieseite)? Dann nur dessen Abschnitt.
      const wikiName = wiki.ach?.name || a.name;
      const ownPage = norm(wiki.title.replace(/\s*\((achievement|erfolg)\)$/i, '')) === norm(wikiName);
      let section = null;
      if (!ownPage) {
        const others = S.wikiLang === S.lang
          ? categoryIds(S.catOf.get(a.id)).filter((x) => x !== a.id).map((x) => S.ach.get(x)?.name).filter(Boolean)
          : [];
        section = extractSection(content, wikiName, others);
        if (section) content = section;
      }
      if (inf.needsUnlock || !p) {
        const uh = wikiUnlockHint(content) || {};
        uh.partOf = wikiPartOf(content, wiki.title);
        S.wikiUnlock.set(a.id, uh);
      }
      if (!requirement) {
        const wr = section ? sectionRequirement(section, wikiName) : wikiRequirement(content);
        if (wr) {
          S.wikiReq.set(a.id, wr);
          $('.focus-head h1').insertAdjacentHTML('afterend', `<p class="req">${esc(wr)} <span class="sub">(from the wiki)</span></p>`);
        }
      }
      const wikiNames = S.wikiLang === S.lang ? names : await bitNames(wiki.ach, S.wikiLang);
      if (token !== S.viewToken) return;
      renderTodo(a, inf, names, content, wikiNames);
      renderGuide(content, wiki.title, section ? wikiName : null);
      renderPlaces(a, inf, names, content, wikiNames, wiki.title, token);
    } catch (e) {
      if (token !== S.viewToken) return;
      $('#guide').innerHTML = `<p class="muted">No matching wiki page found (${esc(e.message)}).
        <a target="_blank" rel="noopener" href="${Wiki.searchUrl(S.wikiLang, a.name)}">Search the wiki ↗</a></p>`;
    }
  }

  async function loadWiki(a) {
    const ck = `${S.wikiLang}-${a.id}`;
    if (S.wikiCache.has(ck)) return S.wikiCache.get(ck);
    const promise = (async () => {
      const ach = S.wikiLang === S.lang ? a : await GW2.achievementInLang(a.id, S.wikiLang);
      const title = await Wiki.findPage(S.wikiLang, { id: a.id, name: ach?.name || a.name, context: 'Achievement' });
      if (!title) throw new Error('not found');
      const parsed = await Wiki.parse(S.wikiLang, title);
      return { ...parsed, ach: ach || a };
    })();
    S.wikiCache.set(ck, promise);
    promise.catch(() => S.wikiCache.delete(ck));
    return promise;
  }

  // Meta-Erfolg: keine Einzelschritte, Anforderung verweist auf andere Erfolge der Kategorie.
  // Plural („10 achievements in …“) – ein einzelnes „achievement“ im Text reicht nicht.
  const META_RE = /achievements|erfolge\b|succès|logros/i;
  function categoryIds(cat) {
    return (cat?.achievements || []).map((e) => (typeof e === 'object' ? e.id : e));
  }
  function isMeta(a) {
    if ((a.bits || []).length) return false;
    const cat = S.catOf.get(a.id);
    const others = categoryIds(cat).length - 1;
    const req = stripTags(a.requirement);
    const needed = Math.max(0, ...(a.tiers || []).map((t) => t.count));
    // Zählt Erfolge der eigenen Kategorie: Plural-Wort bzw. Kategoriename in der Anforderung,
    // und die benötigte Anzahl passt zur Zahl der anderen Erfolge der Kategorie.
    return (META_RE.test(req) || (cat && req.includes(cat.name))) && needed > 1 && needed <= others;
  }

  // Sucht im Wiki-Inhalt das kleinste Element (Tabellenzeile, Listeneintrag, …), das den Text enthält.
  function findWikiHint(content, label) {
    const full = norm(label).replace(/[.!:]+$/, '');
    if (!content || full.length < 3) return null;
    // Erst der ganze Text, dann ohne führende Wörter (mind. 2 Wörter, mind. 8 Zeichen)
    const words = full.split(' ');
    const STOP = /^(of|the|a|an|in|on|at|to|and|or|for|with|from|by|der|die|das|des|den|dem|im|am|und)$/;
    for (let i = 0; i < words.length - 1; i++) {
      if (i > 0 && STOP.test(words[i])) continue; // gekürzte Variante nie mit Füllwort beginnen
      const needle = words.slice(i).join(' ');
      if (i > 0 && needle.length < 8) break;
      const hit = findWikiHintExact(content, needle, full);
      if (hit) return hit;
    }
    return null;
  }

  function findWikiHintExact(content, needle, full) {
    let best = null;
    let bestLen = Infinity;
    for (const el of content.querySelectorAll('tr, li, dd, p, td')) {
      const len = norm(el.textContent).length;
      if (len < bestLen && norm(el.textContent).includes(needle)) { best = el; bestLen = len; }
    }
    if (!best) return null;
    // Nur wenn der Treffer selbst eine Zelle ist (eine Zeile pro Schritt), die ganze Zeile nehmen
    if (best.matches('td, th')) best = best.closest('tr');
    const len = norm(best.textContent).length;
    if (len > 1500 || len < Math.max(needle.length, full.length) + 6) return null; // zu groß oder nur der Name selbst -> kein Mehrwert
    if (best.tagName === 'TR') {
      const table = best.closest('table');
      const head = table?.querySelector('tr');
      const t = document.createElement('table');
      t.className = 'wikitable';
      if (head && head !== best && head.querySelector('th')) t.appendChild(head.cloneNode(true));
      t.appendChild(best.cloneNode(true));
      return t.outerHTML;
    }
    return best.innerHTML;
  }

  // Timegate: Tageslimit aus dem Wiki-Text („4 times per day“, „once per day“, „daily“ …)
  const TIMEGATE_RE = /\b(once|twice|\d+\s*(times?|x))\s*(per|a|each)\s*(day|week)\b|\bper day\b|\bdaily (limit|reset)\b|time-?gated?|timegate|once (per|a) (day|week)|\bper week\b/i;
  function timegateSentence(content) {
    if (!content) return null;
    for (const el of content.querySelectorAll('p, li, dd, td')) {
      if (el.querySelector('p, li, table')) continue;
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text.length < 400 && TIMEGATE_RE.test(text)) {
        const sentence = text.split(/(?<=[.!?])\s+/).find((x) => TIMEGATE_RE.test(x)) || text;
        return sentence;
      }
    }
    return null;
  }
  function untilReset(now = new Date()) {
    const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const min = Math.round((reset - now) / 60000);
    return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
  }

  const rerenderTodo = () => { if (S.lastTodo && $('#todo')) { renderTodo(...S.lastTodo); tagChatKinds(); } };

  // Handelsposten-Preise (Cache für die Sitzung)
  const priceCache = new Map();
  async function loadPrices(ids) {
    const missing = ids.filter((id) => !priceCache.has(id));
    if (missing.length) {
      const res = await GW2.prices(missing).catch(() => []);
      for (const id of missing) priceCache.set(id, null);
      for (const r of res) priceCache.set(r.id, { buy: r.sells?.unit_price || 0, bid: r.buys?.unit_price || 0 });
    }
  }

  // ---------- Orte & Wegmarken ----------
  const CHAT_TITLES = { waypoint: 'Waypoint', landmark: 'Point of interest', vista: 'Vista', area: 'Area', item: 'Item', map: 'Map location' };
  const chatBtn = (code, kind = Geo.kindOfChat(code)) => (code
    ? `<button type="button" class="chatlink k-${kind}" data-code="${esc(code)}" title="${CHAT_TITLES[kind] || 'Chat link'} – tap to copy, paste into the in-game chat">${esc(code)}</button>`
    : '');

  // Chat-Codes aus dem Wiki bekommen nachträglich ihr Symbol, sobald die Kartendaten da sind
  function tagChatKinds(root = document) {
    root.querySelectorAll('button.chatlink:not([class*="k-"])').forEach((b) => b.classList.add(`k-${Geo.kindOfChat(b.dataset.code)}`));
  }

  // Ort mit Art + eigenem Chat-Code, dazu nächste Wegmarke und nächste Sehenswürdigkeit
  const KIND = {
    waypoint: ['🔹', 'Waypoint'], landmark: ['◆', 'Point of interest'], vista: ['🔭', 'Vista'],
    area: ['📍', 'Area'], unlock: ['🔓', 'Point'],
  };
  const kindLabel = (k) => KIND[k] || ['📍', k || 'Location'];
  function waypointLine(place) {
    if (!place) return '';
    const [, label] = kindLabel(place.kind);
    const lines = [`${label}: <strong>${esc(place.name)}</strong>${place.kind === 'waypoint' ? '' : `, ${esc(Geo.mapName(place.map))}`} ${chatBtn(place.chat)}`];
    for (const kind of ['waypoint', 'landmark']) {
      if (place.kind === kind) continue;
      const n = Geo.nearest(place, kind);
      if (!n) continue;
      const [, nl] = kindLabel(kind);
      lines.push(`Nearest ${nl.toLowerCase()}: <strong>${esc(n.name)}</strong> ${chatBtn(n.chat)}`);
    }
    return `<div class="wp">${lines.join('<br>')}</div>`;
  }

  // NPCs/Orte aus dem Wiki-Abschnitt -> Standort (über die Wiki-Seite des NPCs) -> nächste Wegmarke
  const placeCache = new Map();
  async function placeFor(title) {
    const direct = Geo.locate(title);
    if (direct) return { place: direct };
    if (placeCache.has(title)) return placeCache.get(title);
    const promise = (async () => {
      const res = await Wiki.page(S.wikiLang, title);
      const page = Wiki.sanitize(S.wikiLang, res.html);
      // Nur ausdrückliche Standort-Angaben: Infobox-Feld „Location/Area/Zone …“ oder Abschnitt „Location(s)“.
      // Allgemeine Seiten (z. B. „Achievement“) haben so etwas nicht -> kein Ort.
      const LOC = /^(locations?|area|zone|map|region|sector|found in|standort|gebiet|ort)\s*:?$/i;
      const links = [];
      for (const label of page.querySelectorAll('th, dt, b, strong')) {
        if (!LOC.test(label.textContent.trim())) continue;
        const val = label.matches('th') ? label.nextElementSibling : label.matches('dt') ? label.nextElementSibling : label.parentElement;
        val?.querySelectorAll('a[data-wiki]').forEach((l) => links.push(l.dataset.wiki));
      }
      for (const h of page.querySelectorAll('h2, h3')) {
        if (!/^(locations?|standorte?|fundorte?)$/i.test(h.textContent.trim())) continue;
        const wrap = h.parentElement?.classList.contains('mw-heading') ? h.parentElement : h;
        for (let n = wrap.nextElementSibling; n && !n.matches('h2, h3, .mw-heading'); n = n.nextElementSibling) {
          n.querySelectorAll('a[data-wiki]').forEach((l) => links.push(l.dataset.wiki));
        }
      }
      for (const t of links.slice(0, 40)) {
        const place = Geo.locate(t);
        if (place) return { place, via: t };
      }
      return null;
    })().catch(() => null);
    placeCache.set(title, promise);
    return promise;
  }

  async function renderPlaces(a, inf, names, content, wikiNames, pageTitle, token) {
    const el = $('#places');
    if (inf.finished) { el.innerHTML = ''; return; }
    try { await Geo.load(S.wikiLang); } catch (e) { console.warn('Geo', e); return; }
    if (token !== S.viewToken) return;
    renderTodo(a, inf, names, content, wikiNames); // Schritte bekommen jetzt ihre Wegmarken
    tagChatKinds();

    const skip = new Set([norm(pageTitle), norm(a.name), ...(wikiNames || names).map((n) => norm(n.label))]);
    const titles = [...new Set([...content.querySelectorAll('a[data-wiki]')].map((l) => l.dataset.wiki))]
      .filter((t) => !skip.has(norm(t)) && !S.byName?.has(norm(t)) && !Geo.isMap(t))
      .slice(0, 6);
    if (!titles.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<h2>📍 Where to go</h2><p class="muted">Looking up locations…</p>';
    const found = (await Promise.all(titles.map(async (t) => ({ t, r: await placeFor(t) }))))
      .filter((x) => x.r && !skip.has(norm(x.r.place.name))); // schon an einem Schritt angezeigt
    if (token !== S.viewToken) return;
    const rows = found.map(({ t, r }) => {
      const line = waypointLine(r.place);
      if (!line) return '';
      return `<li><span class="check">📍</span><div class="grow"><a href="${wikiRoute(S.wikiLang, t)}">${esc(t)}</a>
        ${line}</div></li>`;
    }).filter(Boolean);
    tagChatKinds();
    el.innerHTML = rows.length ? `<h2>📍 Where to go</h2><ol class="steps">${rows.join('')}</ol>
      <p class="muted">Tap a chat code to copy it, paste it into the in-game chat and click it to see the spot on your map.</p>` : '';
  }

  // Bilder zu einem Schritt: Galerie-/Vorschaubilder, deren Beschriftung oder Dateiname den Schritt nennt
  function findWikiImages(content, label) {
    const needle = norm(label);
    if (!content || needle.length < 4) return '';
    const seen = new Set();
    const out = [];
    for (const img of content.querySelectorAll('img')) {
      if ((+img.getAttribute('width') || 100) < 60) continue; // Symbole überspringen
      const box = img.closest('.gallerybox') || img.closest('.thumb, figure') || img.closest('li, td');
      const caption = box?.querySelector('.gallerytext, .thumbcaption, figcaption')?.textContent || '';
      const file = decodeURIComponent((img.getAttribute('src') || '').split('/').pop()).replace(/_/g, ' ').replace(/^\d+px-/, '');
      const hay = norm(`${caption} ${img.getAttribute('alt') || ''} ${file}`);
      if (!hay.includes(needle) || seen.has(img.src)) continue;
      seen.add(img.src);
      out.push(`<figure class="step-img">${img.outerHTML}${caption.trim() ? `<figcaption>${esc(caption.trim())}</figcaption>` : ''}</figure>`);
      if (out.length >= 3) break;
    }
    return out.length ? `<div class="wiki step-imgs">${out.join('')}</div>` : '';
  }

  // Link im Wiki-Text, dessen Text genau dem Schritt entspricht (z. B. Ortsname -> eigene Wiki-Seite).
  function findWikiLink(content, label) {
    const needle = norm(label);
    return content ? [...content.querySelectorAll('a[data-wiki]')].find((l) => norm(l.textContent) === needle)?.dataset.wiki : null;
  }

  function manualKey(id) { return `manual-${id}`; }

  // Viele Erfolge haben keine eigene Wiki-Seite, sondern sind ein Abschnitt einer Kategorieseite
  // (z. B. „Explorer“). Schneidet nur den Teil zu diesem Erfolg heraus.
  function extractSection(content, name, otherNames) {
    const target = norm(name);
    const others = otherNames.map(norm).filter((n) => n.length > 3 && n !== target && !target.includes(n));
    const hasOther = (el) => { const t = norm(el.textContent); return others.some((n) => t.includes(n)); };
    const HEAD = 'h2, h3, h4, h5, h6';
    const rank = (el) => (el.matches(HEAD) || el.closest(HEAD) ? 0 : el.matches('caption, th, dt') ? 1 : el.matches('b, strong') ? 2 : el.tagName === 'A' ? 4 : 3);
    const cands = [...content.querySelectorAll('h2, h3, h4, h5, h6, caption, th, dt, b, strong, td, div, span, a')]
      .filter((el) => norm(el.textContent) === target)
      .sort((x, y) => rank(x) - rank(y));
    if (!cands.length) return null;
    const box = document.createElement('div');
    const start = cands[0];

    // Überschrift: alles bis zur nächsten Überschrift gleicher oder höherer Ebene
    const h = start.closest(HEAD);
    if (h) {
      const level = +h.tagName[1];
      const wrap = h.parentElement?.classList.contains('mw-heading') ? h.parentElement : h;
      const levelOf = (el) => { const hh = el.matches(HEAD) ? el : el.classList.contains('mw-heading') ? el.querySelector(HEAD) : null; return hh ? +hh.tagName[1] : 99; };
      for (let n = wrap.nextElementSibling; n && levelOf(n) > level; n = n.nextElementSibling) box.appendChild(n.cloneNode(true));
      return box.childNodes.length ? box : null;
    }

    // Sonst: vom Namen aus nach oben, solange kein anderer Erfolg mit hineinrutscht
    let node = start;
    while (node.parentElement && node.parentElement !== content && !hasOther(node.parentElement)) node = node.parentElement;
    // Nur der Titel erwischt (z. B. Kopfzeile einer Tabelle)? Dann folgende Geschwister dazunehmen.
    const parts = [node];
    if (norm(node.textContent).length < target.length + 25) {
      for (let n = node.nextElementSibling; n && !hasOther(n) && !n.matches(HEAD) && !n.classList.contains('mw-heading'); n = n.nextElementSibling) parts.push(n);
    }
    if (parts[0].tagName === 'TR') {
      const table = document.createElement('table');
      table.className = parts[0].closest('table')?.className || '';
      parts.forEach((r) => table.appendChild(r.cloneNode(true)));
      box.appendChild(table);
    } else {
      parts.forEach((n) => box.appendChild(n.cloneNode(true)));
    }
    return box;
  }

  // Anforderung aus einem herausgeschnittenen Abschnitt: erster Text, der nicht Titel oder Flavor-Text ist.
  function sectionRequirement(section, name) {
    const target = norm(name);
    for (const el of section.querySelectorAll('p, td, dd, div')) {
      if (el.querySelector('p, td, dd, div, table')) continue;
      const c = el.cloneNode(true);
      c.querySelectorAll('i, em, ul, ol, dl, table, button, img').forEach((x) => x.remove());
      const text = c.textContent.replace(/\s+/g, ' ').trim().replace(/\s*Objectives?:?$/i, '');
      if (text.length >= 8 && norm(text) !== target) return text;
    }
    return '';
  }

  // Freischaltung aus dem Wiki: erster kurzer Satz/Absatz mit „unlock“; darin genannte Erfolge werden verlinkt.
  const UNLOCK_RE = /\bunlock(s|ed)?\b|prerequisites?|requires? (the )?complet|after (completing|finishing)|must (first )?(complete|finish)|only (becomes )?available after|freigeschaltet|voraussetzung|déverrouill/i;
  function wikiUnlockHint(content) {
    // Beschriftung „Prerequisite(s)“ – als Tabellen-/Listenfeld, fetter Text, Überschrift oder eigener Block
    const LABEL = /^(prerequisites?|requires|required|unlocked by|unlock requirements?|voraussetzung(en)?)\s*:?$/i;
    const HEAD = 'h2, h3, h4, h5, h6';
    for (const label of content.querySelectorAll('th, dt, b, strong, h2, h3, h4, h5, h6, div, span, p, caption')) {
      if (!LABEL.test(label.textContent.trim())) continue;
      if ([...label.children].some((c) => LABEL.test(c.textContent.trim()))) continue; // inneres Element übernimmt
      const vals = [];
      const heading = label.closest(HEAD) || (label.matches('div, span, p, caption') && !label.children.length ? label : null);
      if (label.matches('th, dt')) vals.push(label.nextElementSibling);
      else if (heading) {
        // Überschrift/Block: folgende Geschwister bis zur nächsten Überschrift
        const wrap = heading.parentElement?.classList.contains('mw-heading') ? heading.parentElement : heading;
        for (let n = wrap.nextElementSibling; n && !n.matches(HEAD) && !n.classList.contains('mw-heading') && vals.length < 4; n = n.nextElementSibling) vals.push(n);
      } else vals.push(label.parentElement);
      const text = vals.map((v) => v?.textContent || '').join(' ').replace(label.textContent, '').replace(/\s+/g, ' ').trim().replace(/^:\s*/, '');
      if (text.length > 2 && text.length < 500) {
        const achs = vals.flatMap((v) => [...(v?.querySelectorAll('a[data-wiki]') || [])])
          .map((l) => S.byName?.get(norm(l.dataset.wiki))).filter(Boolean);
        return { text: `Prerequisite: ${text}`, achs };
      }
    }
    for (const el of content.querySelectorAll('p, li, dd, td')) {
      if (el.querySelector('p, li, table')) continue;
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text.length > 400 || !UNLOCK_RE.test(text)) continue;
      if (/mount unlock|skin unlock|unlocks? the (title|skin)/i.test(text) && !/after|complet|abschlie/i.test(text)) continue;
      const achs = [...el.querySelectorAll('a[data-wiki]')].map((l) => S.byName?.get(norm(l.dataset.wiki))).filter(Boolean);
      return { text, achs };
    }
    return null;
  }

  // Einleitung „… part of the third step of the Skyscale collection“ -> verlinkte Übersichtsseite(n)
  function wikiPartOf(content, selfTitle) {
    for (const p of content.querySelectorAll('p')) {
      const text = p.textContent;
      if (!/\b(part|step|chapter|stage)\b.*\bof\b|\bteil\b/i.test(text)) continue;
      const links = [...p.querySelectorAll('a[data-wiki]')]
        .map((l) => l.dataset.wiki)
        .filter((t) => norm(t) !== norm(selfTitle) && !/achievement|erfolg/i.test(t) && !S.byName?.has(norm(t)));
      if (links.length) return [...new Set(links)];
    }
    return [];
  }

  // Anforderung: API-Text, sonst aus dem Wiki (manche Erfolge haben in der API kein Anforderungsfeld).
  function requirementOf(a) {
    return stripTags(a.requirement).replace(/\s+/g, ' ').trim() || S.wikiReq.get(a.id) || '';
  }

  // Sucht im Wiki-Text die Anforderung: erst ein „Requirement“-Feld, sonst die ersten Absätze der Einleitung.
  function wikiRequirement(content) {
    for (const el of content.querySelectorAll('th, dt, b, strong')) {
      if (!/^(requirements?|objectives?|anforderung(en)?|ziel)\s*:?$/i.test(el.textContent.trim())) continue;
      const val = el.tagName === 'TH' ? el.nextElementSibling
        : el.tagName === 'DT' ? el.nextElementSibling
          : el.parentElement;
      const text = (val?.textContent || '').replace(el.textContent, '').replace(/\s+/g, ' ').trim().replace(/^:\s*/, '');
      if (text.length > 3) return text;
    }
    const intro = [];
    for (const node of content.children) {
      if (/^H[1-6]$/.test(node.tagName)) break;
      if (node.tagName === 'P' && !node.closest('table')) {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t.length > 20) intro.push(t);
      }
      if (intro.length >= 2) break;
    }
    return intro.join(' ');
  }

  // Ein Text-Schritt, der genau wie ein anderer Erfolg heißt (z. B. bei Story-Metas).
  function linkedAch(n) {
    return n.type === 'Text' ? S.byName?.get(norm(n.label).replace(/[.!]+$/, '')) : null;
  }

  // Hauptbereich: nur das, was noch zu tun ist. Erledigtes landet eingeklappt darunter.
  function renderTodo(a, inf, names, content, wikiNames) {
    const el = $('#todo');
    S.lastTodo = [a, inf, names, content, wikiNames];
    const todo = [];
    const done = [];
    const item = (html, cls = '') => `<li class="${cls}">${html}</li>`;
    const achItem = (oa, mark) => item(`<span class="check">${mark}</span><div class="grow">
      <a href="#/a/${oa.id}">${esc(oa.name)}</a> ${stateBadge(oa)}
      <div class="sub" style="margin-left:0">${esc(stripTags(oa.requirement).replace(/\s+/g, ' '))}</div></div>`);
    let lead = '';
    let needsGuide = false;

    // 1. Offene Voraussetzungen zuerst
    for (const pa of prereqChain(a)) {
      if (Progress.info(pa, S.progress.get(pa.id)).finished) continue;
      todo.push(item(`<span class="check">🔒</span><div class="grow"><strong>Complete first:</strong>
        <a href="#/a/${pa.id}">${esc(pa.name)}</a>
        <div class="sub" style="margin-left:0">${esc(stripTags(pa.requirement).replace(/\s+/g, ' '))}</div></div>`));
    }
    if (inf.needsUnlock) {
      const uh = S.wikiUnlock.get(a.id) || {};
      const cat = S.catOf.get(a.id);
      const grp = cat && S.groupOf.get(cat.id);
      const story = /story journal|storyjournal|journal/i.test(grp?.name || '');
      const lines = [];
      if (stripTags(a.locked_text) || uh.text) lines.push(esc(stripTags(a.locked_text) || uh.text));
      else if (story) lines.push(`Play the “${esc(cat.name)}” story first (Story Journal).`);
      (uh.achs || []).filter((x) => x.id !== a.id)
        .forEach((x) => lines.push(`<a href="#/a/${x.id}">${esc(x.name)}</a> ${stateBadge(x)}`));
      (uh.partOf || []).forEach((t) => lines.push(`Part of <a href="${wikiRoute(S.wikiLang, t)}">${esc(t)}</a> – the full chain and walkthrough are there ›`));
      if (!lines.length) lines.push('Not stated on the wiki page – see the wiki guide below.');
      todo.push(item(`<span class="check">🔒</span><div class="grow"><strong>Unlock first:</strong> ${lines.map((l) => `<div>${l}</div>`).join('')}</div>`));
    }

    // Event-Timer (Weltbosse) und Timegate
    if (!inf.finished) {
      const timer = Timers.forAchievement(a, S.catOf.get(a.id));
      if (timer) {
        todo.push(item(`<span class="check">⏰</span><div class="grow"><strong>${esc(timer.label)}</strong>
          <div class="sub" style="margin-left:0">${esc(timer.ev.map)} · times are a fixed daily schedule –
          <a href="${wikiRoute(S.wikiLang, 'Event timers')}">check the wiki event timers</a></div></div>`));
      }
      const gate = timegateSentence(content);
      if (gate) {
        const p = S.progress.get(a.id);
        const gained = S.snap && p ? (p.current || 0) - (S.snap.cur[a.id] || 0) : 0;
        todo.push(item(`<span class="check">⏳</span><div class="grow"><strong>Time-gated:</strong> ${esc(gate)}
          <div class="sub" style="margin-left:0">${S.account ? (gained > 0 ? `✔ Today: +${gained} progress · ` : 'No progress yet today · ') : ''}daily reset in ${untilReset()} (00:00 UTC)</div></div>`));
      }
    }

    const bits = a.bits || [];
    const manual = new Set(Store.get(manualKey(a.id), []));
    if (inf.finished) {
      lead = '<p class="ok-text">✔ Completed – nothing left to do here.</p>';
    } else if (bits.length) {
      // 2a. Einzelschritte (Sammlungen, Orte, Story-Kapitel …)
      const doneCount = bits.filter((_, i) => inf.bitsDone.has(i)).length;
      const needed = inf.maxCount && inf.maxCount < bits.length ? inf.maxCount : bits.length;
      // Kosten der fehlenden, handelbaren Items (bei „x von y“ nur die günstigsten nötigen)
      const openBits = bits.map((b, i) => ({ b, i })).filter(({ i }) => !inf.bitsDone.has(i));
      const stillNeeded = Math.max(0, needed - doneCount);
      const ownedOpen = openBits.filter(({ b }) => b.type === 'Item' && S.inv?.get(b.id)).length;
      const buyable = openBits.filter(({ b }) => b.type === 'Item' && !S.inv?.get(b.id)).map(({ b }) => priceCache.get(b.id)?.buy).filter(Boolean).sort((x, y) => x - y);
      const toBuy = Math.max(0, stillNeeded - ownedOpen);
      const costSum = buyable.slice(0, needed < bits.length ? toBuy : buyable.length).reduce((x, y) => x + y, 0);
      const costPill = costSum ? `<span class="pill" title="Instant-buy price of the missing tradable items">💰 ≈ ${coins(costSum)} on the TP</span>` : '';
      const ownPill = ownedOpen ? `<span class="pill ok" title="Open items you already have in your account">✔ ${ownedOpen} already in your account</span>` : '';
      if (S.account) {
        lead = `<p class="summary">${costPill}${ownPill}<span class="pill warn">${Math.max(0, needed - doneCount)} left</span>
          <span class="pill">${doneCount} / ${needed} done</span>
          ${needed < bits.length ? `<span class="muted">– you only need ${needed} of ${bits.length}, pick the easiest.</span>` : ''}</p>`;
      }
      bits.forEach((_, i) => {
        const n = names[i];
        const apiDone = inf.bitsDone.has(i);
        const wikiLabel = wikiNames?.[i]?.label || n.label;
        const linked = linkedAch(n);
        const label = linked
          ? `<a href="#/a/${linked.id}">${esc(n.label)}</a> ${stateBadge(linked)}`
          : `<span class="${n.rarity ? `r-${esc(n.rarity)}` : ''}">${esc(n.label)}</span>`;
        const typeName = { Item: 'Item', Skin: 'Skin', Minipet: 'Miniature' }[n.type] || '';
        const head = `<div>${n.icon ? `<img class="mini" src="${esc(n.icon)}" alt="">` : ''}${label}
          ${typeName ? `<span class="sub">${typeName}</span>` : ''}
          ${n.type !== 'Text' ? `<a class="sub" href="${wikiRoute(S.wikiLang, wikiLabel)}">Wiki page</a>` : ''}</div>`;
        if (apiDone) { done.push(item(`<span class="check">✔</span><div class="grow">${head}</div>`, 'done')); return; }
        const hint = content ? findWikiHint(content, wikiLabel) : null;
        const own = n.type === 'Item' ? S.inv?.get(n.id) : null;
        const price = n.type === 'Item' && !own ? priceCache.get(n.id) : null;
        const ownLine = own
          ? `<div class="own">✔ You already have <strong>${own.count}×</strong> (${esc([...own.where].join(', '))}). If it isn't counted yet: right-click the item → <em>Add to achievement</em>.</div>`
          : '';
        const priceLine = price?.buy ? `<div class="price">💰 ${coins(price.buy)} on the Trading Post <span class="sub">(buy now)</span></div>` : '';
        const wpLine = n.type === 'Text' ? waypointLine(Geo.locate(wikiLabel)) : '';
        const imgs = content && !(hint && hint.includes('<img')) ? findWikiImages(content, wikiLabel) : '';
        const mark = S.account ? '○' : `<input type="checkbox" class="manual" data-bit="${i}" ${manual.has(i) ? 'checked' : ''} title="Tick off manually (no API key)">`;
        todo.push(item(`<span class="check">${mark}</span><div class="grow">${head}
          ${ownLine}${priceLine}
          ${wpLine}
          ${hint ? `<div class="hint wiki">${hint}</div>` : ''}
          ${imgs}
          ${!hint && !own && n.type !== 'Text' ? `<button class="small acq" data-bit="${i}">How do I get this? (wiki)</button><div class="acq-out wiki"></div>` : ''}
          ${!hint && !imgs && n.type === 'Text' && !linked && content ? (findWikiLink(content, wikiLabel)
            ? `<a class="sub" style="margin-left:0" href="${wikiRoute(S.wikiLang, findWikiLink(content, wikiLabel))}">Wiki page: where is it? ›</a>`
            : '<div class="sub" style="margin-left:0">Not matched to a wiki entry automatically – check the full wiki guide below.</div>') : ''}
        </div>`, !S.account && manual.has(i) ? 'done' : ''));
      });
    } else if (isMeta(a)) {
      // 2b. Meta-Erfolg: offene Erfolge der Kategorie
      const cat = S.catOf.get(a.id);
      const others = categoryIds(cat).filter((id) => id !== a.id).map((id) => S.ach.get(id)).filter(Boolean);
      for (const oa of others) {
        const f = Progress.info(oa, S.progress.get(oa.id)).finished;
        (f ? done : todo).push(achItem(oa, f ? '✔' : '○'));
      }
      if (S.account) {
        lead = `<p class="summary"><span class="pill warn">${Math.max(0, inf.maxCount - inf.current)} achievements left</span>
          <span class="pill">${inf.current} / ${inf.maxCount} done</span>
          <span class="muted">– from these open achievements in “${esc(cat.name)}”:</span></p>`;
      }
    } else {
      // 2c. Zähl- oder Einzel-Erfolg: die Anforderung ist die Aufgabe, Anleitung aus dem Wiki
      needsGuide = true;
      const rest = inf.maxCount - inf.current;
      todo.push(item(`<span class="check">○</span><div class="grow">
        ${S.account && inf.maxCount > 1 ? `<strong>${rest.toLocaleString('en-US')}× left</strong> – ` : ''}${esc(requirementOf(a)) || 'See the wiki guide'}
        ${inf.tiers.length > 1 && inf.next ? `<div class="sub" style="margin-left:0">Next tier at ${inf.next.count} (+${inf.next.points} AP)</div>` : ''}</div>`));
    }

    el.innerHTML = `<h2>What you still need to do</h2>${lead}
      ${todo.length ? `<ol class="steps">${todo.join('')}</ol>` : ''}
      ${needsGuide ? '<p class="muted">How to do it: see the wiki guide right below.</p>' : ''}`;

    const doneBox = $('#done-box');
    doneBox.hidden = !done.length;
    doneBox.querySelector('summary').textContent = `✔ Already done (${done.length})`;
    $('#done-body').innerHTML = `<ol class="steps">${done.join('')}</ol>`;
    // Ohne konkrete Schritte ist der Wiki-Guide die Anleitung -> aufklappen
    $('#guide-box').open = needsGuide && !inf.finished;

    el.querySelectorAll('input.manual').forEach((cb) => cb.addEventListener('change', () => {
      const i = +cb.dataset.bit;
      cb.checked ? manual.add(i) : manual.delete(i);
      Store.set(manualKey(a.id), [...manual]);
      cb.closest('li').classList.toggle('done', cb.checked);
    }));
    el.querySelectorAll('button.acq').forEach((btn) => btn.addEventListener('click', async () => {
      const i = +btn.dataset.bit;
      const out = btn.nextElementSibling;
      const n = wikiNames?.[i] || names[i];
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const res = await Wiki.acquisition(S.wikiLang, { type: n.type, id: n.id, name: n.label });
        if (!res) throw new Error('No wiki page found');
        const node = Wiki.sanitize(S.wikiLang, res.html);
        out.innerHTML = `<div class="sub">From <a href="${wikiRoute(S.wikiLang, res.title)}">${esc(res.title)}</a>${res.sectionName ? ` › ${esc(res.sectionName)}` : ''}</div>`;
        out.appendChild(node);
        btn.remove();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'How do I get this? (wiki)';
        out.innerHTML = `<span class="muted">${esc(e.message)}</span>`;
      }
    }));
    bindAnchors(el);
  }

  const OPEN_SECTIONS = /walkthrough|guide|objective|collection|location|strategy|tips|ziel|lösung|anleitung|fundort|sammlung|tipps|strategie/i;

  function renderGuide(content, title, sectionName) {
    const el = $('#guide');
    el.innerHTML = `<p class="muted">From the Guild Wars 2 Wiki: <a href="${wikiRoute(S.wikiLang, title)}">${esc(title)}</a>${sectionName ? ` (only the part about “${esc(sectionName)}”)` : ''} (CC BY-NC-SA).
      Tap images to enlarge, tap chat codes to copy.</p>`;
    renderSections(el, content);
  }

  // Wiki-Inhalt in Abschnitte (h2) aufteilen; relevante Abschnitte aufgeklappt.
  function renderSections(el, content, openAll = false) {
    let current = document.createElement('div');
    current.className = 'wiki intro';
    el.appendChild(current);
    for (const node of [...content.cloneNode(true).childNodes]) {
      if (node.nodeType === 1 && node.tagName === 'H2') {
        const name = node.textContent.trim();
        const det = document.createElement('details');
        det.open = openAll || OPEN_SECTIONS.test(name);
        det.innerHTML = `<summary>${esc(name)}</summary>`;
        const anchor = node.querySelector('[id]');
        if (anchor) det.id = anchor.id;
        current = document.createElement('div');
        current.className = 'wiki';
        det.appendChild(current);
        el.appendChild(det);
      } else {
        current.appendChild(node);
      }
    }
    bindAnchors(el);
  }

  const wikiRoute = (lang, title) => `#/wiki/${lang}/${encodeURIComponent(title)}`;

  // ---------- Wiki-Seite innerhalb der App ----------
  async function showWikiPage(lang, title) {
    setNav(null);
    const token = ++S.viewToken;
    const [pageTitle, anchor] = title.split('#');
    view.innerHTML = `
      <p><a href="javascript:history.back()" class="link">← Back</a></p>
      <h1>${esc(pageTitle)}</h1>
      <div id="wiki-page"><p class="muted">Loading wiki page…</p></div>`;
    try {
      const res = await Wiki.page(lang, pageTitle);
      if (token !== S.viewToken) return;
      const content = Wiki.sanitize(lang, res.html);
      view.querySelector('h1').innerHTML = `${esc(res.title)}
        <a class="sub" target="_blank" rel="noopener" href="${Wiki.pageUrl(lang, res.title)}">in browser ↗</a>`;
      const el = $('#wiki-page');
      el.innerHTML = '';
      renderSections(el, content, true);
      Geo.load(S.wikiLang).then(() => tagChatKinds(el)).catch(() => tagChatKinds(el));
      if (anchor) document.getElementById(anchor)?.scrollIntoView();
    } catch (e) {
      if (token !== S.viewToken) return;
      $('#wiki-page').innerHTML = `<p class="err">Could not load page: ${esc(e.message)}</p>
        <a target="_blank" rel="noopener" href="${Wiki.searchUrl(lang, pageTitle)}">Search the wiki ↗</a>`;
    }
  }

  // ---------- Bild-Großansicht & Chat-Codes ----------
  function openLightbox(src, caption, fileTitle, lang) {
    const box = $('#lightbox');
    box.innerHTML = `<figure>
      <img src="${esc(src)}" alt="">
      <figcaption>${esc(caption || '')}
        ${fileTitle ? `<a target="_blank" rel="noopener" href="${Wiki.pageUrl(lang, fileTitle)}">File page ↗</a>` : ''}
        <span class="muted">· Click or Esc to close</span></figcaption></figure>`;
    box.hidden = false;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  document.addEventListener('click', (e) => {
    const chat = e.target.closest('button.chatlink');
    if (chat) {
      e.preventDefault();
      copyText(chat.dataset.code).then(() => toast(`${chat.dataset.code} copied – paste it into the in-game chat with Ctrl+V.`));
      chat.classList.add('copied');
      setTimeout(() => chat.classList.remove('copied'), 1200);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey) return; // Mit Modifikator: normal im Browser öffnen
    const link = e.target.closest('a[data-file], a[data-wiki]');
    const img = e.target.closest('.wiki img');
    if (link?.dataset.wiki) {
      e.preventDefault();
      location.hash = wikiRoute(link.dataset.wikiLang || S.wikiLang, link.dataset.wiki);
      return;
    }
    if (img && (link?.dataset.file || !e.target.closest('a'))) {
      if (img.naturalWidth && img.naturalWidth < 40 && !link) return; // Mini-Symbole ignorieren
      e.preventDefault();
      const caption = img.closest('.thumb, .gallerybox, figure')?.querySelector('.thumbcaption, .gallerytext, figcaption')?.textContent.trim() || img.alt;
      openLightbox(Wiki.fullImageUrl(img.currentSrc || img.src), caption, link?.dataset.file, S.wikiLang);
    }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#lightbox').hidden = true; });

  function bindAnchors(root) {
    root.querySelectorAll('a[data-anchor]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(a.dataset.anchor);
      if (target) {
        const det = target.closest('details');
        if (det) det.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }));
  }

  // ---------- Leichte AP ----------
  function computeEasyRows() {
    const rows = [];
    for (const a of S.ach.values()) {
      const cat = S.catOf.get(a.id);
      if (!cat) continue; // Nicht kategorisierte Erfolge sind meist nicht mehr erreichbar.
      const p = S.progress.get(a.id);
      const inf = Progress.info(a, p);
      if (inf.periodic || inf.remainingAP <= 0 || !inf.next) continue;
      const locked = inf.needsUnlock || (a.prerequisites || []).some((pid) => {
        const pa = S.ach.get(pid);
        return pa && !Progress.info(pa, S.progress.get(pid)).finished;
      });
      const meta = isMeta(a);
      const grp = S.groupOf.get(cat.id);
      const historic = /^(historisch|historic|historique|histórico)/i.test(grp?.name || '');
      // Guild Wars 1: Halle der Monumente (Punkte kommen aus dem GW1-Account)
      const gw1 = /monument|guild wars 1|gw1/i.test(`${cat.name} ${grp?.name || ''}`);
      rows.push({ a, inf, cat, grp, locked, meta, historic, gw1, ease: inf.ease * (meta ? 0.1 : 1) });
    }
    return rows;
  }

  function showEasy() {
    setNav('easy');
    if (!S.account) {
      view.innerHTML = `<h1>Easy AP</h1><p>The Easy AP finder needs your progress.
        <a href="#/settings">Add an API key first</a> (permissions: <code>account</code> + <code>progression</code>).</p>`;
      return;
    }
    if (!S.easyRows) S.easyRows = computeEasyRows();
    const f = S.easy;
    view.innerHTML = `
      <h1>Easy AP</h1>
      <p class="muted">Open achievements, sorted by estimated ease: AP of the next tier, how many steps are left and how far along you are.
        Daily/weekly achievements and uncategorized (usually unobtainable) achievements are hidden.</p>
      <div class="filters">
        <label>Sort by
          <select id="f-sort">
            <option value="ease">Easiest (recommended)</option>
            <option value="progress">Almost done</option>
            <option value="steps">Fewest steps to next tier</option>
            <option value="next">Most AP in next tier</option>
            <option value="remaining">Most remaining AP</option>
          </select></label>
        <label>Reward
          <select id="f-reward">
            <option value="">Any</option>
            <option value="Mastery">⭐ Mastery point</option>
            <option value="Title">🏷️ Title</option>
            <option value="Item">🎁 Item</option>
            <option value="Coins">💰 Gold</option>
          </select></label>
        <label>Min. progress <input id="f-min" type="range" min="0" max="95" step="5" value="${f.minProgress}"> <span id="f-min-v">${f.minProgress}%</span></label>
        <label><input type="checkbox" id="f-started" ${f.onlyStarted ? 'checked' : ''}> Started only</label>
        <label><input type="checkbox" id="f-locked" ${f.hideLocked ? 'checked' : ''}> Hide locked</label>
        <label><input type="checkbox" id="f-pvp" ${f.hidePvp ? 'checked' : ''}> Hide PvP</label>
        <label><input type="checkbox" id="f-rep" ${f.hideRepeatable ? 'checked' : ''}> Hide repeatable</label>
        <label title="Past/seasonal events – only doable while the festival is running"><input type="checkbox" id="f-hist" ${f.hideHistoric !== false ? 'checked' : ''}> Hide historic</label>
        <label title="Hall of Monuments – requires a Guild Wars 1 account"><input type="checkbox" id="f-gw1" ${f.hideGw1 !== false ? 'checked' : ''}> Hide GW1 achievements</label>
        <label title="Meta achievements require several other achievements"><input type="checkbox" id="f-meta" ${f.hideMeta ? 'checked' : ''}> Hide meta achievements</label>
      </div>
      <details class="groups"><summary>Filter groups (${S.groups.length - f.excludedGroups.length}/${S.groups.length} active)</summary>
        <div class="group-list">${S.groups.map((g) => `<label><input type="checkbox" class="f-group" value="${esc(g.id)}" ${f.excludedGroups.includes(g.id) ? '' : 'checked'}> ${esc(g.name)}</label>`).join('')}</div>
      </details>
      <div id="easy-summary" class="muted"></div>
      <div id="easy-table"></div>`;
    $('#f-sort').value = f.sort;
    $('#f-reward').value = f.reward || '';
    $('#f-reward').onchange = (e) => { f.reward = e.target.value; update(); };
    const update = () => { Store.set('easyFilters', f); renderEasyTable(); };
    $('#f-sort').onchange = (e) => { f.sort = e.target.value; update(); };
    $('#f-min').oninput = (e) => { f.minProgress = +e.target.value; $('#f-min-v').textContent = `${f.minProgress}%`; update(); };
    $('#f-started').onchange = (e) => { f.onlyStarted = e.target.checked; update(); };
    $('#f-locked').onchange = (e) => { f.hideLocked = e.target.checked; update(); };
    $('#f-pvp').onchange = (e) => { f.hidePvp = e.target.checked; update(); };
    $('#f-rep').onchange = (e) => { f.hideRepeatable = e.target.checked; update(); };
    $('#f-hist').onchange = (e) => { f.hideHistoric = e.target.checked; update(); };
    $('#f-meta').onchange = (e) => { f.hideMeta = e.target.checked; update(); };
    $('#f-gw1').onchange = (e) => { f.hideGw1 = e.target.checked; update(); };
    view.querySelectorAll('.f-group').forEach((cb) => cb.onchange = () => {
      f.excludedGroups = [...view.querySelectorAll('.f-group')].filter((c) => !c.checked).map((c) => c.value);
      $('.groups summary').textContent = `Filter groups (${S.groups.length - f.excludedGroups.length}/${S.groups.length} active)`;
      update();
    });
    renderEasyTable();
  }

  // Kleine Belohnungs-Symbole in der Liste
  function rewardBadges(a) {
    const rw = a.rewards || [];
    const icons = [];
    const mastery = rw.find((w) => w.type === 'Mastery');
    if (mastery) icons.push(`<span class="pill" title="Mastery point (${esc(mastery.region)})">⭐ ${esc(mastery.region)}</span>`);
    if (rw.some((w) => w.type === 'Title')) icons.push('<span class="pill" title="Title">🏷️</span>');
    if (rw.some((w) => w.type === 'Item')) icons.push('<span class="pill" title="Item reward">🎁</span>');
    return icons.length ? ` ${icons.join(' ')}` : '';
  }

  function renderEasyTable() {
    const f = S.easy;
    const excluded = new Set(f.excludedGroups);
    let rows = S.easyRows.filter((r) =>
      !(f.hideLocked && r.locked) &&
      !(f.hidePvp && (r.a.flags || []).includes('Pvp')) &&
      !(f.hideRepeatable && r.inf.repeatable) &&
      !(f.hideHistoric !== false && r.historic) &&
      !(f.hideMeta && r.meta) &&
      !(f.hideGw1 !== false && r.gw1) &&
      !(f.reward && !(r.a.rewards || []).some((w) => w.type === f.reward)) &&
      !(f.onlyStarted && r.inf.current === 0) &&
      r.inf.frac * 100 >= f.minProgress &&
      !(r.grp && excluded.has(r.grp.id)));
    const sorters = {
      ease: (x, y) => y.ease - x.ease,
      progress: (x, y) => y.inf.next.frac - x.inf.next.frac || x.inf.next.steps - y.inf.next.steps,
      steps: (x, y) => x.inf.next.steps - y.inf.next.steps || y.inf.next.points - x.inf.next.points,
      next: (x, y) => y.inf.next.points - x.inf.next.points || y.ease - x.ease,
      remaining: (x, y) => y.inf.remainingAP - x.inf.remainingAP || y.ease - x.ease,
    };
    rows.sort(sorters[f.sort] || sorters.ease);
    const sumNext = rows.reduce((s, r) => s + r.inf.next.points, 0);
    const sumAll = rows.reduce((s, r) => s + (isFinite(r.inf.remainingAP) ? r.inf.remainingAP : 0), 0);
    $('#easy-summary').textContent = `${rows.length} achievements · ${sumNext.toLocaleString('en-US')} AP in their next tier · ${sumAll.toLocaleString('en-US')} AP remaining in total`;
    const top = rows.slice(0, 200);
    $('#easy-table').innerHTML = `<table class="easy">
      <thead><tr><th></th><th>Achievement</th><th>Progress</th><th title="Steps to the next tier">Next tier</th><th>Left</th></tr></thead>
      <tbody>${top.map((r) => `<tr onclick="location.hash='#/a/${r.a.id}'">
        <td>${achIcon(r.a)}</td>
        <td><a href="#/a/${r.a.id}">${esc(r.a.name)}</a>${r.locked ? ' <span class="pill warn" title="Prerequisite/unlock missing">🔒</span>' : ''}${r.meta ? ' <span class="pill" title="Requires several other achievements in this category">Meta</span>' : ''}${rewardBadges(r.a)}
          <div class="sub">${catPath(r.a)}</div></td>
        <td class="prog">${bar(r.inf.frac)}<span class="sub">${r.inf.current}/${r.inf.maxCount}</span></td>
        <td><strong>+${r.inf.next.points} AP</strong><div class="sub">${r.inf.next.steps} to go</div></td>
        <td>${isFinite(r.inf.remainingAP) ? r.inf.remainingAP : '∞'} AP</td>
      </tr>`).join('')}</tbody></table>
      ${rows.length > top.length ? `<p class="muted">Showing the first 200 of ${rows.length}.</p>` : ''}`;
  }

  // ---------- API-Key ----------
  async function saveKey(raw, info) {
    const key = raw.trim();
    if (!key) { info.innerHTML = '<span class="err">Please paste an API key.</span>'; return false; }
    info.textContent = 'Checking key…';
    try {
      const t = await GW2.tokenInfo(key);
      const missing = ['account', 'progression'].filter((p) => !t.permissions.includes(p));
      if (missing.length) { info.innerHTML = `<span class="err">The key is missing permissions: ${missing.join(', ')}</span>`; return false; }
      S.key = key;
      Store.set('apiKey', key);
      await loadProgress();
      const extra = ['inventories', 'characters'].filter((p) => !t.permissions.includes(p));
      info.innerHTML = `<span class="ok-text">✔ Key “${esc(t.name)}” saved – progress for ${S.progress.size} achievements loaded.</span>
        ${extra.length ? `<br><span class="muted">Tip: add ${extra.map((x) => `<code>${x}</code>`).join(' + ')} to see which collection items you already own.</span>` : ''}`;
      return true;
    } catch (e) {
      info.innerHTML = `<span class="err">Invalid key: ${esc(e.message)}</span>`;
      return false;
    }
  }

  function keyCardHtml() {
    return `<div class="card key-card">
      <h2>🔑 Add your API key</h2>
      <p class="muted">So the tool knows what you already have: create a key on
        <a href="https://account.arena.net/applications" target="_blank" rel="noopener">account.arena.net/applications</a>
        with the permissions <code>account</code> and <code>progression</code> and paste it here.
        Optional: add <code>inventories</code> and <code>characters</code> so the tool can see which collection items you already own.
        It is only stored locally and only sent to the official GW2 API.</p>
      <div class="key-row">
        <input id="home-key" type="password" placeholder="Paste API key here (Ctrl+V)" autocomplete="off">
        <button id="home-key-save">Save</button>
      </div>
      <div id="home-key-info" class="muted"></div>
    </div>`;
  }

  // ---------- Einstellungen ----------
  function showSettings() {
    setNav('settings');
    view.innerHTML = `
      <h1>Settings</h1>
      <div class="card">
        <h2>GW2 API key</h2>
        <p class="muted">Create a key on <a href="https://account.arena.net/applications" target="_blank" rel="noopener">account.arena.net/applications</a>
          with the permissions <code>account</code> and <code>progression</code>.
          Optional: <code>inventories</code> + <code>characters</code> – shows collection items you already own (bank, materials, bags).
          The key is only stored locally in your browser and only sent to api.guildwars2.com.</p>
        <input id="s-key" type="password" placeholder="XXXXXXXX-XXXX-…" value="${esc(S.key)}" autocomplete="off">
        <div class="row-btns"><button id="s-save">Save & check</button><button id="s-clear" class="secondary">Remove key</button></div>
        <div id="s-key-info" class="muted"></div>
      </div>
      <div class="card">
        <h2>Language</h2>
        <label>Game data <select id="s-lang">
          <option value="en">English</option><option value="de">Deutsch</option><option value="fr">Français</option><option value="es">Español</option>
        </select></label>
        <label>Wiki <select id="s-wiki">
          <option value="en">English (more complete, recommended)</option><option value="de">Deutsch</option>
        </select></label>
      </div>
      <div class="card">
        <h2>Data</h2>
        <p class="muted">Achievement data is cached locally for one week.</p>
        <button id="s-refresh" class="secondary">Reload achievement data now</button>
      </div>`;
    $('#s-lang').value = S.lang;
    $('#s-wiki').value = S.wikiLang;
    $('#s-save').onclick = () => saveKey($('#s-key').value, $('#s-key-info'));
    $('#s-clear').onclick = async () => {
      S.key = '';
      Store.set('apiKey', '');
      $('#s-key').value = '';
      await loadProgress();
      $('#s-key-info').textContent = 'Key removed.';
    };
    $('#s-lang').onchange = async (e) => {
      S.lang = e.target.value;
      Store.set('gameLang', S.lang);
      await loadStatic();
      renderAccount();
    };
    $('#s-wiki').onchange = (e) => {
      S.wikiLang = e.target.value;
      Store.set('wikiLang2', S.wikiLang);
    };
    $('#s-refresh').onclick = async () => {
      await loadStatic(true);
      renderAccount();
      toast('Achievement data updated.');
    };
  }

  // ---------- Routing ----------
  function setNav(name) {
    document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  }

  function route() {
    const h = location.hash.slice(1) || '/';
    window.scrollTo(0, 0);
    $('#lightbox').hidden = true;
    const wm = h.match(/^\/wiki\/(\w+)\/(.+)$/);
    if (wm) showWikiPage(wm[1], decodeURIComponent(wm[2]));
    else if (h.startsWith('/a/')) showAchievement(+h.slice(3));
    else if (h === '/easy') showEasy();
    else if (h === '/settings') showSettings();
    else showSearch();
  }

  // Echte Kartensymbole aus dem Wiki laden; nur übernehmen, wenn das Bild wirklich lädt
  // (sonst bleiben die gezeichneten Ersatzsymbole aus dem CSS).
  async function loadMapIcons() {
    let icons = Store.get('mapIcons', null);
    if (!icons || Date.now() - icons.ts > 30 * 24 * 3600 * 1000) {
      try {
        icons = { ts: Date.now(), urls: await Wiki.mapIcons() };
        Store.set('mapIcons', icons);
      } catch (e) { console.warn('Kartensymbole', e); return; }
    }
    for (const [kind, url] of Object.entries(icons.urls || {})) {
      if (!url) continue;
      const img = new Image();
      img.onload = () => document.documentElement.style.setProperty(`--ic-${kind}`, `url("${url}")`);
      img.src = url;
    }
  }

  async function init() {
    loadMapIcons();
    try {
      await loadStatic();
    } catch (e) {
      status(null);
      view.innerHTML = `<p class="err">Could not load achievement data: ${esc(e.message)}</p>
        <p class="muted">Is api.guildwars2.com reachable? Reload the page to try again.</p>`;
      return;
    }
    await loadProgress();
    window.addEventListener('hashchange', route);
    route();
  }

  init();
})();
