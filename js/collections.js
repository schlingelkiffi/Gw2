// Sammlungen: Reittiere, legendäre Gegenstände/Rüstungssets und alles, was ein Erfolg als Belohnung gibt –
// jeweils mit den Erfolgen auf dem Weg dorthin.
// Der Katalog kommt aus der API (/v2/mounts, /v2/legendaryarmory, Erfolgs-Belohnungen). Welche Erfolge zu einem
// Reittier oder einer Legendären gehören, steht auf der Wiki-Seite: verlinkte Erfolgskategorien und Erfolge sowie
// Bauteile (z. B. „Gift of the Hylek“), die ein Erfolg als Belohnung gibt. Dazu kommen die Voraussetzungen aus der API.
const Collections = (() => {
  const VERSION = 2;
  const MAX_AGE = 7 * 24 * 3600 * 1000;
  const PAGE_BUDGET = 16; // höchstens so viele Bauteil-Seiten pro Sammlung nachladen
  const MAX_REWARDERS = 3; // Items, die mehr Erfolge geben, sind allgemeine Belohnungen (Truhen, Materialien)
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const catIds = (c) => (c?.achievements || []).map((e) => (typeof e === 'object' ? e.id : e));
  const periodic = (a) => (a.flags || []).some((f) => ['Daily', 'Weekly', 'Monthly', 'Repeatable'].includes(f));

  // Wiki-Abschnitte, deren Links die Erfolge liefern bzw. die nichts damit zu tun haben
  const ACQ = /acquisition|obtain|unlock|getting|crafting|recipe|collection|achievement|walkthrough|erwerb|freischalt|herstellung|rezept|sammlung|erfolg/i;
  const SKIP = /used in|gallery|trivia|notes|see also|external|version|patch|related (items|skins)|skins|dyes|verwendung|galerie|wissenswertes|anmerkung|siehe auch|färb/i;
  const GIFT = /^(gift|geschenk|gabe|don)\b/i;
  const KIND_WORDS = {
    mount: /^(mounts?|reittiere?|montures?|monturas?)$/,
    legendary: /^(legendar(y|ies)?|legys?|leggys?|legies|legendar[ea]?|legendaires?|legendari[oa]s?)$/,
  };
  const KIND_ORDER = { mount: 0, legendary: 1, set: 1, reward: 2, title: 3 };

  // ---------- Katalog: Reittiere, Legendäre, Rüstungssets ----------
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
  function namesByLang(langs, lists) {
    const out = new Map();
    lists.forEach((list, i) => (list || []).forEach((x) => {
      const n = out.get(x.id) || {};
      n[langs[i]] = x.name;
      out.set(x.id, n);
    }));
    return out;
  }

  // Gemeinsamer Namensanfang der Teile eines Sets („Perfected Envoy Helmet/Mask/Cowl“ -> „Perfected Envoy“)
  function commonPrefix(names) {
    if (!names.length) return '';
    let p = names[0];
    for (const n of names) while (p && !n.startsWith(p)) p = p.slice(0, -1);
    if (names.some((n) => n.length > p.length && /[\p{L}\p{N}]/u.test(n[p.length]) && /[\p{L}\p{N}]$/u.test(p))) p = p.replace(/[\p{L}\p{N}'’]+$/u, '');
    return p.replace(/[\s\-–:'’]+$/u, '').trim();
  }

  // Legendäre Rüstung: Teile nach Set gruppieren (englischer Name ohne letztes Wort)
  function groupArmor(items, names, langs) {
    const sets = new Map();
    for (const it of items) {
      if (it.type !== 'Armor') continue;
      const en = names.get(it.id)?.en || it.name;
      const k = norm(en.split(' ').slice(0, -1).join(' '));
      if (!k) continue;
      (sets.get(k) || sets.set(k, []).get(k)).push(it);
    }
    const out = [];
    for (const [k, list] of sets) {
      if (list.length < 2) continue;
      const setNames = {};
      for (const lang of langs) setNames[lang] = commonPrefix(list.map((it) => names.get(it.id)?.[lang] || it.name)) || list[0].name;
      const pieces = list.map((it) => ({ id: it.id, weight: it.details?.weight_class || 'Other', slot: it.details?.type || '', names: names.get(it.id), icon: it.icon }));
      out.push({ key: `set:${k.replace(/[^a-z0-9]+/g, '-')}`, kind: 'set', names: setNames, icon: list[0].icon, sub: 'Legendary armor set', pieces });
    }
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
      const sets = groupArmor(lists[0], names, langs);
      const inSet = new Set(sets.flatMap((s) => s.pieces.map((p) => p.id)));
      entries.push(...sets);
      for (const it of lists[0]) {
        if (inSet.has(it.id)) continue; // Rüstungsteile stecken im Set
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

  // ---------- Katalog: alles, was ein Erfolg als Belohnung gibt (Items, Titel) ----------
  let rewardEntries = [];
  let rewardKey = '';
  let loadingRewards = null;

  // Belohnungen der einmaligen Erfolge: Item-/Titel-ID -> Erfolge
  function rewardMaps(ach) {
    const items = new Map();
    const titles = new Map();
    for (const a of ach.values()) {
      if (periodic(a)) continue;
      for (const r of a.rewards || []) {
        const m = r.type === 'Item' ? items : r.type === 'Title' ? titles : null;
        if (m) (m.get(r.id) || m.set(r.id, []).get(r.id)).push(a.id);
      }
    }
    return { items, titles };
  }

  function loadRewards(ctx, langs) {
    langs = [...new Set(langs)];
    const key = langs.join(',');
    if (rewardKey === key) return Promise.resolve(rewardEntries);
    if (loadingRewards?.key === key) return loadingRewards.promise;
    const promise = (async () => {
      const { items, titles } = rewardMaps(ctx.ach);
      const itemIds = [...items].filter(([, achs]) => achs.length <= MAX_REWARDERS).map(([id]) => id);
      const titleIds = [...titles.keys()];
      const [itemNames, titleNames] = await Promise.all([
        Promise.all(langs.map((l) => GW2.resolve('Item', itemIds, l).catch(() => ({})))),
        Promise.all(langs.map((l) => GW2.resolve('Title', titleIds, l).catch(() => ({})))),
      ]);
      const out = [];
      const namesOf = (perLang, id) => {
        const n = {};
        langs.forEach((l, i) => { if (perLang[i][id]?.name) n[l] = perLang[i][id].name; });
        return n;
      };
      for (const id of itemIds) {
        const it = itemNames[0][id];
        if (!it?.name || it.type === 'CraftingMaterial') continue;
        const achIds = items.get(id);
        out.push({ key: `item:${id}`, kind: 'reward', itemId: id, names: namesOf(itemNames, id), icon: it.icon, rarity: it.rarity,
          sub: `Reward from ${achIds.length === 1 ? 'an achievement' : `${achIds.length} achievements`}`, achIds });
      }
      for (const id of titleIds) {
        const names = namesOf(titleNames, id);
        if (!Object.keys(names).length) continue;
        const achIds = titles.get(id);
        const icon = ctx.ach.get(achIds[0])?.icon || ctx.catOf.get(achIds[0])?.icon || null;
        out.push({ key: `title:${id}`, kind: 'title', titleId: id, names, icon,
          sub: `Title from ${achIds.length === 1 ? 'an achievement' : `${achIds.length} achievements`}`, achIds });
      }
      rewardEntries = out;
      rewardKey = key;
      return out;
    })();
    loadingRewards = { key, promise };
    promise.catch(() => { loadingRewards = null; });
    return promise;
  }

  const nameOf = (e, lang) => e.names?.[lang] || e.names?.en || Object.values(e.names || {})[0] || e.key;
  // Katalog vor Belohnungen (gleiche Item-ID: der Legendären-Eintrag gewinnt)
  const entry = (key) => catalog?.find((e) => e.key === key) || rewardEntries.find((e) => e.key === key) || null;

  // Suchtreffer: ganzer Name, Namensanfang oder Wortanfang; „legendary“/„mount“ zeigt alle dieser Art
  function match(q) {
    const nq = norm(q);
    if (nq.length < 3) return [];
    const all = [...(catalog || [])];
    const seen = new Set(all.map((e) => e.key));
    for (const e of all) for (const piece of e.pieces || []) seen.add(`item:${piece.id}`); // Rüstungsteile stecken im Set
    for (const e of rewardEntries) if (!seen.has(e.key)) all.push(e);
    if (KIND_WORDS.mount.test(nq)) return all.filter((e) => e.kind === 'mount');
    if (KIND_WORDS.legendary.test(nq)) return all.filter((e) => e.kind === 'legendary' || e.kind === 'set');
    const hits = [];
    for (const e of all) {
      let best = -1;
      for (const n of Object.values(e.names || {})) {
        const nn = norm(n);
        best = Math.max(best, nn === nq ? 3 : nn.startsWith(nq) ? 2 : nn.includes(` ${nq}`) ? 1 : -1);
      }
      if (best >= 0) hits.push([best, e]);
    }
    hits.sort((x, y) => y[0] - x[0] || KIND_ORDER[x[1].kind] - KIND_ORDER[y[1].kind] || nameOf(x[1], 'en').localeCompare(nameOf(y[1], 'en')));
    return hits.map((h) => h[1]);
  }

  // Katalog-Eintrag zu einem Wiki-Titel („Skyscale“, „Endless Summer (item)“)
  function byTitle(title) {
    const t = norm(String(title).replace(/#.*$/, '').replace(/\s*\([^)]*\)\s*$/, ''));
    return catalog?.find((e) => e.kind !== 'set' && Object.values(e.names || {}).some((n) => norm(n) === t)) || null;
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

  // Belohnungs-Items in der Wiki-Sprache: Name -> { itemId, achIds }
  const rewardIdx = new Map();
  function rewardsFor(ctx) {
    const lang = ctx.wikiLang;
    if (!rewardIdx.has(lang)) {
      const promise = (async () => {
        const { items } = rewardMaps(ctx.ach);
        const names = await GW2.resolve('Item', [...items.keys()], lang).catch(() => ({}));
        const byName = new Map();
        for (const [id, achs] of items) {
          const n = names[id]?.name;
          if (!n) continue;
          const k = norm(n);
          const prev = byName.get(k);
          byName.set(k, { itemId: prev ? prev.itemId : id, achIds: [...new Set([...(prev?.achIds || []), ...achs])] });
        }
        return { byItem: items, byName };
      })();
      rewardIdx.set(lang, promise);
      promise.catch(() => rewardIdx.delete(lang));
    }
    return rewardIdx.get(lang);
  }

  function reset() { nameIdx.clear(); rewardIdx.clear(); memo.clear(); rewardKey = ''; rewardEntries = []; }

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
      const r = rw.byName.get(k);
      if (r && r.achIds.length <= 2) return r;
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
      if (r) { ids.push(...r.achIds); continue; }
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
  // Ergebnis: Gruppen { kind: category|achievements|component|prereq, title, ids, catId?, itemId? }.
  // sequential: die Gruppen sind aufeinanderfolgende Schritte (Reittier-Sammlungen).
  async function build(entry, ctx) {
    const status = ctx.onStatus || (() => {});
    const catById = new Map(ctx.categories.map((c) => [c.id, c]));
    const groups = [];
    const placed = new Set();
    const place = (ids) => ids.filter((id) => ctx.ach.has(id) && !placed.has(id) && placed.add(id));
    const addCategory = (cat, pos) => {
      const ids = cat ? place(catIds(cat)) : [];
      if (ids.length) groups.push({ kind: 'category', title: cat.name, catId: cat.id, ids, pos });
    };
    const rewarding = (itemId) => [...ctx.ach.values()].filter((a) => !periodic(a) && (a.rewards || []).some((r) => r.type === 'Item' && r.id === itemId)).map((a) => a.id);

    const name = entry.kind === 'category' ? catById.get(entry.catId)?.name : nameOf(entry, ctx.lang);
    let wikiTitle = null;
    let wikiError = null;
    let acquisition = null;
    let fromWiki = false;

    if (entry.kind === 'category') {
      addCategory(catById.get(entry.catId), 0);
    } else if (entry.kind === 'reward' || entry.kind === 'title') {
      // Belohnung: die Erfolge, die sie geben (und deren Voraussetzungen)
      const ids = place(entry.achIds || []);
      if (ids.length) groups.push({ kind: entry.kind === 'reward' ? 'component' : 'achievements', title: name, itemId: entry.itemId, ids, pos: 0 });
    } else {
      try {
        status('Reading the wiki page…');
        const wikiName = nameOf(entry, ctx.wikiLang);
        const title = entry.kind === 'set'
          ? await Wiki.findPage(ctx.wikiLang, { name: `${wikiName} ${ctx.wikiLang === 'de' ? 'Rüstung' : 'armor'}` })
          : await Wiki.findPage(ctx.wikiLang, {
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
          const ids = place(f.reward.achIds);
          if (ids.length) groups.push({ kind: 'component', title: f.t, itemId: f.reward.itemId, ids, pos: f.pos });
        }

        // Legendäre: Bauteile ohne direkten Treffer auf ihrer eigenen Seite weiterverfolgen
        if (entry.kind === 'legendary' || entry.kind === 'set') {
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

      // API: Erfolge, die den Gegenstand (bzw. ein Teil des Sets) selbst als Belohnung geben
      const own = entry.kind === 'set' ? entry.pieces.map((p) => ({ id: p.id, title: nameOf(p, ctx.lang) })) : entry.itemId ? [{ id: entry.itemId, title: name }] : [];
      own.forEach((o, i) => {
        const ids = place(rewarding(o.id));
        if (ids.length) groups.push({ kind: 'component', title: o.title, itemId: o.id, ids, pos: 9000 + i });
      });

      fromWiki = groups.length > 0;
      const nq = norm(name);
      // Legendäre: „Name I/II/III“, „Name: …“ bzw. „Legendary …: Name“ gehören zum Weg
      if (entry.kind === 'legendary' && nq.length >= 3) {
        const strict = new RegExp(`^([a-z ]+: )?${escRe(nq)}( [ivx]+)?(:.*)?$`);
        const ids = place([...ctx.ach.values()].filter((a) => ctx.catOf.has(a.id) && strict.test(norm(a.name))).map((a) => a.id));
        if (ids.length) groups.push({ kind: 'achievements', title: 'Achievements', ids, pos: 11000 });
      }
      // Nur wenn das Wiki nichts geliefert hat: Kategorien mit dem Namen (Wortanfang: „skyscale“ -> „Raising Skyscales“)
      if (!groups.length && entry.kind === 'mount' && nq.length >= 3) {
        const re = new RegExp(`(^|[^a-z0-9])${escRe(nq)}`);
        ctx.categories.filter((c) => re.test(norm(c.name)) && catIds(c).length)
          .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
          .forEach((c, i) => addCategory(c, 10000 + i));
      }
    }

    groups.sort((x, y) => x.pos - y.pos);
    // Voraussetzungen (rekursiv) in die Gruppe des Erfolgs, der sie braucht.
    // Kategorie: Vor-Erfolge aus anderen Kategorien als eigene Gruppe (zählen nicht zur Kategorie).
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
      sequential: entry.kind === 'mount' && fromWiki, // Schrittfolge nur, wenn die Reihenfolge von der Wiki-Seite stammt
      groups: groups.map(({ kind, title, catId, itemId, ids, extra, via }) => ({ kind, title, catId, itemId, ids, extra: !!extra, via: !!via })),
    };
  }

  const memo = new Map();
  const cacheKey = (entry, ctx) => `collection-${VERSION}-${entry.key}-${ctx.lang}-${ctx.wikiLang}`;
  const usesWiki = (entry) => ['mount', 'legendary', 'set'].includes(entry.kind);

  // Zwischengespeichertes Ergebnis (Sitzung oder IndexedDB), ohne neu aufzubauen
  async function cached(entry, ctx) {
    if (!usesWiki(entry)) return build(entry, ctx); // ohne Wiki: sofort aus den API-Daten
    const k = cacheKey(entry, ctx);
    if (memo.has(k)) return memo.get(k);
    const c = await DB.get(k);
    if (c && c.v === VERSION && Date.now() - c.ts < MAX_AGE) { memo.set(k, c); return c; }
    return null;
  }

  async function resolve(entry, ctx, { force = false } = {}) {
    if (!usesWiki(entry)) return build(entry, ctx);
    if (!force) {
      const c = await cached(entry, ctx);
      if (c) return c;
    }
    const res = await build(entry, ctx);
    memo.set(cacheKey(entry, ctx), res);
    if (!res.wikiError) DB.set(cacheKey(entry, ctx), res); // ohne Wiki nur für diese Sitzung
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

  return {
    loadCatalog, loadRewards, match, entry, byTitle, nameOf, resolve, cached, reset, accountUnlocks,
    get catalog() { return catalog || []; },
  };
})();
