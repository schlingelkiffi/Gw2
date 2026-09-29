// Weltboss-Zeitplan (UTC, wiederholt sich täglich). Zeiten ohne Gewähr – im Tool wird immer auf die
// offizielle Seite „Event timers“ im Wiki verlinkt. Tequatl ist per Recherche bestätigt.
const Timers = (() => {
  const every = (stepMin, offsetMin) => {
    const out = [];
    for (let m = offsetMin; m < 1440; m += stepMin) out.push(m);
    return out;
  };
  const at = (...hhmm) => hhmm.map((t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });

  // Reihenfolge ist wichtig: spezifische Muster (Dreifacher Ärger) vor allgemeinen (Dschungelwurm)
  const EVENTS = [
    { name: 'Tequatl the Sunless', map: 'Sparkfly Fen', re: /tequatl/i, times: at('00:00', '03:00', '07:00', '11:30', '16:00', '19:00') },
    { name: 'Triple Trouble', map: 'Bloodtide Coast', re: /triple trouble|dreifacher ärger|wurmicid|(amber|cobalt|crimson) (great jungle )?wurm/i, times: at('01:00', '04:00', '08:00', '12:30', '17:00', '20:00') },
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

  const pad = (n) => String(n).padStart(2, '0');
  const fmtIn = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${pad(min % 60)}m` : `${min} min`);

  // Nächster Start (oder „läuft gerade“, bis 15 min nach Start)
  function next(ev, now = new Date()) {
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const running = ev.times.find((t) => nowMin >= t && nowMin - t < 15);
    const upcoming = ev.times.find((t) => t > nowMin);
    const startMin = upcoming ?? ev.times[0] + 1440;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + startMin * 60000);
    const local = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const inMin = Math.round((start - now) / 60000);
    const label = running !== undefined
      ? `${ev.name} is running now (started ${nowMin - running} min ago) · next at ${local}`
      : `${ev.name} – next at ${local} (in ${fmtIn(inMin)})`;
    return { ev, start, label, running: running !== undefined };
  }

  // Passendes Event zu einem Erfolg (Name, Anforderung, Kategorie)
  function forAchievement(a, cat) {
    const hay = `${cat?.name || ''} ${a.name} ${String(a.requirement || '').replace(/<[^>]*>/g, '')}`;
    const ev = EVENTS.find((e) => e.re.test(hay));
    return ev ? next(ev) : null;
  }

  return { forAchievement, next, events: EVENTS };
})();
