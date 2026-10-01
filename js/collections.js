// Sammlungen: Reittiere, legendäre Gegenstände/Rüstungssets und alles, was ein Erfolg als Belohnung gibt –
// jeweils mit den Erfolgen auf dem Weg dorthin.
// Der Katalog kommt aus der API (/v2/mounts, /v2/legendaryarmory, Erfolgs-Belohnungen). Welche Erfolge zu einem
// Reittier oder einer Legendären gehören, steht auf der Wiki-Seite: verlinkte Erfolgskategorien und Erfolge sowie
// Bauteile (z. B. „Gift of the Hylek“), die ein Erfolg als Belohnung gibt. Dazu kommen die Voraussetzungen aus der API.
const Collections = (() => {
  const VERSION = 9;
  const MAX_AGE = 7 * 24 * 3600 * 1000;
  const MAX_REWARDERS = 3; // Items, die mehr Erfolge geben, sind allgemeine Belohnungen (Truhen, Materialien)
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const catIds = (c) => (c?.achievements || []).map((e) => (typeof e === 'object' ? e.id : e));
  const periodic = (a) => (a.flags || []).some((f) => ['Daily', 'Weekly', 'Monthly', 'Repeatable'].includes(f));

  // Wiki-Abschnitte, deren Links die Erfolge liefern bzw. die nichts damit zu tun haben
  const ACQ = /acquisition|obtain|unlock|getting|crafting|recipe|collection|achievement|walkthrough|erwerb|freischalt|herstellung|rezept|sammlung|erfolg/i;
  const SKIP = /used in|gallery|trivia|notes|see also|external|version|patch|related|skins|dyes|verwendung|galerie|wissenswertes|anmerkung|siehe auch|verwandt|färb/i;
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
      const ALIAS = { turtle: 'Siege Turtle' }; // heißt in der API nur „Turtle“
      for (const t of lists[0]) {
        const e = { key: `mount:${t.id}`, kind: 'mount', mountId: t.id, names: names.get(t.id), icon: skinById.get(t.default_skin)?.icon || null, sub: 'Mount' };
        if (ALIAS[t.id]) { e.alias = ALIAS[t.id]; e.wiki = { en: ALIAS[t.id] }; }
        entries.push(e);
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
        if (achIds.some((aid) => norm(ctx.ach.get(aid)?.name) === norm(it.name))) continue; // Token einer Sammlung („Skyscale Care“)
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
      for (const n of [...Object.values(e.names || {}), e.alias].filter(Boolean)) {
        const nn = norm(n);
        best = Math.max(best, nn === nq ? 3 : nn.startsWith(nq) ? 2 : nn.includes(` ${nq}`) ? 1 : -1);
      }
      if (best >= 0) hits.push([best, e]);
    }
    // Ziele (Reittier, Legendäre, Set) vor einzelnen Belohnungen, dann nach Treffergüte
    const bucket = (e) => (KIND_ORDER[e.kind] < 2 ? 0 : 1);
    hits.sort((x, y) => bucket(x[1]) - bucket(y[1]) || y[0] - x[0] || KIND_ORDER[x[1].kind] - KIND_ORDER[y[1].kind] || nameOf(x[1], 'en').localeCompare(nameOf(y[1], 'en')));
    return hits.map((h) => h[1]);
  }

  // Katalog-Eintrag zu einem Wiki-Titel („Skyscale“, „Endless Summer (item)“)
  function byTitle(title) {
    const t = norm(String(title).replace(/#.*$/, '').replace(/\s*\([^)]*\)\s*$/, ''));
    return catalog?.find((e) => e.kind !== 'set' && Object.values(e.names || {}).some((n) => norm(n) === t)) || null;
  }

  // ---------- Indizes ----------
  const nameIdx = new Map(); // Sprache -> { ach: Map(Name -> ID), cat: Map(Name -> ID) }
  async function namesFor(ctx, lang = ctx.wikiLang) {
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

  function reset() { nameIdx.clear(); memo.clear(); rewardKey = ''; rewardEntries = []; }

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

  // ---------- Rezept-/Erwerbsbaum (Wiki-SMW + API) ----------
  // Pro Item: Rezept (Zutaten mit Item-ID und Menge), sonst Händler (Kosten, nötiger Erfolg/Kartenabschluss),
  // sonst Erfolgs-Belohnung. Erweitert werden nur Gifts und Items ab „Exotic“ – Grundmaterialien bleiben Blätter.
  const bound = (it) => (it?.flags || []).some((f) => f === 'AccountBound' || f === 'SoulbindOnAcquire');
  // Weiter aufschlüsseln: Gifts, aufgestiegene/legendäre Items und gebundene exotische Ausrüstung (Precursor).
  // Handelbares bleibt ein Blatt (kaufen statt Umwandlungsrezepte der Mystischen Schmiede).
  const expandable = (it) => !!it && (GIFT.test(it.name)
    || ((it.rarity === 'Ascended' || it.rarity === 'Legendary') && (bound(it) || it.type !== 'CraftingMaterial'))
    || (it.rarity === 'Exotic' && bound(it) && ['Weapon', 'Armor', 'Trinket', 'Back'].includes(it.type)));
  const MAX_ITEMS = 250;
  const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const smwVal = (x) => (x && typeof x === 'object' && 'fulltext' in x ? x.fulltext : x);
  const pv = (p, key) => (p[key] || []).map(smwVal);
  const rec = (r, key) => (r?.[key]?.item || []).map(smwVal)[0];
  const stripParen = (t) => String(t || '').replace(/\s*\([^)]*\)\s*$/, '');

  async function pool(items, n, fn) {
    const out = new Array(items.length).fill(null);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try { out[i] = await fn(items[i]); } catch (e) { console.warn('Wiki-Abfrage', e); }
      }
    }));
    return out;
  }

  // Das Wiki erlaubt höchstens ~15 Oder-Werte pro Abfrage – daher Pakete zu 12, mehrere gleichzeitig
  const SMW_CHUNK = 12;
  async function askChunks(values, build) {
    const rows = await pool(chunks(values, SMW_CHUNK), 3, (part) => Wiki.ask(build(part)));
    return rows.flatMap((r) => r || []);
  }

  async function smwRecipes(ids) {
    const out = new Map();
    const rows = await askChunks(ids, (part) => `[[Has context::Recipe]][[Has output game id::${part.join('||')}]]|?Has ingredient with id|?Has recipe source|?Has output quantity|?Has output game id|?Requires discipline|?Requires rating|limit=500`);
    rows.sort((a, b) => a.title.localeCompare(b.title));
    for (const r of rows) {
      const oid = +pv(r.printouts, 'Has output game id')[0];
      if (!oid || out.has(oid)) continue;
      const ings = (r.printouts['Has ingredient with id'] || []).map((g) => ({
        idx: +rec(g, 'Has ingredient index') || 0, qty: +rec(g, 'Has ingredient quantity') || 1,
        id: +rec(g, 'Has ingredient id') || null, name: stripParen(rec(g, 'Has ingredient name')),
      })).sort((a, b) => a.idx - b.idx);
      if (ings.some((g) => g.id === oid)) continue; // Umwandlungsrezept (braucht sich selbst) – kein sinnvoller Weg
      // Quelle: Handwerksberuf mit Stufe („Tailor 500“), sonst Mystische Schmiede bzw. „Crafting“
      const disc = pv(r.printouts, 'Requires discipline').map(stripParen).filter(Boolean);
      const rating = +pv(r.printouts, 'Requires rating')[0] || 0;
      const src = String(pv(r.printouts, 'Has recipe source')[0] || '');
      const who = disc.length > 3 ? 'Any crafting discipline' : disc.join(', ');
      const source = disc.length ? `${who}${rating ? ` ${rating}` : ''}` : /mystic forge/i.test(src) ? 'Mystic Forge' : 'Crafting';
      out.set(oid, { source, outQty: +pv(r.printouts, 'Has output quantity')[0] || 1, ings });
    }
    return out;
  }

  async function smwVendors(names) {
    const out = new Map(); // Name -> { vendor, costs: [{ name, qty }], req }
    const rows = await askChunks(names, (part) => `[[Sells item::${part.join('||')}]][[Is historical::f]]|?Sells item|?Has item cost|?Has requirement|?Has vendor|limit=500`);
    for (const r of rows) {
      const sold = norm(stripParen(pv(r.printouts, 'Sells item')[0]));
      if (!sold || out.has(sold)) continue;
      const costs = (r.printouts['Has item cost'] || [])
        .map((c) => ({ qty: +rec(c, 'Has item value') || 1, name: stripParen(rec(c, 'Has item currency')) }))
        .filter((c) => c.name);
      out.set(sold, { vendor: stripParen(pv(r.printouts, 'Has vendor')[0]), costs, req: String(pv(r.printouts, 'Has requirement')[0] || '') });
    }
    return out;
  }

  async function smwItemIds(names) {
    const out = new Map();
    const rows = await askChunks(names, (part) => `[[Has canonical name::${part.join('||')}]][[Has context::Item]]|?Has game id|?Has canonical name|limit=500`);
    for (const r of rows) {
      const id = +pv(r.printouts, 'Has game id')[0];
      const n = norm(pv(r.printouts, 'Has canonical name')[0] || stripParen(r.title));
      if (id && !out.has(n)) out.set(n, id);
    }
    return out;
  }

  async function itemTree(rootIds, ctx, status) {
    const items = {};
    const rewards = rewardMaps(ctx.ach).items;
    const enIdx = await namesFor(ctx, 'en');
    const currencies = new Map([['gold', 1], ['coin', 1]]);
    try { for (const c of await GW2.get('/currencies', { ids: 'all', lang: 'en' })) currencies.set(norm(c.name), c.id); } catch { /* ohne Währungsnamen */ }
    // Währung auch bei Einzahl/Mehrzahl erkennen („Tale of Dungeon Delving“ = „Tales of Dungeon Delving“)
    const curId = (name) => {
      const k = norm(name);
      return [k, `${k}s`, k.replace(/^(\S+)/, '$1s'), k.replace(/s$/, '')].map((x) => currencies.get(x)).find(Boolean) || null;
    };
    const ing = (name, qty, id) => {
      if (id) return { id, qty };
      const cur = curId(name);
      if (cur) return { cur, qty: norm(name) === 'gold' ? qty * 10000 : qty, name };
      return { name, qty };
    };
    let level = [...new Set(rootIds)];
    for (let depth = 0; level.length && Object.keys(items).length < MAX_ITEMS; depth++) {
      status(`Reading recipes and vendors… (level ${depth + 1})`);
      const info = new Map((await GW2.getMany('/items', level, { lang: 'en' }).catch(() => [])).map((x) => [x.id, x]));
      const last = depth >= 6;
      const expand = last ? [] : level.filter((id) => depth === 0 || expandable(info.get(id)));
      const recs = expand.length ? await smwRecipes(expand) : new Map();
      const toVendor = expand.filter((id) => !recs.has(id) && !(rewards.get(id) || []).length && info.get(id));
      const vend = toVendor.length ? await smwVendors(toVendor.map((id) => info.get(id).name)) : new Map();
      const costNames = [...new Set([...vend.values()].flatMap((v) => v.costs.map((c) => c.name)).filter((n) => !curId(n)))];
      const costIds = costNames.length ? await smwItemIds(costNames) : new Map();
      const next = [];
      for (const id of level) {
        const it = info.get(id);
        const node = { id, name: it?.name || `Item ${id}`, rarity: it?.rarity, icon: it?.icon, how: 'leaf', ings: [] };
        const achs = rewards.get(id) || [];
        // Erfolgs-Belohnung nur bei gebundenen Items – Handelbares kauft man einfacher
        if (achs.length && achs.length <= MAX_REWARDERS && (bound(it) || depth === 0)) node.achIds = achs;
        const r = recs.get(id);
        const v = vend.get(norm(it?.name || ''));
        if (r) {
          Object.assign(node, { how: 'recipe', source: r.source, outQty: r.outQty, ings: r.ings.map((g) => ing(g.name, g.qty, g.id)) });
        } else if (v) {
          Object.assign(node, { how: 'vendor', source: v.vendor, ings: v.costs.map((c) => ing(c.name, c.qty, costIds.get(norm(c.name)))) });
          const reqText = v.req.replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1').trim();
          const reqAch = enIdx.ach.get(norm(reqText.replace(/^(the )?achievement /i, '')));
          if (reqAch) node.reqAch = reqAch;
          else if (reqText) node.reqText = reqText.replace(/^character has map completed /i, 'Map completion: ');
        } else if (node.achIds) node.how = 'achievement';
        items[id] = node;
        for (const g of node.ings) if (g.id && !items[g.id]) next.push(g.id);
      }
      level = [...new Set(next)].filter((x) => !items[x]);
    }
    return items;
  }

  // Wiki-Seite des Ziels (Reittier, Legendäre, Set) laden und in Abschnitte teilen
  async function wikiPage(entry, ctx) {
    const wikiName = entry.wiki?.[ctx.wikiLang] || nameOf(entry, ctx.wikiLang);
    const title = entry.kind === 'set'
      ? await Wiki.findPage(ctx.wikiLang, { name: `${wikiName} ${ctx.wikiLang === 'de' ? 'Rüstung' : 'armor'}` })
      : await Wiki.findPage(ctx.wikiLang, {
        id: entry.itemId, name: wikiName, context: entry.kind === 'mount' ? 'Mount' : 'Item', preferId: entry.kind === 'legendary',
      });
    if (!title) throw new Error('no wiki page found');
    const page = await Wiki.parse(ctx.wikiLang, title);
    const secs = splitSections(Wiki.sanitize(ctx.wikiLang, page.html));
    return { title: page.title, secs };
  }
  const sectionHtml = (list) => list.map((s) => [s.heading, ...s.nodes].filter(Boolean).map((n) => n.outerHTML).join('')).join('');

  // ---------- Erfolge einer Sammlung bestimmen ----------
  // Ergebnis: Gruppen { kind: category|section|achievements|component|prereq, title, ids, catId?, itemId? },
  // bei Legendären zusätzlich items (Rezept-/Erwerbsbaum) und roots (Wurzel-Items).
  async function build(entry, ctx) {
    const status = ctx.onStatus || (() => {});
    const catById = new Map(ctx.categories.map((c) => [c.id, c]));
    const groups = [];
    const placed = new Set();
    const place = (ids) => ids.filter((id) => ctx.ach.has(id) && !placed.has(id) && placed.add(id));
    const name = entry.kind === 'category' ? catById.get(entry.catId)?.name : nameOf(entry, ctx.lang);
    const out = { v: VERSION, ts: Date.now(), key: entry.key, name, wikiTitle: null, wikiError: null, acquisition: null, note: null };

    if (entry.kind === 'category') {
      const cat = catById.get(entry.catId);
      const ids = place(catIds(cat));
      if (ids.length) groups.push({ kind: 'category', title: cat.name, catId: cat.id, ids });
    } else if (entry.kind === 'reward' || entry.kind === 'title') {
      // Belohnung: die Erfolge, die sie geben (und deren Voraussetzungen)
      const ids = place(entry.achIds || []);
      if (ids.length) groups.push({ kind: entry.kind === 'reward' ? 'component' : 'achievements', title: name, itemId: entry.itemId, ids });
    } else if (entry.kind === 'mount') {
      // Reittier: Erfolge aus den Listen/Tabellen der Freischalt-Abschnitte, je Unterabschnitt eine Gruppe
      // (z. B. „Living World Season 4“ / „Secrets of the Obscure“). Kategorie-Links zählen nicht – das wäre zu viel.
      try {
        status('Reading the wiki page…');
        const { title, secs } = await wikiPage(entry, ctx);
        out.wikiTitle = title;
        const acq = secs.filter((s) => isAcq(s) && !s.chain.some((t) => /historical|temporary|pop-?up/i.test(t)));
        if (acq.length) out.acquisition = sectionHtml(acq);
        const top = acq.find((s) => s.chain.length === 1);
        out.note = top?.nodes.find((n) => n.tagName === 'P' && n.textContent.trim().length > 30)?.textContent.replace(/\s+/g, ' ').trim() || null;
        const idx = await namesFor(ctx);
        const toIds = (titles) => [...new Set(titles.map((t) => titleKeys(t).map((k) => idx.ach.get(k)).find(Boolean)).filter(Boolean))];
        for (const s of acq) {
          const lists = s.nodes.flatMap((n) => (n.matches('ol, ul, table, dl') ? [n] : [...n.querySelectorAll('ol, ul, table, dl')]));
          let ids = toIds(linksIn(lists));
          if (!ids.length) ids = toIds(linksIn(s.nodes));
          ids = place(ids);
          if (ids.length) groups.push({ kind: 'section', title: s.chain[s.chain.length - 1], ids });
        }
      } catch (e) {
        out.wikiError = e.message || String(e);
        console.warn('Sammlung (Wiki)', e);
      }
    } else {
      // Legendäre / Rüstungsset: Rezept-/Erwerbsbaum
      const roots = entry.kind === 'set' ? entry.pieces.map((p) => p.id) : [entry.itemId];
      try {
        out.items = await itemTree(roots, ctx, status);
        out.roots = roots;
        for (const n of Object.values(out.items)) {
          const ids = place([...(n.achIds || []), ...(n.reqAch ? [n.reqAch] : [])]);
          if (ids.length) groups.push({ kind: 'component', title: n.name, itemId: n.id, ids });
        }
        // Sammlungen mit dem Namen der Legendären („HOPE I: Research“ … „HOPE IV: The Catalyst“): Precursor-Weg
        const nq = norm(name);
        if (entry.kind === 'legendary' && nq.length >= 3) {
          const re = new RegExp(`^([a-z' ]+: )?${escRe(nq)}( [ivx]+)?(:.*)?$`);
          const roman = (a) => ({ i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 }[(re.exec(norm(a.name))?.[2] || '').trim()] || 0);
          const ids = place([...ctx.ach.values()].filter((a) => ctx.catOf.has(a.id) && !periodic(a) && re.test(norm(a.name)))
            .sort((x, y) => roman(x) - roman(y)).map((a) => a.id));
          if (ids.length) groups.push({ kind: 'named', title: 'Collections', ids });
        }
      } catch (e) {
        console.warn('Rezeptbaum', e);
        out.treeError = e.message || String(e);
      }
      try {
        status('Reading the wiki page…');
        const { title, secs } = await wikiPage(entry, ctx);
        out.wikiTitle = title;
        const acq = secs.filter(isAcq);
        if (acq.length) out.acquisition = sectionHtml(acq);
      } catch (e) {
        out.wikiError = e.message || String(e);
      }
    }

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
    out.groups = groups.map(({ kind, title, catId, itemId, ids, extra }) => ({ kind, title, catId, itemId, ids, extra: !!extra }));
    return out;
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
