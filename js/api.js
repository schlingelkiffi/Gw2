// Zugriff auf die offizielle Guild Wars 2 API (https://api.guildwars2.com/v2).
const GW2 = (() => {
  const BASE = 'https://api.guildwars2.com/v2';
  const CHUNK = 200;
  const STATIC_MAX_AGE = 7 * 24 * 3600 * 1000; // Erfolgsdaten eine Woche cachen

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function get(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetch(url);
      } catch (e) {
        lastErr = e;
        await sleep(800 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`GW2 API responded with HTTP ${res.status}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error((body && body.text) || `HTTP ${res.status} for ${path}`);
        err.status = res.status;
        throw err;
      }
      return body;
    }
    throw lastErr;
  }

  // Lädt viele IDs in 200er-Blöcken mit begrenzter Parallelität.
  async function getMany(path, ids, params = {}, onProgress) {
    const unique = [...new Set(ids)];
    const chunks = [];
    for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
    const out = [];
    let done = 0;
    let next = 0;
    async function worker() {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        try {
          const part = await get(path, { ...params, ids: chunk.join(',') });
          out.push(...part);
        } catch (e) {
          // "all ids provided are invalid" -> einfach überspringen
          if (e.status !== 404) throw e;
        }
        done++;
        if (onProgress) onProgress(done, chunks.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
    return out;
  }

  // Erfolge, Kategorien und Gruppen (sprachabhängig, im IndexedDB-Cache).
  async function loadStatic(lang, { force = false, onProgress } = {}) {
    const key = `static-${lang}`;
    if (!force) {
      const cached = await DB.get(key);
      if (cached && Date.now() - cached.ts < STATIC_MAX_AGE) return cached;
    }
    onProgress?.('Loading achievement IDs…', 0);
    const ids = await get('/achievements');
    const achievements = await getMany('/achievements', ids, { lang }, (d, t) =>
      onProgress?.(`Loading achievements… (${d}/${t})`, d / t));
    onProgress?.('Loading categories…', 1);
    const [categories, groups] = await Promise.all([
      get('/achievements/categories', { ids: 'all', lang }),
      get('/achievements/groups', { ids: 'all', lang }),
    ]);
    const data = { ts: Date.now(), lang, achievements, categories, groups };
    await DB.set(key, data);
    return data;
  }

  // Namen/Icons für Items, Skins, Minis, Titel – mit Cache.
  const nameCache = {};
  async function resolve(type, ids, lang) {
    const path = { Item: '/items', Skin: '/skins', Minipet: '/minis', Title: '/titles' }[type];
    const ck = `names-${type}-${lang}`;
    if (!nameCache[ck]) nameCache[ck] = (await DB.get(ck)) || {};
    const cache = nameCache[ck];
    const missing = [...new Set(ids)].filter((id) => !(id in cache));
    if (missing.length) {
      const res = await getMany(path, missing, { lang });
      for (const r of res) cache[r.id] = { name: r.name, icon: r.icon, rarity: r.rarity, type: r.type };
      for (const id of missing) if (!(id in cache)) cache[id] = null;
      DB.set(ck, cache);
    }
    const out = {};
    for (const id of ids) out[id] = cache[id];
    return out;
  }

  const achCache = {};
  async function achievementInLang(id, lang) {
    const k = `${lang}-${id}`;
    if (!achCache[k]) achCache[k] = get('/achievements', { ids: id, lang }).then((r) => r[0]);
    return achCache[k];
  }

  return {
    get,
    getMany,
    loadStatic,
    resolve,
    achievementInLang,
    tokenInfo: (key) => get('/tokeninfo', { access_token: key }),
    account: (key) => get('/account', { access_token: key }),
    accountAchievements: (key) => get('/account/achievements', { access_token: key }),
    bank: (key) => get('/account/bank', { access_token: key }),
    materials: (key) => get('/account/materials', { access_token: key }),
    sharedInventory: (key) => get('/account/inventory', { access_token: key }),
    characters: (key) => get('/characters', { access_token: key, ids: 'all' }),
    // Handelsposten-Preise (ohne Key); gebundene Items fehlen einfach in der Antwort
    prices: (ids) => getMany('/commerce/prices', ids),
  };
})();
