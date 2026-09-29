// Haupt-App: Laden, Routing, Suche, Erfolgs-Run-Through, Leichte-AP-Finder.
(() => {
  const S = {
    lang: Store.get('lang', 'de'),
    wikiLang: Store.get('wikiLang', 'en'),
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
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '');
  const pct = (f) => `${Math.round(f * 100)}%`;

  function coins(c) {
    const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), k = c % 100;
    return [g && `${g}g`, s && `${s}s`, k && `${k}k`].filter(Boolean).join(' ') || '0k';
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
    status('Lade Account-Fortschritt…');
    try {
      const [acc, prog] = await Promise.all([GW2.account(S.key), GW2.accountAchievements(S.key)]);
      S.account = acc;
      S.progress = new Map(prog.map((p) => [p.id, p]));
      S.progressTs = new Date();
    } catch (e) {
      toast(`API-Key-Fehler: ${e.message}`);
    }
    status(null);
    renderAccount();
  }

  function renderAccount() {
    const el = $('#account');
    if (!S.account) {
      el.innerHTML = S.key ? '<span class="muted">Account nicht geladen</span>' : '<a href="#/settings">API-Key eintragen</a>';
      return;
    }
    let ap = 0, doneCount = 0;
    for (const [id, p] of S.progress) {
      const a = S.ach.get(id);
      if (!a) continue;
      ap += Progress.info(a, p).earned;
      if (p.done) doneCount++;
    }
    const total = ap + (S.account.daily_ap || 0) + (S.account.monthly_ap || 0);
    el.innerHTML = `<strong>${esc(S.account.name)}</strong>
      <span class="pill" title="Erfolgs-AP ${ap} + Tages-AP ${S.account.daily_ap || 0} + Monats-AP ${S.account.monthly_ap || 0}">≈ ${total.toLocaleString('de-DE')} AP</span>
      <span class="pill">${doneCount} abgeschlossen</span>
      <button class="link" id="reload-progress" title="Fortschritt neu von der API holen">↻</button>`;
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
    if (inf.finished) return '<span class="pill ok">✔ fertig</span>';
    if (inf.remainingAP === 0 && inf.repeatable) return '<span class="pill ok">✔ AP-Cap</span>';
    const prog = inf.maxCount ? ` · ${inf.current}/${inf.maxCount}` : '';
    return `<span class="pill ${inf.current ? 'warn' : ''}">${inf.earned}/${isFinite(inf.possible) ? inf.possible : '∞'} AP${prog}</span>`;
  }

  function catPath(a) {
    const cat = S.catOf.get(a.id);
    const grp = cat && S.groupOf.get(cat.id);
    return [grp?.name, cat?.name].filter(Boolean).map(esc).join(' › ') || '<span class="muted">nicht kategorisiert</span>';
  }

  function bar(frac) {
    return `<div class="bar"><div style="width:${pct(frac)}"></div></div>`;
  }

  // ---------- Suche ----------
  function showSearch() {
    setNav('search');
    view.innerHTML = `
      <div class="searchbox">
        <input id="q" type="search" placeholder="Erfolg suchen… (Name oder Beschreibung, z. B. „Sprung ins Ungewisse“)" autocomplete="off" value="${esc(S.query)}">
      </div>
      <div id="results"></div>`;
    const q = $('#q');
    q.focus();
    let t;
    q.oninput = () => { clearTimeout(t); t = setTimeout(() => { S.query = q.value; renderResults(); }, 120); };
    renderResults();
  }

  function renderResults() {
    const el = $('#results');
    const q = norm(S.query);
    if (q.length < 2) {
      el.innerHTML = `<p class="muted">${S.ach.size.toLocaleString('de-DE')} Erfolge geladen. Tippe mindestens 2 Zeichen.
        ${S.account ? '' : '<br>Tipp: Mit API-Key siehst du deinen Fortschritt und den <a href="#/easy">Leichte-AP-Finder</a>.'}</p>`;
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
      ${scored.length > top.length ? `<p class="muted">… und ${scored.length - top.length} weitere. Suche genauer.</p>` : ''}`
      : '<p class="muted">Keine Treffer.</p>';
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
      if (b.type === 'Text') return { type: 'Text', label: b.text || `Schritt ${i + 1}` };
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
      if (r.type === 'Mastery') return `⭐ Meisterschaftspunkt (${esc(r.region)})`;
      if (r.type === 'Title') return `🏷️ Titel „${esc(titles[r.id]?.name || r.id)}“`;
      return esc(r.type);
    });
    return `<div class="rewards"><strong>Belohnungen:</strong> ${parts.map((p) => `<span class="pill">${p}</span>`).join(' ')}</div>`;
  }

  async function showAchievement(id) {
    setNav(null);
    const token = ++S.viewToken;
    const a = S.ach.get(id);
    if (!a) { view.innerHTML = `<p class="muted">Erfolg ${id} nicht gefunden.</p>`; return; }
    const p = S.progress.get(id);
    const inf = Progress.info(a, p);
    const flags = (a.flags || []).filter((f) => !['CategoryDisplay', 'MoveToTop', 'IgnoreNearlyComplete', 'RepairOnLogin'].includes(f));
    const tierText = inf.tiers.map((t) => `${t.count} → ${t.points} AP`).join(' · ');

    view.innerHTML = `
      <p><a href="#/" class="link">← Zurück zur Suche</a></p>
      <header class="ach-head">
        ${achIcon(a).replace('class="icon"', 'class="icon big"')}
        <div class="grow">
          <div class="sub">${catPath(a)} · ID ${a.id}</div>
          <h1>${esc(a.name)}</h1>
          ${a.description ? `<p class="desc">${esc(stripTags(a.description))}</p>` : ''}
          <p><strong>Anforderung:</strong> ${esc(stripTags(a.requirement).replace(/\s+/g, ' ')) || '—'}</p>
          ${a.locked_text ? `<p class="muted"><strong>Freischaltung:</strong> ${esc(stripTags(a.locked_text))}</p>` : ''}
          <p class="muted">Stufen: ${tierText || '—'}</p>
          <div class="flags">${flags.map((f) => `<span class="pill">${esc(f)}</span>`).join(' ')}</div>
          <div id="rewards"></div>
        </div>
        <div class="ach-stat">
          ${S.account ? `
            <div class="big-num">${inf.earned}<span>/${isFinite(inf.possible) ? inf.possible : '∞'} AP</span></div>
            ${bar(inf.frac)}
            <div class="muted">${inf.finished ? '✔ Abgeschlossen' : inf.maxCount ? `${inf.current} / ${inf.maxCount}` : 'Nicht begonnen'}</div>
            ${inf.next ? `<div class="muted">Nächste Stufe: +${inf.next.points} AP in ${inf.next.steps} Schritt(en)</div>` : ''}`
          : `<div class="big-num">${inf.perCycle}<span> AP</span></div><div class="muted">Kein API-Key – Fortschritt unbekannt</div>`}
          <a class="btn" id="wiki-link" target="_blank" rel="noopener" href="${Wiki.searchUrl(S.wikiLang, a.name)}">Im Wiki öffnen ↗</a>
        </div>
      </header>
      <section id="prereq"></section>
      <section id="steps"><h2>Run-Through</h2><p class="muted">Lade Schritte…</p></section>
      <section id="guide"><h2>Wiki-Guide</h2><p class="muted">Lade Wiki-Seite…</p></section>`;

    rewardsHtml(a).then((h) => { if (token === S.viewToken) $('#rewards').innerHTML = h; });
    renderPrereqs(a);

    const names = await bitNames(a, S.lang);
    if (token !== S.viewToken) return;
    renderSteps(a, inf, names, null, null);

    try {
      const wiki = await loadWiki(a);
      if (token !== S.viewToken) return;
      $('#wiki-link').href = Wiki.pageUrl(S.wikiLang, wiki.title);
      const content = Wiki.sanitize(S.wikiLang, wiki.html);
      const wikiNames = S.wikiLang === S.lang ? names : await bitNames(wiki.ach, S.wikiLang);
      if (token !== S.viewToken) return;
      renderSteps(a, inf, names, content, wikiNames);
      renderGuide(content, wiki.title);
    } catch (e) {
      if (token !== S.viewToken) return;
      $('#guide').innerHTML = `<h2>Wiki-Guide</h2><p class="muted">Keine passende Wiki-Seite gefunden (${esc(e.message)}).
        <a target="_blank" rel="noopener" href="${Wiki.searchUrl(S.wikiLang, a.name)}">Im Wiki suchen ↗</a></p>`;
    }
  }

  async function loadWiki(a) {
    const ck = `${S.wikiLang}-${a.id}`;
    if (S.wikiCache.has(ck)) return S.wikiCache.get(ck);
    const promise = (async () => {
      const ach = S.wikiLang === S.lang ? a : await GW2.achievementInLang(a.id, S.wikiLang);
      const title = await Wiki.findPage(S.wikiLang, { id: a.id, name: ach?.name || a.name, context: 'Achievement' });
      if (!title) throw new Error('nicht gefunden');
      const parsed = await Wiki.parse(S.wikiLang, title);
      return { ...parsed, ach: ach || a };
    })();
    S.wikiCache.set(ck, promise);
    promise.catch(() => S.wikiCache.delete(ck));
    return promise;
  }

  function renderPrereqs(a) {
    const chain = prereqChain(a);
    const el = $('#prereq');
    if (!chain.length) { el.innerHTML = ''; return; }
    const open = chain.filter((pa) => !Progress.info(pa, S.progress.get(pa.id)).finished);
    el.innerHTML = `
      <h2>Voraussetzungen ${S.account ? (open.length ? `<span class="pill warn">${open.length} offen</span>` : '<span class="pill ok">alle erfüllt</span>') : ''}</h2>
      <p class="muted">Diese Erfolge musst du zuerst abschließen (in dieser Reihenfolge):</p>
      <ol class="steps">${chain.map((pa) => {
        const done = Progress.info(pa, S.progress.get(pa.id)).finished;
        return `<li class="${done ? 'done' : ''}"><span class="check">${done ? '✔' : '○'}</span>
          <a href="#/a/${pa.id}">${esc(pa.name)}</a> ${S.account ? '' : ''}<span class="sub">${catPath(pa)}</span></li>`;
      }).join('')}</ol>`;
  }

  // Sucht im Wiki-Inhalt das kleinste Element (Tabellenzeile, Listeneintrag, …), das den Text enthält.
  function findWikiHint(content, label) {
    const needle = norm(label).replace(/[.!:]+$/, '');
    if (!content || needle.length < 3) return null;
    let best = null;
    let bestLen = Infinity;
    for (const el of content.querySelectorAll('tr, li, dd, p, td')) {
      const len = norm(el.textContent).length;
      if (len < bestLen && norm(el.textContent).includes(needle)) { best = el; bestLen = len; }
    }
    if (best) best = best.closest('tr') || best; // Ganze Tabellenzeile zeigen (enthält meist Fundort/Notizen)
    if (best && norm(best.textContent).length > 1500) return null;
    if (!best) return null;
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

  function manualKey(id) { return `manual-${id}`; }

  function renderSteps(a, inf, names, content, wikiNames) {
    const el = $('#steps');
    const manual = new Set(Store.get(manualKey(a.id), []));
    const hideDone = Store.get('hideDone', false);
    const bits = a.bits || [];

    let body = '';
    if (bits.length) {
      const doneCount = bits.filter((_, i) => inf.finished || inf.bitsDone.has(i)).length;
      const needed = inf.maxCount && inf.maxCount < bits.length ? `<p class="muted">Du brauchst <strong>${inf.maxCount}</strong> von ${bits.length} Objekten.</p>` : '';
      const order = bits.map((_, i) => i).sort((x, y) => {
        const dx = inf.finished || inf.bitsDone.has(x), dy = inf.finished || inf.bitsDone.has(y);
        return dx - dy || x - y;
      });
      body = `
        <div class="steps-head">
          <span>${S.account ? `<strong>${doneCount}</strong> / ${bits.length} erledigt` : `${bits.length} Objekte`}</span>
          <label><input type="checkbox" id="hide-done" ${hideDone ? 'checked' : ''}> Erledigte ausblenden</label>
        </div>
        ${needed}
        <ol class="steps">${order.map((i) => {
          const n = names[i];
          const apiDone = inf.finished || inf.bitsDone.has(i);
          const done = apiDone || manual.has(i);
          if (hideDone && done) return '';
          const wikiLabel = wikiNames?.[i]?.label || n.label;
          const hint = !apiDone && content ? findWikiHint(content, wikiLabel) : null;
          const typeName = { Item: 'Gegenstand', Skin: 'Skin', Minipet: 'Miniatur', Text: '' }[n.type] ?? n.type;
          return `<li class="${done ? 'done' : ''}" data-bit="${i}">
            <span class="check">${apiDone ? '✔' : `<input type="checkbox" class="manual" data-bit="${i}" ${manual.has(i) ? 'checked' : ''} title="Manuell abhaken">`}</span>
            <div class="grow">
              <div>${n.icon ? `<img class="mini" src="${esc(n.icon)}" alt="">` : ''}
                <span class="${n.rarity ? `r-${esc(n.rarity)}` : ''}">${esc(n.label)}</span>
                ${typeName ? `<span class="sub">${typeName}</span>` : ''}
                ${n.type !== 'Text' ? `<a class="sub" href="${wikiRoute(S.wikiLang, wikiLabel)}">Wiki-Seite</a>` : ''}
              </div>
              ${hint ? `<details class="hint" open><summary>Wiki-Hinweis</summary><div class="wiki">${hint}</div></details>` : ''}
              ${!apiDone && !hint && n.type !== 'Text' ? `<button class="small acq" data-bit="${i}">Wie bekomme ich das? (Wiki)</button><div class="acq-out wiki"></div>` : ''}
            </div>
          </li>`;
        }).join('')}</ol>`;
    } else if (inf.tiers.length) {
      body = `<ol class="steps">${inf.tiers.map((t) => {
        const done = inf.finished || inf.current >= t.count;
        return `<li class="${done ? 'done' : ''}"><span class="check">${done ? '✔' : '○'}</span>
          <div class="grow">Stufe: ${t.count}× erreichen <span class="pill">${t.points} AP</span>
          ${!done && S.account ? `<span class="sub">noch ${t.count - inf.current}</span>` : ''}</div></li>`;
      }).join('')}</ol>
      <p class="muted">Dieser Erfolg hat keine Einzelschritte – Details stehen im Wiki-Guide unten.</p>`;
    }

    el.innerHTML = `<h2>Run-Through</h2>
      ${!S.account ? '<p class="muted">Ohne API-Key wird dein Fortschritt nicht erkannt – du kannst aber manuell abhaken.</p>' : ''}
      ${inf.needsUnlock ? '<p class="warn-box">⚠ Dieser Erfolg muss erst freigeschaltet werden (siehe „Freischaltung“ oben).</p>' : ''}
      ${body || '<p class="muted">Keine Schritte bekannt.</p>'}`;

    $('#hide-done', el)?.addEventListener('change', (e) => {
      Store.set('hideDone', e.target.checked);
      renderSteps(a, inf, names, content, wikiNames);
    });
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
      btn.textContent = 'Lade…';
      try {
        const res = await Wiki.acquisition(S.wikiLang, { type: n.type, id: n.id, name: n.label });
        if (!res) throw new Error('Keine Wiki-Seite gefunden');
        const node = Wiki.sanitize(S.wikiLang, res.html);
        out.innerHTML = `<div class="sub">Aus <a href="${wikiRoute(S.wikiLang, res.title)}">${esc(res.title)}</a>${res.sectionName ? ` › ${esc(res.sectionName)}` : ''}</div>`;
        out.appendChild(node);
        btn.remove();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Wie bekomme ich das? (Wiki)';
        out.innerHTML = `<span class="muted">${esc(e.message)}</span>`;
      }
    }));
    bindAnchors(el);
  }

  const OPEN_SECTIONS = /walkthrough|guide|objective|collection|location|strategy|tips|ziel|lösung|anleitung|fundort|sammlung|tipps|strategie/i;

  function renderGuide(content, title) {
    const el = $('#guide');
    el.innerHTML = `<h2>Wiki-Guide <a class="sub" href="${wikiRoute(S.wikiLang, title)}">${esc(title)}</a></h2>
      <p class="muted">Inhalt aus dem offiziellen Guild Wars 2 Wiki (CC BY-NC-SA). Bilder anklicken zum Vergrößern, Chat-Codes anklicken zum Kopieren.</p>`;
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
      <p><a href="javascript:history.back()" class="link">← Zurück</a></p>
      <h1>${esc(pageTitle)}</h1>
      <div id="wiki-page"><p class="muted">Lade Wiki-Seite…</p></div>`;
    try {
      const res = await Wiki.page(lang, pageTitle);
      if (token !== S.viewToken) return;
      const content = Wiki.sanitize(lang, res.html);
      view.querySelector('h1').innerHTML = `${esc(res.title)}
        <a class="sub" target="_blank" rel="noopener" href="${Wiki.pageUrl(lang, res.title)}">im Browser ↗</a>`;
      const el = $('#wiki-page');
      el.innerHTML = '';
      renderSections(el, content, true);
      if (anchor) document.getElementById(anchor)?.scrollIntoView();
    } catch (e) {
      if (token !== S.viewToken) return;
      $('#wiki-page').innerHTML = `<p class="err">Seite konnte nicht geladen werden: ${esc(e.message)}</p>
        <a target="_blank" rel="noopener" href="${Wiki.searchUrl(lang, pageTitle)}">Im Wiki suchen ↗</a>`;
    }
  }

  // ---------- Bild-Großansicht & Chat-Codes ----------
  function openLightbox(src, caption, fileTitle, lang) {
    const box = $('#lightbox');
    box.innerHTML = `<figure>
      <img src="${esc(src)}" alt="">
      <figcaption>${esc(caption || '')}
        ${fileTitle ? `<a target="_blank" rel="noopener" href="${Wiki.pageUrl(lang, fileTitle)}">Bildseite ↗</a>` : ''}
        <span class="muted">· Klick oder Esc zum Schließen</span></figcaption></figure>`;
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
      copyText(chat.dataset.code).then(() => toast(`${chat.dataset.code} kopiert – im Spiel mit Strg+V in den Chat einfügen.`));
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
      rows.push({ a, inf, cat, grp: S.groupOf.get(cat.id), locked });
    }
    return rows;
  }

  function showEasy() {
    setNav('easy');
    if (!S.account) {
      view.innerHTML = `<h1>Leichte AP</h1><p>Für den Leichte-AP-Finder brauche ich deinen Fortschritt.
        <a href="#/settings">Trag zuerst einen API-Key ein</a> (Rechte: <code>account</code> + <code>progression</code>).</p>`;
      return;
    }
    if (!S.easyRows) S.easyRows = computeEasyRows();
    const f = S.easy;
    view.innerHTML = `
      <h1>Leichte AP</h1>
      <p class="muted">Offene Erfolge, sortiert nach geschätzter Leichtigkeit: AP der nächsten Stufe, wie viele Schritte noch fehlen und wie weit du schon bist.
        Tägliche/wöchentliche Erfolge und nicht mehr kategorisierte (meist unerreichbare) Erfolge sind ausgeblendet.</p>
      <div class="filters">
        <label>Sortierung
          <select id="f-sort">
            <option value="ease">Leichtigkeit (Empfehlung)</option>
            <option value="progress">Fast fertig</option>
            <option value="steps">Wenigste Schritte bis zur nächsten Stufe</option>
            <option value="next">Meiste AP nächste Stufe</option>
            <option value="remaining">Meiste offene AP gesamt</option>
          </select></label>
        <label>Min. Fortschritt <input id="f-min" type="range" min="0" max="95" step="5" value="${f.minProgress}"> <span id="f-min-v">${f.minProgress}%</span></label>
        <label><input type="checkbox" id="f-started" ${f.onlyStarted ? 'checked' : ''}> Nur begonnene</label>
        <label><input type="checkbox" id="f-locked" ${f.hideLocked ? 'checked' : ''}> Gesperrte ausblenden</label>
        <label><input type="checkbox" id="f-pvp" ${f.hidePvp ? 'checked' : ''}> PvP ausblenden</label>
        <label><input type="checkbox" id="f-rep" ${f.hideRepeatable ? 'checked' : ''}> Wiederholbare ausblenden</label>
      </div>
      <details class="groups"><summary>Gruppen filtern (${S.groups.length - f.excludedGroups.length}/${S.groups.length} aktiv)</summary>
        <div class="group-list">${S.groups.map((g) => `<label><input type="checkbox" class="f-group" value="${esc(g.id)}" ${f.excludedGroups.includes(g.id) ? '' : 'checked'}> ${esc(g.name)}</label>`).join('')}</div>
      </details>
      <div id="easy-summary" class="muted"></div>
      <div id="easy-table"></div>`;
    $('#f-sort').value = f.sort;
    const update = () => { Store.set('easyFilters', f); renderEasyTable(); };
    $('#f-sort').onchange = (e) => { f.sort = e.target.value; update(); };
    $('#f-min').oninput = (e) => { f.minProgress = +e.target.value; $('#f-min-v').textContent = `${f.minProgress}%`; update(); };
    $('#f-started').onchange = (e) => { f.onlyStarted = e.target.checked; update(); };
    $('#f-locked').onchange = (e) => { f.hideLocked = e.target.checked; update(); };
    $('#f-pvp').onchange = (e) => { f.hidePvp = e.target.checked; update(); };
    $('#f-rep').onchange = (e) => { f.hideRepeatable = e.target.checked; update(); };
    view.querySelectorAll('.f-group').forEach((cb) => cb.onchange = () => {
      f.excludedGroups = [...view.querySelectorAll('.f-group')].filter((c) => !c.checked).map((c) => c.value);
      $('.groups summary').textContent = `Gruppen filtern (${S.groups.length - f.excludedGroups.length}/${S.groups.length} aktiv)`;
      update();
    });
    renderEasyTable();
  }

  function renderEasyTable() {
    const f = S.easy;
    const excluded = new Set(f.excludedGroups);
    let rows = S.easyRows.filter((r) =>
      !(f.hideLocked && r.locked) &&
      !(f.hidePvp && (r.a.flags || []).includes('Pvp')) &&
      !(f.hideRepeatable && r.inf.repeatable) &&
      !(f.onlyStarted && r.inf.current === 0) &&
      r.inf.frac * 100 >= f.minProgress &&
      !(r.grp && excluded.has(r.grp.id)));
    const sorters = {
      ease: (x, y) => y.inf.ease - x.inf.ease,
      progress: (x, y) => y.inf.next.frac - x.inf.next.frac || x.inf.next.steps - y.inf.next.steps,
      steps: (x, y) => x.inf.next.steps - y.inf.next.steps || y.inf.next.points - x.inf.next.points,
      next: (x, y) => y.inf.next.points - x.inf.next.points || y.inf.ease - x.inf.ease,
      remaining: (x, y) => y.inf.remainingAP - x.inf.remainingAP || y.inf.ease - x.inf.ease,
    };
    rows.sort(sorters[f.sort] || sorters.ease);
    const sumNext = rows.reduce((s, r) => s + r.inf.next.points, 0);
    const sumAll = rows.reduce((s, r) => s + (isFinite(r.inf.remainingAP) ? r.inf.remainingAP : 0), 0);
    $('#easy-summary').textContent = `${rows.length} Erfolge · ${sumNext.toLocaleString('de-DE')} AP in der jeweils nächsten Stufe · ${sumAll.toLocaleString('de-DE')} AP offen gesamt`;
    const top = rows.slice(0, 200);
    $('#easy-table').innerHTML = `<table class="easy">
      <thead><tr><th></th><th>Erfolg</th><th>Fortschritt</th><th title="Schritte bis zur nächsten Stufe">Nächste Stufe</th><th>Offen</th></tr></thead>
      <tbody>${top.map((r) => `<tr onclick="location.hash='#/a/${r.a.id}'">
        <td>${achIcon(r.a)}</td>
        <td><a href="#/a/${r.a.id}">${esc(r.a.name)}</a>${r.locked ? ' <span class="pill warn" title="Voraussetzung/Freischaltung fehlt">🔒</span>' : ''}
          <div class="sub">${catPath(r.a)}</div></td>
        <td class="prog">${bar(r.inf.frac)}<span class="sub">${r.inf.current}/${r.inf.maxCount}</span></td>
        <td><strong>+${r.inf.next.points} AP</strong><div class="sub">noch ${r.inf.next.steps}</div></td>
        <td>${isFinite(r.inf.remainingAP) ? r.inf.remainingAP : '∞'} AP</td>
      </tr>`).join('')}</tbody></table>
      ${rows.length > top.length ? `<p class="muted">Zeige die ersten 200 von ${rows.length}.</p>` : ''}`;
  }

  // ---------- Einstellungen ----------
  function showSettings() {
    setNav('settings');
    view.innerHTML = `
      <h1>Einstellungen</h1>
      <div class="card">
        <h2>GW2 API-Key</h2>
        <p class="muted">Erstelle einen Key auf <a href="https://account.arena.net/applications" target="_blank" rel="noopener">account.arena.net/applications</a>
          mit den Rechten <code>account</code> und <code>progression</code>. Der Key wird nur lokal in deinem Browser gespeichert
          und nur an api.guildwars2.com gesendet.</p>
        <input id="s-key" type="password" placeholder="XXXXXXXX-XXXX-…" value="${esc(S.key)}" autocomplete="off">
        <div class="row-btns"><button id="s-save">Speichern & prüfen</button><button id="s-clear" class="secondary">Key entfernen</button></div>
        <div id="s-key-info" class="muted"></div>
      </div>
      <div class="card">
        <h2>Sprache</h2>
        <label>Spieldaten <select id="s-lang">
          <option value="de">Deutsch</option><option value="en">English</option><option value="fr">Français</option><option value="es">Español</option>
        </select></label>
        <label>Wiki <select id="s-wiki">
          <option value="en">Englisch (vollständiger, empfohlen)</option><option value="de">Deutsch</option>
        </select></label>
      </div>
      <div class="card">
        <h2>Daten</h2>
        <p class="muted">Erfolgsdaten werden eine Woche lokal zwischengespeichert.</p>
        <button id="s-refresh" class="secondary">Erfolgsdaten jetzt neu laden</button>
      </div>`;
    $('#s-lang').value = S.lang;
    $('#s-wiki').value = S.wikiLang;
    $('#s-save').onclick = async () => {
      const key = $('#s-key').value.trim();
      const info = $('#s-key-info');
      info.textContent = 'Prüfe Key…';
      try {
        const t = await GW2.tokenInfo(key);
        const missing = ['account', 'progression'].filter((p) => !t.permissions.includes(p));
        if (missing.length) { info.innerHTML = `<span class="err">Dem Key fehlen Rechte: ${missing.join(', ')}</span>`; return; }
        S.key = key;
        Store.set('apiKey', key);
        await loadProgress();
        info.innerHTML = `<span class="ok-text">✔ Key „${esc(t.name)}“ gespeichert – ${S.progress.size} Erfolge mit Fortschritt geladen.</span>`;
      } catch (e) {
        info.innerHTML = `<span class="err">Ungültiger Key: ${esc(e.message)}</span>`;
      }
    };
    $('#s-clear').onclick = async () => {
      S.key = '';
      Store.set('apiKey', '');
      $('#s-key').value = '';
      await loadProgress();
      $('#s-key-info').textContent = 'Key entfernt.';
    };
    $('#s-lang').onchange = async (e) => {
      S.lang = e.target.value;
      Store.set('lang', S.lang);
      await loadStatic();
      renderAccount();
    };
    $('#s-wiki').onchange = (e) => {
      S.wikiLang = e.target.value;
      Store.set('wikiLang', S.wikiLang);
    };
    $('#s-refresh').onclick = async () => {
      await loadStatic(true);
      renderAccount();
      toast('Erfolgsdaten aktualisiert.');
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

  async function init() {
    try {
      await loadStatic();
    } catch (e) {
      status(null);
      view.innerHTML = `<p class="err">Konnte die Erfolgsdaten nicht laden: ${esc(e.message)}</p>
        <p class="muted">Ist api.guildwars2.com erreichbar? Seite neu laden zum erneuten Versuch.</p>`;
      return;
    }
    await loadProgress();
    window.addEventListener('hashchange', route);
    route();
  }

  init();
})();
