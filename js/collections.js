// Sammlungen: Reittiere und legendäre Gegenstände mit allen Erfolgen auf dem Weg dorthin.
// Der Katalog kommt aus der API (/v2/mounts, /v2/legendaryarmory). Welche Erfolge dazugehören, steht auf
// der Wiki-Seite: verlinkte Erfolgskategorien und Erfolge sowie Bauteile (z. B. „Gift of the Hylek“),
// die ein Erfolg als Belohnung gibt. Dazu kommen die Voraussetzungen aus der API.
const Collections = (() => {
  const VERSION = 1;
  const MAX_AGE = 7 * 24 * 3600 * 1000;
  const PAGE_BUDGET = 16; // höchstens so viele Bauteil-Seiten pro Sammlung nachladen
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '');
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const catIds = (c) => (c?.achievements || []).map((e) => (typeof e === 'object' ? e.id : e));

  // Wiki-Abschnitte, deren Links die Erfolge liefern bzw. die nichts damit zu tun haben
  const ACQ = /acquisition|obtain|unlock|getting|crafting|recipe|collection|achievement|walkthrough|erwerb|freischalt|herstellung|rezept|sammlung|erfolg/i;
  const SKIP = /used in|gallery|trivia|notes|see also|external|version|patch|related (items|skins)|skins|dyes|verwendung|galerie|wissenswertes|anmerkung|siehe auch|färb/i;
  const GIFT = /^(gift|geschenk|gabe|don)\b/i;
  const KIND_WORDS = {
    mount: /^(mounts?|reittiere?|montures?|monturas?)$/,
    legendary: /^(legendar(y|ies)?|legys?|leggys?|legies|legendar[ea]?|legendaires?|legendari[oa]s?)$/,
  };

  // ---------- Katalog ----------
  let catalog = null;
  let catalogKey = '';
  let loadingCat = null;

  function legendarySub(it) {
    const d = it.details?.type;
    const pretty = d && d !== 'Default' ? d.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : null;
    const TYPE = { Weapon: 'weapon', Armor: 'armor', Trinket: 'trinket', Back: 'back item', UpgradeComponent: 'upgrade', Relic: 'relic' };
    let s = pretty || TYPE[it.type] || 'item';
    if (it.type === 'Armor' && it.details?.weight_class) s = `${it.details.weight_class.toLowerCase()} ${s}`;
    return `Legendary ${s}`;
  }

  // Namen je Sprache zusammenführen: { id -> { lang: name } }
  function namesByLang(langs, lists, idOf = (x) => x.id) {
    const out = new Map();
    lists.forEach((list, i) => (list || []).forEach((x) => {
      const n = out.get(idOf(x)) || {};
      n[langs[i]] = x.name;
      out.set(idOf(x), n);
    }));
    return out;
  }

  async function fetchCatalog(langs) {
    const entries = [];
    try {
      const lists = await Promise.all(langs.map((lang) => GW2.get('/mounts/types', { ids: 'all', lang })));
      const names = namesByLang(langs, lists);
      const skins = await GW2.getMany('/mounts/skins', lists[0].map((t) => t.default_skin).filter(Boolean), { lang: langs[0] }).catch(() => []);
      const skinById = new Map(skins.map((s) => [s.id, s]));
      for (const t of lists[0]) {
        entries.push({ key: `mount:${t.id}`, kind: 'mount', mountId: t.id, names: names.get(t.id), icon: skinById.get(t.default_skin)?.icon || null, sub: 'Mount' });
      }
    } catch (e) { console.warn('Reittiere', e); }
    try {
      const ids = await GW2.get('/legendaryarmory');
      const lists = await Promise.all(langs.map((lang) => GW2.getMany('/items', ids, { lang })));
      const names = namesByLang(langs, lists);
      for (const it of lists[0]) {
        entries.push({ key: `item:${it.id}`, kind: 'legendary', itemId: it.id, names: names.get(it.id), icon: it.icon, sub: legendarySub(it), type: it.type });
      }
    } catch (e) { console.warn('Legendäre', e); }
    return entries;
  }

  // langs: [Spielsprache, Englisch, Wiki-Sprache] – Namen in allen, damit auch englische Suchbegriffe passen
  function loadCatalog(langs, { force = false } = {}) {
    langs = [...new Set(langs)];
    const key = `collections-${VERSION}-${langs.join(',')}`;
    if (catalog && catalogKey === key && !force) return Promise.resolve(catalog);
    if (loadingCat?.key === key && !force) return loadingCat.promise;
    const promise = (async () => {
      let data = force ? null : await DB.get(key);
      if (!data || Date.now() - data.ts > MAX_AGE) {
        const entries = await fetchCatalog(langs);
        data = { ts: Date.now(), entries };
        if (entries.length) await DB.set(key, data);
      }
      catalog = data.entries;
      catalogKey = key;
      return catalog;
    })();
    loadingCat = { key, promise };
    promise.catch(() => { loadingCat = null; });
    return promise;
  }

  const nameOf = (e, lang) => e.names?.[lang] || e.names?.en || Object.values(e.names || {})[0] || e.key;
  const entry = (key) => catalog?.find((e) => e.key === key) || null;

  // Suchtreffer im Katalog: ganzer Name, Namensanfang oder Wortanfang; „legendary“/„mount“ zeigt alle
  function match(q) {
    const nq = norm(q);
    if (!catalog || nq.length < 3) return [];
    for (const [kind, re] of Object.entries(KIND_WORDS)) if (re.test(nq)) return catalog.filter((e) => e.kind === kind);
    const hits = [];
    for (const e of catalog) {
      let best = -1;
      for (const n of Object.values(e.names || {})) {
        const nn = norm(n);
        best = Math.max(best, nn === nq ? 3 : nn.startsWith(nq) ? 2 : nn.includes(` ${nq}`) ? 1 : -1);
      }
      if (best >= 0) hits.push([best, e]);
    }
    hits.sort((x, y) => y[0] - x[0] || (x[1].kind === 'mount' ? -1 : 0) - (y[1].kind === 'mount' ? -1 : 0)
      || nameOf(x[1], 'en').localeCompare(nameOf(y[1], 'en')));
    return hits.map((h) => h[1]);
  }

  // Katalog-Eintrag zu einem Wiki-Titel („Skyscale“, „Endless Summer (item)“)
  function byTitle(title) {
    const t = norm(String(title).replace(/#.*$/, '').replace(/\s*\([^)]*\)\s*$/, ''));
    return catalog?.find((e) => Object.values(e.names || {}).some((n) => norm(n) === t)) || null;
  }

  // ---------- Indizes ----------
  const nameIdx = new Map(); // Sprache -> { ach: Map(Name -> ID), cat: Map(Name -> ID) }
  async function namesFor(ctx) {
    const lang = ctx.wikiLang;
    if (nameIdx.has(lang)) return nameIdx.get(lang);
    const data = lang === ctx.lang
      ? { achievements: [...ctx.ach.values()], categories: ctx.categories }
      : await ctx.loadStatic(lang);
    const ach = new Map();
    for (const a of data.achievements) {
      const k = norm(a.name);
      if (!ach.has(k) || (ctx.catOf.has(a.id) && !ctx.catOf.has(ach.get(k)))) ach.set(k, a.id);
    }
    const cat = new Map();
    for (const c of data.categories) if (catIds(c).length) cat.set(norm(c.name), c.id);
    const idx = { ach, cat };
    nameIdx.set(lang, idx);
    return idx;
  }

  // Belohnungs-Items: Name -> Erfolge, die das Item geben (nur einmalige Erfolge)
  const rewardIdx = new Map();
  function rewardsFor(ctx) {
    const lang = ctx.wikiLang;
    if (!rewardIdx.has(lang)) {
      const promise = (async () => {
        const byItem = new Map();
        for (const a of ctx.ach.values()) {
          if ((a.flags || []).some((f) => ['Daily', 'Weekly', 'Monthly', 'Repeatable'].includes(f))) continue;
          for (const r of a.rewards || []) {
            if (r.type === 'Item') (byItem.get(r.id) || byItem.set(r.id, []).get(r.id)).push(a.id);
          }
        }
        const names = await GW2.resolve('Item', [...byItem.keys()], lang).catch(() => ({}));
        const byName = new Map();
        for (const [id, achs] of byItem) {
          const n = names[id]?.name;
          if (!n) continue;
          const k = norm(n);
          byName.set(k, [...new Set([...(byName.get(k) || []), ...achs])]);
        }
        return { byItem, byName };
      })();
      rewardIdx.set(lang, promise);
      promise.catch(() => rewardIdx.delete(lang));
    }
    return rewardIdx.get(lang);
  }

  function reset() { nameIdx.clear(); rewardIdx.clear(); memo.clear(); }

  // ---------- Wiki-Seite zerlegen ----------
  // Inhalt in Abschnitte mit Überschriften-Kette teilen (h3 unter „Acquisition“ gehört dazu)
  function splitSections(content) {
    const out = [];
    const stack = [];
    let cur = { chain: [], nodes: [] };
    out.push(cur);
    for (const node of content.children) {
      const h = node.matches('h1, h2, h3, h4, h5, h6') ? node
        : node.classList.contains('mw-heading') ? node.querySelector('h1, h2, h3, h4, h5, h6') : null;
      if (h) {
        const level = +h.tagName[1];
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        stack.push({ level, text: h.textContent.trim() });
        cur = { chain: stack.map((s) => s.text), nodes: [], heading: node };
        out.push(cur);
      } else cur.nodes.push(node);
    }
    return out;
  }
  const isAcq = (sec) => sec.chain.some((t) => ACQ.test(t)) && !sec.chain.some((t) => SKIP.test(t));

  function linksIn(nodes) {
    const out = [];
    for (const n of nodes) {
      const list = n.matches('a[data-wiki]') ? [n] : [...n.querySelectorAll('a[data-wiki]')];
      for (const l of list) out.push(l.dataset.wiki.replace(/#.*$/, '').trim());
    }
    return out.filter(Boolean);
  }

  // Schlüssel zu einem Link-Titel: ohne Zusatz „(achievement)“ usw., dann ganz ohne Klammerzusatz
  function titleKeys(title) {
    const a = norm(title.replace(/\s*\((achievements?|erfolge?|item|gegenstand|collection|sammlung|mount|reittier)\)\s*$/i, ''));
    const b = norm(title.replace(/\s*\([^)]*\)\s*$/, ''));
    return [...new Set([norm(title), a, b])].filter(Boolean);
  }

  // Ein Bauteil, das genau ein oder zwei Erfolge als Belohnung geben (häufige Materialien zählen nicht)
  function rewardMatch(rw, keys) {
    for (const k of keys) {
      const ids = rw.byName.get(k);
      if (ids && ids.length <= 2) return ids;
    }
    return null;
  }

  async function pool(items, n, fn) {
    const out = new Array(items.length).fill(null);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try { out[i] = await fn(items[i]); } catch (e) { console.warn('Sammlung', e); }
      }
    }));
    return out;
  }

  // Bauteil-Seite (z. B. „Gift of the Survivors“): Erfolge aus dem Erwerbs-Abschnitt, bei Bedarf eine Ebene tiefer
  async function crawlComponent(title, ctx, idx, rw, budget, depth) {
    if (budget.left-- <= 0) return [];
    const page = await Wiki.parse(ctx.wikiLang, title).catch(() => null);
    if (!page) return [];
    const secs = splitSections(Wiki.sanitize(ctx.wikiLang, page.html));
    const acq = secs.filter(isAcq);
    const links = linksIn((acq.length ? acq : secs.slice(0, 1)).flatMap((s) => s.nodes));
    const ids = [];
    const achLinks = [];
    const deeper = [];
    for (const t of links) {
      const keys = titleKeys(t);
      const r = rewardMatch(rw, keys);
      if (r) { ids.push(...r); continue; }
      const k = keys.find((x) => idx.ach.has(x));
      if (k) achLinks.push(idx.ach.get(k));
      else if (GIFT.test(t) && norm(t) !== norm(page.title)) deeper.push(t);
    }
    // Viele Erfolge im Erwerbs-Abschnitt = allgemeines Material, kein bestimmter Weg
    if (achLinks.length <= 3) ids.push(...achLinks);
    if (!ids.length && depth > 0) {
      for (const t of [...new Set(deeper)].slice(0, 4)) ids.push(...await crawlComponent(t, ctx, idx, rw, budget, depth - 1));
    }
    return [...new Set(ids)];
  }

  // ---------- Erfolge einer Sammlung bestimmen ----------
  // Ergebnis: Gruppen { kind: category|achievements|component|related, title, ids, catId?, related? }
  async function build(entry, ctx) {
    const status = ctx.onStatus || (() => {});
    const catById = new Map(ctx.categories.map((c) => [c.id, c]));
    const groups = [];
    const placed = new Set();
    const place = (ids) => ids.filter((id) => ctx.ach.has(id) && !placed.has(id) && placed.add(id));
    const addCategory = (cat, pos, related = false) => {
      const ids = cat ? place(catIds(cat)) : [];
      if (ids.length) groups.push({ kind: 'category', title: cat.name, catId: cat.id, ids, pos, related });
    };

    const name = entry.kind === 'category' ? catById.get(entry.catId)?.name : nameOf(entry, ctx.lang);
    let wikiTitle = null;
    let wikiError = null;
    let acquisition = null;

    if (entry.kind === 'category') {
      addCategory(catById.get(entry.catId), 0);
    } else {
      try {
        status('Reading the wiki page…');
        const wikiName = nameOf(entry, ctx.wikiLang);
        const title = await Wiki.findPage(ctx.wikiLang, {
          id: entry.itemId, name: wikiName, context: entry.kind === 'mount' ? 'Mount' : 'Item', preferId: entry.kind === 'legendary',
        });
        if (!title) throw new Error('no wiki page found');
        const page = await Wiki.parse(ctx.wikiLang, title);
        wikiTitle = page.title;
        const secs = splitSections(Wiki.sanitize(ctx.wikiLang, page.html));
        const acq = secs.filter(isAcq);
        if (acq.length) acquisition = acq.map((s) => [s.heading, ...s.nodes].filter(Boolean).map((n) => n.outerHTML).join('')).join('');
        const scope = acq.length ? [secs[0], ...acq] : secs.filter((s) => !s.chain.some((t) => SKIP.test(t)));
        const self = titleKeys(page.title);
        const links = [...new Set(linksIn(scope.flatMap((s) => s.nodes)))].filter((t) => !titleKeys(t).some((k) => self.includes(k)));

        const idx = await namesFor(ctx);
        status('Matching reward items…');
        const rw = await rewardsFor(ctx);

        // Kategorien zuerst (damit ihre Erfolge zusammenbleiben), dann einzelne Erfolge, dann Bauteile
        const found = links.map((t, pos) => {
          const keys = titleKeys(t);
          const ck = keys.find((k) => idx.cat.has(k));
          if (ck) return { pos, t, cat: idx.cat.get(ck) };
          const ak = keys.find((k) => idx.ach.has(k));
          if (ak) return { pos, t, ach: idx.ach.get(ak) };
          const r = rewardMatch(rw, keys);
          if (r) return { pos, t, reward: r };
          return { pos, t };
        });
        for (const f of found) if (f.cat) addCategory(catById.get(f.cat), f.pos);
        const direct = found.filter((f) => f.ach && place([f.ach]).length);
        if (direct.length) groups.push({ kind: 'achievements', title: 'Achievements', ids: direct.map((f) => f.ach), pos: direct[0].pos });
        for (const f of found) {
          if (!f.reward) continue;
          const ids = place(f.reward);
          if (ids.length) groups.push({ kind: 'component', title: f.t, ids, pos: f.pos });
        }

        // Legendäre: Bauteile ohne direkten Treffer auf ihrer eigenen Seite weiterverfolgen
        if (entry.kind === 'legendary') {
          const cands = found.filter((f) => !f.cat && !f.ach && !f.reward && !/^(mystic forge|trading post|mystische schmiede|handelsposten)$/i.test(f.t))
            .sort((x, y) => (GIFT.test(y.t) - GIFT.test(x.t)) || x.pos - y.pos)
            .slice(0, 10);
          if (cands.length) status(`Following ${cands.length} recipe components on the wiki…`);
          const budget = { left: PAGE_BUDGET };
          const res = await pool(cands, 4, (c) => crawlComponent(c.t, ctx, idx, rw, budget, 1));
          cands.forEach((c, i) => {
            const ids = place(res[i] || []);
            if (ids.length) groups.push({ kind: 'component', title: c.t, ids, pos: c.pos, via: true });
          });
        }
      } catch (e) {
        wikiError = e.message || String(e);
        console.warn('Sammlung (Wiki)', e);
      }

      // API: Erfolge, die den Gegenstand selbst als Belohnung geben
      if (entry.itemId) {
        const ids = place([...ctx.ach.values()].filter((a) => (a.rewards || []).some((r) => r.type === 'Item' && r.id === entry.itemId)).map((a) => a.id));
        if (ids.length) groups.push({ kind: 'component', title: name, ids, pos: 9000 });
      }
    }

    // API: Kategorien und Erfolge mit dem Namen im Titel (Wortanfang: „skyscale“ passt auf „Raising Skyscales“)
    const nq = norm(name);
    if (entry.kind !== 'category' && nq.length >= 3) {
      const re = new RegExp(`(^|[^a-z0-9])${escRe(nq)}`);
      const hadMain = groups.length > 0;
      ctx.categories.filter((c) => re.test(norm(c.name)) && catIds(c).length)
        .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
        .forEach((c, i) => addCategory(c, 10000 + i, hadMain));
      // Legendäre: „Name I/II/III“, „Name: …“ bzw. „Legendary …: Name“ gehören zum Weg
      if (entry.kind === 'legendary') {
        const strict = new RegExp(`^([a-z ]+: )?${escRe(nq)}( [ivx]+)?(:.*)?$`);
        const ids = place([...ctx.ach.values()].filter((a) => ctx.catOf.has(a.id) && strict.test(norm(a.name))).map((a) => a.id));
        if (ids.length) groups.push({ kind: 'achievements', title: 'Achievements', ids, pos: 11000 });
      }
      // Weitere Erfolge, die den Namen nennen (eingeklappt): Titel, Beschreibung, Anforderung
      if (nq.length >= 6 || nq.includes(' ')) {
        const ids = place([...ctx.ach.values()].filter((a) => {
          if (!ctx.catOf.has(a.id) || (a.flags || []).some((f) => ['Daily', 'Weekly', 'Monthly'].includes(f))) return false;
          return re.test(norm(`${a.name} ${stripTags(a.description)} ${stripTags(a.requirement)}`));
        }).map((a) => a.id)).slice(0, 80);
        if (ids.length) groups.push({ kind: 'related', title: name, ids, pos: 20000, related: true });
      }
    }

    // Reihenfolge: Hauptgruppen nach Auftreten auf der Wiki-Seite, verwandte Gruppen ans Ende
    groups.sort((x, y) => (!!x.related - !!y.related) || x.pos - y.pos);
    // Voraussetzungen (rekursiv) in die Gruppe des Erfolgs, der sie braucht.
    // Kategorie: Vor-Erfolge aus anderen Kategorien als eigene Gruppe davor (zählen nicht zur Kategorie).
    const before = [];
    for (const g of groups) {
      const pre = [];
      const visit = (id) => {
        for (const pid of ctx.ach.get(id)?.prerequisites || []) {
          if (placed.has(pid) || !ctx.ach.has(pid)) continue;
          placed.add(pid);
          visit(pid);
          pre.push(pid);
        }
      };
      g.ids.forEach(visit);
      if (!pre.length) continue;
      if (entry.kind === 'category') before.push(...pre);
      else g.ids = [...pre, ...g.ids];
    }
    if (before.length) groups.unshift({ kind: 'prereq', title: 'Needed first', ids: before, extra: true });

    return {
      v: VERSION, ts: Date.now(), key: entry.key, name, wikiTitle, wikiError, acquisition,
      groups: groups.map(({ kind, title, catId, ids, related, extra, via }) => ({ kind, title, catId, ids, related: !!related, extra: !!extra, via: !!via })),
    };
  }

  const memo = new Map();
  const cacheKey = (entry, ctx) => `collection-${VERSION}-${entry.key}-${ctx.lang}-${ctx.wikiLang}`;

  // Zwischengespeichertes Ergebnis (Sitzung oder IndexedDB), ohne neu aufzubauen
  async function cached(entry, ctx) {
    const k = cacheKey(entry, ctx);
    if (memo.has(k)) return memo.get(k);
    const c = await DB.get(k);
    if (c && c.v === VERSION && Date.now() - c.ts < MAX_AGE) { memo.set(k, c); return c; }
    return null;
  }
  const peek = (entry, ctx) => memo.get(cacheKey(entry, ctx)) || null;

  async function resolve(entry, ctx, { force = false } = {}) {
    if (!force && entry.kind !== 'category') {
      const c = await cached(entry, ctx);
      if (c) return c;
    }
    const res = await build(entry, ctx);
    if (entry.kind !== 'category') {
      memo.set(cacheKey(entry, ctx), res);
      if (!res.wikiError) DB.set(cacheKey(entry, ctx), res); // ohne Wiki nur für diese Sitzung
    }
    return res;
  }

  // Freigeschaltete Reittiere und Legendäre Waffenkammer (nur mit passenden Key-Rechten)
  async function accountUnlocks(key, perms = []) {
    const out = { mounts: null, legendary: null };
    if (!key || !perms.includes('unlocks')) return out;
    const [mounts, armory] = await Promise.all([
      GW2.get('/account/mounts/types', { access_token: key }).catch(() => null),
      perms.includes('inventories') ? GW2.get('/account/legendaryarmory', { access_token: key }).catch(() => null) : null,
    ]);
    if (Array.isArray(mounts)) out.mounts = new Set(mounts);
    if (Array.isArray(armory)) out.legendary = new Map(armory.map((x) => [x.id, x.count]));
    return out;
  }

  return { loadCatalog, match, entry, byTitle, nameOf, resolve, cached, peek, reset, accountUnlocks, get catalog() { return catalog || []; } };
})();
