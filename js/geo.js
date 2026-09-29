// Orte & Wegmarken: Kartendaten der GW2-API (/v2/continents/1/floors/1), um zu einem Ort
// (Gebiet, Sehenswürdigkeit) die nächstgelegene Wegmarke samt Chat-Code zu finden.
const Geo = (() => {
  const MAX_AGE = 30 * 24 * 3600 * 1000; // Karten ändern sich selten
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  const vals = (o) => (Array.isArray(o) ? o : Object.values(o || {}));

  let world = null; // { maps, places, waypoints }
  let loading = null;

  // Floor-Daten auf das Nötige eindampfen, damit der Cache klein bleibt.
  function reduce(floor) {
    const maps = {};
    const places = []; // Gebiete (sectors) und Sehenswürdigkeiten (landmarks, vistas …)
    const waypoints = [];
    for (const region of vals(floor.regions)) {
      for (const m of vals(region.maps)) {
        maps[m.id] = { id: m.id, name: m.name, region: region.name };
        for (const s of vals(m.sectors)) {
          if (s.name) places.push({ kind: 'area', name: s.name, map: m.id, coord: s.coord });
        }
        for (const p of vals(m.points_of_interest)) {
          if (!p.name) continue;
          if (p.type === 'waypoint') waypoints.push({ name: p.name, map: m.id, coord: p.coord, chat: p.chat_link });
          else places.push({ kind: p.type, name: p.name, map: m.id, coord: p.coord, chat: p.chat_link });
        }
      }
    }
    return { maps, places, waypoints };
  }

  function load(lang) {
    if (world) return Promise.resolve(world);
    if (loading) return loading;
    loading = (async () => {
      const key = `world-${lang}`;
      const cached = await DB.get(key);
      if (cached && Date.now() - cached.ts < MAX_AGE) {
        world = cached.data;
      } else {
        const floor = await GW2.get('/continents/1/floors/1', { lang });
        world = reduce(floor);
        DB.set(key, { ts: Date.now(), data: world });
      }
      // Namensindex: Wegmarken selbst, Sehenswürdigkeiten und Gebiete
      world.byName = new Map();
      for (const w of world.waypoints) world.byName.set(norm(w.name), { kind: 'waypoint', ...w });
      for (const p of world.places) if (!world.byName.has(norm(p.name))) world.byName.set(norm(p.name), p);
      return world;
    })();
    loading.catch(() => { loading = null; });
    return loading;
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // Ort anhand des Namens finden (z. B. „Ossencrest Climb“ oder „Ministers Waypoint“).
  function locate(name) {
    if (!world || !name) return null;
    return world.byName.get(norm(name)) || world.byName.get(norm(name.replace(/\s*\(.*\)$/, ''))) || null;
  }

  // Nächste Wegmarke auf derselben Karte.
  function nearestWaypoint(place) {
    if (!world || !place?.coord) return null;
    if (place.kind === 'waypoint') return place;
    let best = null;
    for (const w of world.waypoints) {
      if (w.map !== place.map || !w.coord) continue;
      const d = dist(w.coord, place.coord);
      if (!best || d < best.d) best = { ...w, d };
    }
    return best;
  }

  const mapName = (id) => world?.maps[id]?.name || '';
  // Ganze Karten (z. B. „Amnytas“) sind als Ziel zu grob
  const isMap = (name) => !!world && Object.values(world.maps).some((m) => norm(m.name) === norm(name));

  return { load, locate, nearestWaypoint, mapName, isMap, get ready() { return !!world; } };
})();
