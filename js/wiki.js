// Zugriff auf das offizielle Guild Wars 2 Wiki (MediaWiki-API mit CORS über origin=*).
const Wiki = (() => {
  const BASES = { en: 'https://wiki.guildwars2.com', de: 'https://wiki-de.guildwars2.com' };
  const SUFFIX = {
    en: { Achievement: 'achievement', Item: 'item', Mount: 'mount' },
    de: { Achievement: 'Erfolg', Item: 'Gegenstand', Mount: 'Reittier' },
  };
  const ACQ_RE = /acquisition|obtain|location|sold by|vendor|recipe|erwerb|fundort|händler|herstellung|rezept/i;

  const base = (lang) => BASES[lang] || BASES.en;
  const pageUrl = (lang, title) => `${base(lang)}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const searchUrl = (lang, q) => `${base(lang)}/index.php?search=${encodeURIComponent(q)}`;

  async function api(lang, params) {
    const url = new URL(base(lang) + '/api.php');
    const all = { format: 'json', formatversion: '2', origin: '*', ...params };
    for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Wiki responded with HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.info || 'Wiki error');
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

  async function findByName(lang, name, context, search = true) {
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
    if (!search) return null;
    const s = await api(lang, { action: 'query', list: 'search', srsearch: name, srlimit: 1 });
    return s.query?.search?.[0]?.title || null;
  }

  // Reihenfolge: eigene Seite mit genau diesem Namen, dann Spiel-ID (oft eine Kategorieseite,
  // auf der der Erfolg nur ein Abschnitt ist), zuletzt Volltextsuche.
  // preferId: Spiel-ID zuerst (Items: gleichnamige Seiten sind oft Begriffsklärungen).
  async function findPage(lang, { id, name, context, preferId = false }) {
    if (preferId && id != null) {
      const byId = await findByGameId(lang, id, context);
      if (byId) return byId;
    }
    return (await findByName(lang, name, context, false))
      || (!preferId && id != null && (await findByGameId(lang, id, context)))
      || (await findByName(lang, name, context));
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
          if (href.startsWith('/') && !href.startsWith('//')) el.setAttribute('href', b + href);
          else if (/^\s*javascript:/i.test(href)) el.removeAttribute('href');
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener');
          // Interne Wiki-Links innerhalb der App öffnen, Bild-Links in der Großansicht.
          const m = (el.getAttribute('href') || '').match(/^https?:\/\/[^/]*guildwars2\.com\/wiki\/([^?]+)$/);
          if (m && !el.classList.contains('new')) {
            const title = decodeURIComponent(m[1]).replace(/_/g, ' ');
            if (/^(File|Datei|Image|Bild):/i.test(title)) el.dataset.file = title;
            else if (!/^(Special|Spezial|Category|Kategorie|Template|Vorlage|User|Benutzer):/i.test(title)) {
              el.dataset.wiki = title;
              el.dataset.wikiLang = lang;
            }
          }
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
    markChatLinks(root);
    return root.querySelector('.mw-parser-output') || root;
  }

  // Chat-Codes wie [&BDAEAAA=] (Wegmarken, Sehenswürdigkeiten, Items) in Kopier-Knöpfe umwandeln.
  const CHAT_RE = /\[&[A-Za-z0-9+/]{4,}={0,2}\]/g;
  function chatButton(doc, code) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'chatlink';
    btn.dataset.code = code;
    btn.title = 'Copy and paste into the in-game chat';
    btn.textContent = code;
    return btn;
  }
  // Spiel-Links des Wikis (<span class="gamelink" data-type="map" data-id="4044">, erst per Skript gefüllt)
  // selbst in Chat-Codes umrechnen: Kartenpunkt = 0x04 + ID (4 Byte), Gegenstand = 0x02 + Anzahl + ID (3 Byte) + 0
  function gameLinkCode(type, id) {
    if (!(id > 0)) return null;
    const le = (n, len) => Array.from({ length: len }, (_, i) => (n >>> (8 * i)) & 0xff);
    const bytes = type === 'map' ? [4, ...le(id, 4)] : type === 'item' ? [2, 1, ...le(id, 3), 0] : null;
    return bytes ? `[&${btoa(String.fromCharCode(...bytes))}]` : null;
  }

  function markChatLinks(root) {
    const doc = root.ownerDocument;
    root.querySelectorAll('span.gamelink[data-type][data-id]').forEach((sp) => {
      const code = gameLinkCode(sp.dataset.type, +sp.dataset.id);
      if (!code) return;
      const btn = chatButton(doc, code);
      // Art und Name aus Symbol und Link davor („Waypoint (map icon)“ + „Hullgarden Pier Waypoint“)
      let name = '';
      let kind = '';
      for (let n = sp.previousElementSibling, k = 0; n && k < 4; n = n.previousElementSibling, k++) {
        if (!name && n.tagName === 'A' && !n.querySelector('img')) name = n.textContent.trim();
        const alt = n.querySelector?.('img')?.getAttribute('alt') || n.getAttribute?.('alt') || '';
        if (alt) {
          kind = /waypoint/i.test(alt) ? 'waypoint' : /point of interest|landmark/i.test(alt) ? 'landmark' : /vista/i.test(alt) ? 'vista' : '';
          break;
        }
      }
      if (kind) { btn.classList.add(`k-${kind}`); btn.dataset.kind = kind; }
      if (name) btn.dataset.name = name;
      sp.replaceWith(btn);
    });
    root.querySelectorAll('input').forEach((inp) => {
      const v = (inp.getAttribute('value') || '').trim();
      if (/^\[&[A-Za-z0-9+/]+=*\]$/.test(v)) inp.replaceWith(chatButton(doc, v));
      else inp.remove();
    });
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      CHAT_RE.lastIndex = 0;
      if (CHAT_RE.test(n.nodeValue) && !n.parentElement.closest('button')) hits.push(n);
    }
    for (const n of hits) {
      const frag = doc.createDocumentFragment();
      let last = 0;
      n.nodeValue.replace(CHAT_RE, (code, idx) => {
        frag.append(n.nodeValue.slice(last, idx), chatButton(doc, code));
        last = idx + code.length;
      });
      frag.append(n.nodeValue.slice(last));
      n.replaceWith(frag);
    }
  }

  // Aus einer Vorschaugrafik (…/images/thumb/a/ab/X.jpg/300px-X.jpg) das Originalbild ableiten.
  function fullImageUrl(src) {
    const m = src.match(/^(.*\/images)\/thumb\/(.+)\/[^/]+$/);
    return m ? `${m[1]}/${m[2]}` : src;
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

    // Beliebige Wiki-Seite laden; falls der Titel nicht existiert, per Suche auflösen.
  async function page(lang, title) {
    try {
      return await parse(lang, title);
    } catch (e) {
      const found = await findByName(lang, title, null);
      if (!found) throw e;
      return parse(lang, found);
    }
  }

  // Echte Kartensymbole aus „Category:Map icons“ (Dateinamen werden nicht fest verdrahtet,
  // sondern aus der Kategorie ausgewählt). Ergebnis: { waypoint, landmark, vista } -> Bild-URL
  async function mapIcons() {
    const pages = [];
    let cont = {};
    for (let i = 0; i < 5; i++) {
      const j = await api('en', {
        action: 'query', generator: 'categorymembers', gcmtitle: 'Category:Map icons', gcmtype: 'file',
        gcmlimit: '500', prop: 'imageinfo', iiprop: 'url', ...cont,
      });
      pages.push(...(j.query?.pages || []));
      if (!j.continue) break;
      cont = j.continue;
    }
    const files = pages.map((p) => ({ title: p.title.replace(/^File:/, ''), url: p.imageinfo?.[0]?.url })).filter((f) => f.url);
    const BAD = /undiscovered|unexplored|incomplete|contested|locked|hollow|unavailable|disabled|inactive|grey|gray|small|old|beta/i;
    const pick = (re) => files
      .filter((f) => re.test(f.title) && !BAD.test(f.title))
      .sort((a, b) => (/\(map icon\)\.png$/i.test(b.title) - /\(map icon\)\.png$/i.test(a.title)) || a.title.length - b.title.length)[0]?.url;
    return {
      waypoint: pick(/^waypoint\b/i),
      landmark: pick(/^point of interest\b/i),
      vista: pick(/^vista\b/i),
    };
  }

  // Rohinhalt einer Wiki-Seite (z. B. JSON-Daten eines Widgets)
  async function rawContent(title, lang = 'en') {
    const j = await api(lang, { action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: title });
    const rev = j.query?.pages?.[0]?.revisions?.[0];
    return rev?.slots?.main?.content ?? rev?.content ?? null;
  }

  // Semantic-MediaWiki-Abfrage (nur englisches Wiki): Ergebnis als Liste [{ title, printouts }]
  async function ask(query) {
    const j = await api('en', { action: 'ask', query });
    const res = j.query?.results || {};
    return Array.isArray(res) ? [] : Object.entries(res).map(([title, r]) => ({ title, printouts: r.printouts || {} }));
  }

  return { base, pageUrl, searchUrl, findPage, parse, page, sanitize, acquisition, fullImageUrl, mapIcons, rawContent, ask };
})();
