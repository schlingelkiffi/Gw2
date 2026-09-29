// Event-Timer (Weltbosse und Meta-Events aller Erweiterungen).
// Quellen, in dieser Reihenfolge:
//   1. offizielle Wiki-Daten „Widget:Event timer/data.json“ (Grundlage von /wiki et im Spiel)
//   2. github.com/giovazz89/gw2-api-event-timers (gleiches Format, wird nur zur Laufzeit geladen)
//   3. eingebauter Weltboss-Plan (nur Core Tyria) als letzte Rückfallstufe
// Zeitplan-Format: ab 00:00 UTC läuft „partial“ einmal, danach wiederholt sich „pattern“ bis Tagesende;
// jedes Element { r: Segment-ID, d: Dauer in Minuten }.
const Timers = (() => {
  const GITHUB = 'https://raw.githubusercontent.com/giovazz89/gw2-api-event-timers/main/events.json';
  const MAX_AGE = 24 * 3600 * 1000;
  const DAY = 1440;

  // ---- eingebauter Rückfall-Plan (Core Tyria) ----
  const every = (step, off) => { const o = []; for (let m = off; m < DAY; m += step) o.push(m); return o; };
  const at = (...t) => t.map((x) => { const [h, m] = x.split(':').map(Number); return h * 60 + m; });
  const FALLBACK = [
    { name: 'Tequatl the Sunless', map: 'Sparkfly Fen', re: /tequatl/i, times: at('00:00', '03:00', '07:00', '11:30', '16:00', '19:00') },
    { name: 'Triple Trouble', map: 'Bloodtide Coast', re: /triple trouble|dreifacher ärger|wurmicid|evolved jungle wurm|(amber|cobalt|crimson) (great jungle )?wurm/i, times: at('01:00', '04:00', '08:00', '12:30', '17:00', '20:00') },
    { name: 'Karka Queen', map: 'Southsun Cove', re: /karka queen|karka-königin/i, times: at('02:00', '06:00', '10:30', '15:00', '18:00', '23:00') },
    { name: 'The Shatterer', map: 'Blazeridge Steppes', re: /shatterer|zerschmetterer/i, times: every(180, 60) },
    { name: 'Claw of Jormag', map: 'Frostgorge Sound', re: /claw of jormag|klaue jormags/i, times: every(180, 150) },
    { name: 'Megadestroyer', map: 'Mount Maelstrom', re: /megadestroyer|megazerstörer/i, times: every(180, 30) },
    { name: 'Modniir Ulgoth', map: 'Harathi Hinterlands', re: /ulgoth/i, times: every(180, 90) },
    { name: 'Golem Mark II', map: 'Mount Maelstrom', re: /golem mark ii/i, times: every(180, 120) },
    { name: 'Admiral Taidha Covington', map: 'Bloodtide Coast', re: /taidha/i, times: every(180, 0) },
    { name: 'Svanir Shaman Chief', map: 'Wayfarer Foothills', re: /svanir shaman|frozen maw/i, times: every(120, 15) },
    { name: 'Fire Elemental', map: 'Metrica Province', re: /fire elemental|feuerelementar/i, times: every(120, 45) },
    { name: 'Great Jungle Wurm', map: 'Caledon Forest', re: /great jungle wurm|jungle wurm|dschungelwurm|don't feed the beast/i, times: every(120, 75) },
    { name: 'Shadow Behemoth', map: 'Queensdale', re: /shadow behemoth|schatten-behemoth/i, times: every(120, 105) },
  ];
  // Rückfall-Plan im selben Format wie die Wiki-Daten
  function fallbackSections() {
    return FALLBACK.map((ev) => {
      const pattern = [];
      let t = 0;
      for (const m of ev.times) { if (m > t) pattern.push({ r: 0, d: m - t }); pattern.push({ r: 1, d: 15 }); t = m + 15; }
      return { category: 'Core Tyria', name: ev.name, map: ev.map, segments: [{ id: 1, name: ev.name }], partial: pattern, pattern: [], fallbackRe: ev.re };
    });
  }

  let sections = null;   // normalisierte Abschnitte
  let source = 'builtin';
  let byAch = new Map(); // Erfolgs-ID -> { section, seg }
  let loading = null;

  // Verschiedene Hüllen tolerieren (Array oder { events/sections/data: [...] }), Segmente als Array oder Objekt
  function normalize(raw) {
    const list = Array.isArray(raw) ? raw : (raw?.events || raw?.sections || raw?.data || null);
    if (!Array.isArray(list)) throw new Error('unknown format');
    const out = [];
    for (const e of list) {
      if (e.active === false || !e.sequences) continue;
      const segs = (Array.isArray(e.segments) ? e.segments : Object.entries(e.segments || {}).map(([id, s]) => ({ id: +id, ...s })))
        .filter((x) => x && x.name);
      if (!segs.some((x) => x.chatlink)) continue; // Tag/Nacht, PvP-Turniere usw. ohne Ort überspringen
      out.push({
        category: e.category || 'Other', name: e.name, link: e.link, segments: segs,
        partial: e.sequences.partial || [], pattern: e.sequences.pattern || [],
      });
    }
    if (!out.length) throw new Error('no events');
    return out;
  }

  function index() {
    byAch = new Map();
    for (const sec of sections) {
      for (const seg of sec.segments) {
        const r = seg.rewards || {};
        for (const id of r.achievements || []) if (!byAch.has(id)) byAch.set(id, { section: sec, seg });
        for (const x of r.items_for_achievements || []) if (x?.a && !byAch.has(x.a)) byAch.set(x.a, { section: sec, seg });
      }
    }
  }

  function load() {
    if (sections) return Promise.resolve(sections);
    if (loading) return loading;
    loading = (async () => {
      let cached = null;
      try { cached = JSON.parse(localStorage.getItem('timerData') || 'null'); } catch { /* ignore */ }
      if (cached && Date.now() - cached.ts < MAX_AGE) {
        try { sections = normalize(cached.raw); source = cached.source; } catch { sections = null; }
      }
      if (!sections) {
        const tries = [
          ['wiki', async () => JSON.parse(await Wiki.rawContent('Widget:Event timer/data.json'))],
          ['github', async () => (await fetch(GITHUB)).json()],
        ];
        for (const [name, get] of tries) {
          try {
            const raw = await get();
            sections = normalize(raw);
            source = name;
            try { localStorage.setItem('timerData', JSON.stringify({ ts: Date.now(), source: name, raw })); } catch { /* voll */ }
            break;
          } catch (e) { console.warn(`Timer-Quelle ${name}`, e); }
        }
      }
      if (!sections) { sections = fallbackSections(); source = 'builtin'; }
      index();
      return sections;
    })();
    return loading;
  }

  // Alle Vorkommen eines Abschnitts von gestern bis morgen (jeder Tag beginnt um 00:00 UTC neu)
  function occurrences(sec, now = new Date()) {
    const out = [];
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const segById = new Map(sec.segments.map((s) => [s.id, s]));
    for (const dayOff of [-1, 0, 1]) {
      const base = today + dayOff * DAY * 60000;
      let t = 0;
      const push = (x) => {
        const seg = segById.get(x.r);
        if (seg && t < DAY) out.push({ seg, start: new Date(base + t * 60000), end: new Date(base + Math.min(t + x.d, DAY) * 60000) });
        t += x.d;
      };
      for (const x of sec.partial) push(x);
      let guard = 0;
      while (t < DAY && sec.pattern.length && guard++ < 500) for (const x of sec.pattern) push(x);
    }
    return out;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const fmtIn = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${pad(min % 60)}m` : `${min} min`);
  const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Pro Segmentname: läuft gerade (mit Restzeit) oder nächster Start
  function status(sec, now = new Date()) {
    const occ = occurrences(sec, now);
    const byName = new Map();
    for (const o of occ) {
      if (o.end <= now) continue;
      const cur = byName.get(o.seg.name);
      if (!cur || o.start < cur.start) byName.set(o.seg.name, o);
    }
    return [...byName.values()].map((o) => {
      const running = o.start <= now;
      const nextStart = running ? occ.find((x) => x.seg.name === o.seg.name && x.start > o.end) : null;
      const label = running
        ? `running now · ${fmtIn(Math.round((o.end - now) / 60000))} left${nextStart ? ` · next at ${clock(nextStart.start)}` : ''}`
        : `next at ${clock(o.start)} (in ${fmtIn(Math.round((o.start - now) / 60000))})`;
      return { seg: o.seg, start: o.start, end: o.end, running, label };
    }).sort((x, y) => (y.running - x.running) || (x.start - y.start));
  }

  // Passendes Event zu einem Erfolg: erst über die Erfolgs-IDs der Daten, sonst über Namensmuster
  function forAchievement(a, cat) {
    if (!sections) return null;
    const hit = byAch.get(a.id);
    let sec = hit?.section, segName = hit?.seg.name;
    if (!sec) {
      const hay = `${cat?.name || ''} ${a.name} ${String(a.requirement || '').replace(/<[^>]*>/g, '')}`;
      const fb = FALLBACK.find((e) => e.re.test(hay));
      if (!fb) return null;
      for (const s of sections) {
        const seg = s.segments.find((x) => x.name.toLowerCase() === fb.name.toLowerCase() || fb.re.test(x.name));
        if (seg) { sec = s; segName = seg.name; break; }
      }
      if (!sec) return null;
    }
    const st = status(sec).find((x) => x.seg.name === segName) || status(sec)[0];
    if (!st) return null;
    return { section: sec, seg: st.seg, running: st.running, label: `${st.seg.name} – ${st.label}`, map: sec.map || sec.name, chat: st.seg.chatlink };
  }

  return { load, status, forAchievement, get sections() { return sections || []; }, get source() { return source; } };
})();
