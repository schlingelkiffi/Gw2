// Zugriff auf das offizielle Guild Wars 2 Wiki (MediaWiki-API mit CORS über origin=*).
const Wiki = (() => {
  const BASES = { en: 'https://wiki.guildwars2.com', de: 'https://wiki-de.guildwars2.com' };
  const SUFFIX = { en: { Achievement: 'achievement', Item: 'item' }, de: { Achievement: 'Erfolg', Item: 'Gegenstand' } };
  const ACQ_RE = /acquisition|obtain|location|sold by|vendor|recipe|erwerb|fundort|händler|herstellung|rezept/i;

  const base = (lang) => BASES[lang] || BASES.en;
  const pageUrl = (lang, title) => `${base(lang)}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const searchUrl = (lang, q) => `${base(lang)}/index.php?search=${encodeURIComponent(q)}`;

  async function api(lang, params) {
    const url = new URL(base(lang) + '/api.php');
    const all = { format: 'json', formatversion: '2', origin: '*', ...params };
    for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Wiki antwortet mit HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.info || 'Wiki-Fehler');
    return j;
  }

  // Semantic MediaWiki: Seite über die Spiel-ID finden (nur englisches Wiki).
  async function findByGameId(lang, id, context) {
    if (lang !== 'en') return null;
    try {
      const j = await api('en', { action: 'ask', query: `[[Has game id::${id}]][[Has context::${context}]]|limit=5` });
      const res = j.query?.results;
      if (!res) return null;
      const titles = Array.isArray(res) ? res.map((r) => r.fulltext || Object.keys(r)[0]) : Object.keys(res);
      const t = titles.find(Boolean);
      return t ? t.split('#')[0] : null;
    } catch (e) {
      console.warn('Wiki ask', e);
      return null;
    }
  }

  async function findByName(lang, name, context) {
    if (!name) return null;
    const suffix = SUFFIX[lang]?.[context];
    const cands = suffix ? [`${name} (${suffix})`, name] : [name];
    const j = await api(lang, { action: 'query', titles: cands.join('|'), redirects: 1 });
    const q = j.query || {};
    const pages = q.pages || [];
    const resolveTitle = (t) => {
      t = (q.normalized || []).find((n) => n.from === t)?.to ?? t;
      t = (q.redirects || []).find((r) => r.from === t)?.to ?? t;
      return pages.find((p) => p.title === t && !p.missing && !p.invalid)?.title;
    };
    for (const c of cands) {
      const t = resolveTitle(c);
      if (t) return t;
    }
    const s = await api(lang, { action: 'query', list: 'search', srsearch: name, srlimit: 1 });
    return s.query?.search?.[0]?.title || null;
  }

  async function findPage(lang, { id, name, context }) {
    return (id != null && (await findByGameId(lang, id, context))) || (await findByName(lang, name, context));
  }

  async function parse(lang, title, section) {
    const params = { action: 'parse', page: title, prop: 'text|sections', redirects: 1, disableeditsection: 1, disabletoc: 1 };
    if (section != null) params.section = section;
    const j = await api(lang, params);
    return { title: j.parse.title, html: j.parse.text, sections: j.parse.sections || [] };
  }

  // Wiki-HTML entschärfen und Links/Bilder absolut machen.
  function sanitize(lang, html) {
    const b = base(lang);
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    root.querySelectorAll('script, style, link, meta, iframe, object, embed, form, noscript, .mw-editsection, .navbox, .toc, #toc, .printfooter, .catlinks')
      .forEach((el) => el.remove());
    root.querySelectorAll('*').forEach((el) => {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        if (href.startsWith('#')) {
          el.dataset.anchor = decodeURIComponent(href.slice(1));
          el.setAttribute('href', 'javascript:void(0)');
        } else {
          if (href.startsWith('/')) el.setAttribute('href', b + href);
          else if (/^\s*javascript:/i.test(href)) el.removeAttribute('href');
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener');
        }
      }
      if (el.tagName === 'IMG') {
        const src = el.getAttribute('src') || '';
        if (src.startsWith('/') && !src.startsWith('//')) el.setAttribute('src', b + src);
        const srcset = el.getAttribute('srcset');
        if (srcset) el.setAttribute('srcset', srcset.replace(/(^|,\s*)\/(?!\/)/g, `$1${b}/`));
        el.setAttribute('loading', 'lazy');
      }
    });
    return root.querySelector('.mw-parser-output') || root;
  }

  // Erwerbs-/Fundort-Abschnitt einer Item-/Skin-/Mini-Seite laden.
  async function acquisition(lang, { type, id, name }) {
    const context = type === 'Skin' ? 'Skin' : type === 'Minipet' ? 'Miniature' : 'Item';
    let title = null;
    if (type === 'Item' || type === 'Skin') title = await findByGameId(lang, id, context);
    if (!title) title = await findByName(lang, name, type === 'Item' ? 'Item' : null);
    if (!title) return null;
    const full = await parse(lang, title, 0).catch(() => null);
    const meta = await api(lang, { action: 'parse', page: title, prop: 'sections', redirects: 1 });
    const sec = (meta.parse.sections || []).find((s) => ACQ_RE.test(s.line));
    const part = sec ? await parse(lang, meta.parse.title, sec.index) : full;
    return part ? { title: meta.parse.title, sectionName: sec?.line, html: part.html } : null;
  }

  return { base, pageUrl, searchUrl, findPage, parse, sanitize, acquisition };
})();
