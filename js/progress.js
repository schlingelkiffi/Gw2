// Berechnet AP, Fortschritt und "Leichtigkeit" eines Erfolgs aus API-Daten.
const Progress = (() => {
  const PERIODIC = ['Daily', 'Weekly', 'Monthly'];

  function info(a, p) {
    const tiers = [...(a.tiers || [])].sort((x, y) => x.count - y.count);
    const flags = a.flags || [];
    const repeatable = flags.includes('Repeatable');
    const perCycle = tiers.reduce((s, t) => s + t.points, 0);
    const maxCount = tiers.length ? tiers[tiers.length - 1].count : 0;
    const current = p?.current ?? 0;
    const done = !!p?.done;
    const finished = done && !repeatable;

    let tierPts = 0;
    for (const t of tiers) if (finished || current >= t.count) tierPts += t.points;

    let earned = tierPts;
    let possible = perCycle;
    if (repeatable) {
      earned = (p?.repeated || 0) * perCycle + tierPts;
      const cap = a.point_cap != null && a.point_cap >= 0 ? a.point_cap : Infinity;
      possible = cap;
      earned = Math.min(earned, cap);
    }
    const remainingAP = repeatable
      ? Math.max(0, Math.min(perCycle - tierPts, possible - earned))
      : Math.max(0, possible - earned);

    // Nächste Stufe
    let next = null;
    if (!finished && remainingAP > 0) {
      let prev = 0;
      for (const t of tiers) {
        if (t.count > current) {
          const pts = repeatable ? Math.min(t.points, possible - earned) : t.points;
          next = {
            count: t.count,
            points: pts,
            steps: t.count - current,
            frac: t.count > prev ? (current - prev) / (t.count - prev) : 0,
          };
          break;
        }
        prev = t.count;
      }
    }

    const bitsDone = new Set(p?.bits || []);
    const frac = finished ? 1 : maxCount ? Math.min(current / maxCount, 1) : 0;
    const periodic = flags.some((f) => PERIODIC.includes(f));
    const needsUnlock = flags.includes('RequiresUnlock') && !(p && p.unlocked !== false);

    let ease = 0;
    if (next && next.points > 0) {
      ease = (next.points / Math.sqrt(next.steps)) * (0.5 + next.frac);
    }

    return {
      tiers, repeatable, perCycle, maxCount, current, done, finished, earned, possible,
      remainingAP, next, bitsDone, frac, periodic, needsUnlock, ease,
    };
  }

  return { info };
})();
